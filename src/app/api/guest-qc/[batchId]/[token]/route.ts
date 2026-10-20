import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handleDomainError } from "@/lib/api-error";
import { cleanGuestName, sameGuestName } from "@/lib/services/qc-invite";
import { extractIp } from "@/lib/rate-limit";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";

type Params = { params: Promise<{ batchId: string; token: string }> };

async function getBatch(batchId: string, token: string) {
  const batch = await prisma.roastingBatch.findUnique({
    where: { id: batchId },
    include: {
      greenBean: true,
      // F4 / review F-1: this public link reads only the line's bean name, so the order and
      // its customer are not loaded at all.
      orderItem: { select: { beanTypeName: true } },
    },
  });
  if (!batch || batch.qcToken !== token) return null;
  return batch;
}

export async function GET(_request: Request, { params }: Params) {
  const { batchId, token } = await params;
  const batch = await getBatch(batchId, token);
  if (!batch) return NextResponse.json({ error: "Invalid or expired link" }, { status: 404 });

  return NextResponse.json({
    batchNumber: batch.batchNumber,
    origin: batch.greenBean?.beanType || batch.orderItem?.beanTypeName || "",
    processing: batch.greenBean?.process || "",
    roastedKg: batch.roastedBeanQuantity,
    status: batch.status,
    isOpen: batch.status === "Pending QC",
  });
}

export async function POST(request: Request, { params }: Params) {
  const ip = extractIp(request);
  const { limited } = await checkAndRecordRateLimit({
    scope: "guest_qc_submit",
    key: ip,
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return NextResponse.json(
      { error: "Too many requests. Try again later." },
      { status: 429 }
    );
  }

  const { batchId, token } = await params;
  const batch = await getBatch(batchId, token);
  if (!batch) return NextResponse.json({ error: "Invalid or expired link" }, { status: 404 });
  if (batch.status !== "Pending QC") {
    return NextResponse.json({ error: "This batch is no longer open for QC submissions" }, { status: 409 });
  }

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { body = {}; }
  const testerName = cleanGuestName(body.testerName);
  const decision = body.decision === "Reject" ? "Reject" : body.decision === "Accept" ? "Accept" : null;
  const remarks = typeof body.remarks === "string" ? body.remarks.trim().slice(0, 1000) : "";
  const underDeveloped = body.underDeveloped === true;
  const overDeveloped = body.overDeveloped === true;

  if (!testerName) {
    return NextResponse.json({ error: "Tester name is required" }, { status: 400 });
  }
  if (!decision) {
    return NextResponse.json({ error: "decision must be Accept or Reject" }, { status: 400 });
  }
  // G25: the same rules as an internal record. A rejection carries its reason — a chip or a remark.
  if (decision === "Reject" && !underDeveloped && !overDeveloped && !remarks) {
    return NextResponse.json({ error: "Please select a rejection reason or write a remark." }, { status: 400 });
  }
  const num = (v: unknown, max: number) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : NaN;
  };
  const colorWhole = num(body.colorWhole, 200), colorGround = num(body.colorGround, 200), color = num(body.color, 200);
  if ([colorWhole, colorGround, color].some((v) => Number.isNaN(v))) {
    return NextResponse.json({ error: "Agtron readings are numbers from 0 to 200." }, { status: 400 });
  }

  try {
    const record = await prisma.$transaction(async (tx) => {
      // One evaluation per guest name and batch (as one per employee internally): under the batch
      // row lock, so a double tap cannot record the same guest twice.
      await tx.$queryRaw`SELECT "id" FROM "RoastingBatch" WHERE "id" = ${batchId} FOR UPDATE`;
      const external = await tx.qcRecord.findMany({ where: { batchId, isExternal: true }, select: { testerName: true } });
      if (external.some((r) => r.testerName && sameGuestName(r.testerName, testerName))) {
        throw { _appCode: 409, message: "This name has already submitted an evaluation for this batch." };
      }
      const created = await tx.qcRecord.create({
        data: {
          batchId,
          isExternal: true,
          testerName,
          decision,
          coffeeOrigin: batch.greenBean?.beanType || batch.orderItem?.beanTypeName || "",
          processing: batch.greenBean?.process || "",
          serialNumber: batch.batchNumber,
          onProfile: decision !== "Reject",
          underDeveloped: decision === "Reject" && underDeveloped,
          overDeveloped: decision === "Reject" && overDeveloped,
          color: color === null ? null : Math.round(color),
          colorWhole,
          colorGround,
          remarks: remarks || null,
        },
      });
      // The invite this guest answers (same name), now done: the panel stops showing them pending.
      const pending = await tx.qcInvite.findMany({ where: { batchId, status: "PENDING" }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
      const mine = pending.find((p) => sameGuestName(p.name, testerName));
      if (mine) await tx.qcInvite.update({ where: { id: mine.id }, data: { status: "DONE", qcRecordId: created.id, completedAt: new Date() } });
      return created;
    });
    return NextResponse.json({ id: record.id, decision: record.decision }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
