import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";

// Read-only skeleton in S0. No real Qoyod API integration and no export trigger route —
// nothing posts through a real business workflow yet, so there is nothing to safely export.
export async function GET() {
  const { error } = await requireSub("accounting", "export_view");
  if (error) return error;

  const records = await prisma.qoyodExportRecord.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json(records);
}
