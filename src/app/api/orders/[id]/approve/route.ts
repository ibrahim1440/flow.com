import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

const VALID_DECISIONS = new Set(["Yes", "No", "Pending"]);
const REASON_MAX_LENGTH = 500;

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("orders", "approve");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { decision, reason } = (body ?? {}) as { decision?: unknown; reason?: unknown };

  if (typeof decision !== "string" || !VALID_DECISIONS.has(decision)) {
    return NextResponse.json({ error: "decision must be 'Yes', 'No', or 'Pending'." }, { status: 400 });
  }

  const trimmedReason = typeof reason === "string" ? reason.trim() : "";

  if (decision === "No" && !trimmedReason) {
    return NextResponse.json({ error: "reason is required when rejecting an order." }, { status: 400 });
  }

  if (trimmedReason.length > REASON_MAX_LENGTH) {
    return NextResponse.json({ error: `reason must be at most ${REASON_MAX_LENGTH} characters.` }, { status: 400 });
  }

  try {
    const existing = await prisma.order.findUnique({
      where: { id },
      select: { id: true, notes: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Order not found." }, { status: 404 });
    }

    const data: { approvalStatus: string; approvalDate: Date | null; notes?: string } = {
      approvalStatus: decision,
      approvalDate: decision === "Pending" ? null : new Date(),
    };

    if (decision === "No") {
      const auditLine = `[Approval Rejected] ${new Date().toISOString()} by ${user.id}: ${trimmedReason}`;
      data.notes = existing.notes ? `${existing.notes}\n${auditLine}` : auditLine;
    }

    const updated = await prisma.order.update({
      where: { id },
      data,
      select: { id: true, approvalStatus: true, approvalDate: true, notes: true },
    });

    return NextResponse.json({
      id: updated.id,
      approvalStatus: updated.approvalStatus,
      approvalDate: updated.approvalDate,
      notes: updated.notes,
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}
