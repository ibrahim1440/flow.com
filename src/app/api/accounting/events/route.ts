import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

// Read-only in S0. No operational module emits AccountingEvent rows yet — this exists so the
// event log is visible once a future module starts calling emitAccountingEvent().
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;

  const events = await prisma.accountingEvent.findMany({
    orderBy: { occurredAt: "desc" },
    take: 200,
  });
  return NextResponse.json(events);
}
