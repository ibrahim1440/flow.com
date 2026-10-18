import { NextResponse } from "next/server";
import { printCertificationGate, requirePrintRead } from "@/lib/print/server/auth";

export const dynamic = "force-dynamic";

/**
 * Authorizes «Print calibration page» on the profiles screen (design §P2-3). The page itself is
 * drawn in the browser from the profile's own numbers (rulers and slot outlines, no ERP data), so
 * this endpoint is where the server decides whether it may be printed: the same readers as the
 * profiles screen, then the print certification gate — 409 PRINTING_NOT_CERTIFIED while
 * PRINT_CERTIFIED is not "true".
 */
export async function POST() {
  const { error } = await requirePrintRead();
  if (error) return error;
  const gated = printCertificationGate();
  if (gated) return gated;
  return NextResponse.json({ ok: true });
}
