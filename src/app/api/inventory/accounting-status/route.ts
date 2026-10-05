import { NextResponse } from "next/server";
import { requireAnyModule } from "@/lib/auth-server";
import { opsStatusFor } from "@/lib/accounting/ops-integration";

// Accounting state of operational records (batches, purchases, deliveries) for the operational
// screens: status and reason only — no amounts, no ledger data.
export async function GET(request: Request) {
  const { error } = await requireAnyModule("inventory", "production", "packaging", "dispatch");
  if (error) return error;
  const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  return NextResponse.json(await opsStatusFor(ids));
}
