import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { roastQueue } from "@/lib/services/roast-queue";

/**
 * GET /api/roasting-batches/queue — the roast queue grouped by coffee (Phase C item 2).
 *
 * One entry per coffee with open demand or pipeline: the roasted kilograms still to roast
 * (open order units − shelf free − pipeline), the orders it serves (oldest first) and the line a
 * new batch would be attributed to. Read-only, for the production station. Customer names only
 * — the same projection GET /api/orders gives production (no contact field).
 */
export async function GET() {
  const { error } = await requireAnyModule("production");
  if (error) return error;
  try {
    const coffees = await roastQueue(prisma);
    return NextResponse.json({ coffees });
  } catch (err) {
    return handleDomainError(err);
  }
}
