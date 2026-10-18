import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { canSeeCustomerContact, CUSTOMER_NAME_SELECT } from "@/lib/auth/customer-detail";

export async function GET() {
  const { user, error } = await requireSub("qc", "view_records");
  if (error) return error;
  // F4 / review F-1: QC needs the customer's name, not the contact record.
  const customerContact = canSeeCustomerContact(user.permissions);

  const records = await prisma.qcRecord.findMany({
    orderBy: { date: "desc" },
    take: 500,
    include: {
      employee: { select: { id: true, name: true } },
      batch: {
        include: {
          orderItem: {
            include: {
              order: { include: { customer: customerContact ? true : { select: CUSTOMER_NAME_SELECT } } },
            },
          },
        },
      },
    },
  });
  return NextResponse.json(records);
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("qc", "create_record");
  if (error) return error;

  const body = await request.json();

  if (!body.batchId || typeof body.batchId !== "string") {
    return NextResponse.json({ error: "batchId is required" }, { status: 400 });
  }
  if (body.decision !== "Accept" && body.decision !== "Reject") {
    return NextResponse.json({ error: "decision must be 'Accept' or 'Reject'" }, { status: 400 });
  }
  const hasRejectReason =
    Boolean(body.underDeveloped) ||
    Boolean(body.overDeveloped) ||
    Boolean(body.remarks?.trim());
  if (body.decision === "Reject" && !hasRejectReason) {
    return NextResponse.json(
      { error: "Please select a rejection reason or write a remark." },
      { status: 400 }
    );
  }

  const batch = await prisma.roastingBatch.findUnique({ where: { id: body.batchId } });
  if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  if (batch.status !== "Pending QC") {
    return NextResponse.json(
      { error: "This batch has already been finalized and no longer accepts QC submissions." },
      { status: 409 }
    );
  }

  const qcData = {
    batchId:        body.batchId as string,
    coffeeOrigin:   typeof body.coffeeOrigin === "string" ? body.coffeeOrigin : "",
    processing:     typeof body.processing === "string" ? body.processing : "",
    serialNumber:   typeof body.serialNumber === "string" ? body.serialNumber : "",
    onProfile:      body.onProfile === true,
    underDeveloped: body.underDeveloped === true,
    overDeveloped:  body.overDeveloped === true,
    color:          typeof body.color === "number" ? body.color : null,
    colorWhole:     typeof body.colorWhole === "number" ? body.colorWhole : null,
    colorGround:    typeof body.colorGround === "number" ? body.colorGround : null,
    remarks:        typeof body.remarks === "string" ? body.remarks.trim() || null : null,
    decision:       body.decision as "Accept" | "Reject",
    employeeId:     user.id,
    isExternal:     false,
    testerName:     null,
  };

  const record = await prisma.qcRecord.create({
    data: qcData,
    include: { batch: true, employee: { select: { id: true, name: true } } },
  });

  return NextResponse.json(record, { status: 201 });
}
