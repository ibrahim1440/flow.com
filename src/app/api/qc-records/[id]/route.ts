import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

const EDITABLE_FIELDS = [
  "decision", "onProfile", "underDeveloped", "overDeveloped",
  "color", "colorWhole", "colorGround", "remarks",
  "coffeeOrigin", "processing", "serialNumber",
] as const;

type EditableField = typeof EDITABLE_FIELDS[number];

function computeDiffs(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Array<{ fieldName: string; oldValue: string | null; newValue: string | null }> {
  const diffs: Array<{ fieldName: string; oldValue: string | null; newValue: string | null }> = [];
  for (const field of EDITABLE_FIELDS) {
    const oldVal = before[field] ?? null;
    const newVal = after[field] ?? null;
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diffs.push({
        fieldName: field,
        oldValue: oldVal === null ? null : JSON.stringify(oldVal),
        newValue: newVal === null ? null : JSON.stringify(newVal),
      });
    }
  }
  return diffs;
}

export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("qc", "edit_record");
  if (error) return error;

  const { id } = await params;

  const record = await prisma.qcRecord.findUnique({
    where: { id },
    include: { batch: { select: { id: true, status: true } } },
  });

  if (!record) return NextResponse.json({ error: "QC record not found." }, { status: 404 });

  if (record.batch.status !== "Pending QC") {
    return NextResponse.json(
      { error: "This QC record cannot be edited — the batch has already been finalized." },
      { status: 409 }
    );
  }

  const canManage = hasSubPrivilege(user.permissions, "qc", "manage");
  if (record.employeeId !== user.id && !canManage) {
    return NextResponse.json({ error: "You can only edit your own QC records." }, { status: 403 });
  }

  const body = await request.json();
  const {
    correctionReason,
    decision, underDeveloped, overDeveloped,
    color, colorWhole, colorGround, remarks,
    coffeeOrigin, processing, serialNumber,
  } = body;

  if (!correctionReason || !String(correctionReason).trim()) {
    return NextResponse.json({ error: "Correction reason is required." }, { status: 400 });
  }

  if (decision !== "Accept" && decision !== "Reject") {
    return NextResponse.json({ error: "decision must be 'Accept' or 'Reject'" }, { status: 400 });
  }

  const hasRejectReason =
    Boolean(underDeveloped) ||
    Boolean(overDeveloped) ||
    Boolean(remarks?.trim());
  if (decision === "Reject" && !hasRejectReason) {
    return NextResponse.json(
      { error: "Please select a rejection reason or write a remark." },
      { status: 400 }
    );
  }

  const newData: Record<EditableField, unknown> = {
    decision:       decision === "Reject" ? "Reject" : "Accept",
    onProfile:      decision !== "Reject",
    underDeveloped: underDeveloped ?? false,
    overDeveloped:  overDeveloped  ?? false,
    color:          color       ? parseInt(color)        : null,
    colorWhole:     colorWhole  ? parseFloat(colorWhole)  : null,
    colorGround:    colorGround ? parseFloat(colorGround) : null,
    remarks:        remarks?.trim() || null,
    coffeeOrigin:   typeof coffeeOrigin === "string" ? coffeeOrigin : record.coffeeOrigin,
    processing:     typeof processing   === "string" ? processing   : record.processing,
    serialNumber:   typeof serialNumber === "string" ? serialNumber : record.serialNumber,
  };

  const oldData: Record<EditableField, unknown> = {
    decision:       record.decision,
    onProfile:      record.onProfile,
    underDeveloped: record.underDeveloped,
    overDeveloped:  record.overDeveloped,
    color:          record.color,
    colorWhole:     record.colorWhole,
    colorGround:    record.colorGround,
    remarks:        record.remarks,
    coffeeOrigin:   record.coffeeOrigin,
    processing:     record.processing,
    serialNumber:   record.serialNumber,
  };

  const diffs = computeDiffs(oldData, newData);

  try {
    const [updated, correction] = await prisma.$transaction(async (tx) => {
      const hist = await tx.qcCorrectionHistory.create({
        data: {
          qcRecordId:      id,
          batchId:         record.batch.id,
          correctionReason: String(correctionReason).trim(),
          changedById:     user.id,
          changedByName:   user.name,
          ...(diffs.length > 0 && {
            fieldChanges: {
              createMany: { data: diffs },
            },
          }),
        },
      });

      const rec = await tx.qcRecord.update({
        where: { id },
        data:  newData as Parameters<typeof tx.qcRecord.update>[0]["data"],
        include: { employee: { select: { id: true, name: true } } },
      });

      return [rec, hist];
    });

    return NextResponse.json({ record: updated, correctionId: correction.id });
  } catch (err) {
    return handlePrismaError(err);
  }
}
