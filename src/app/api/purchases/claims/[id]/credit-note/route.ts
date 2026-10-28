import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { createCreditNote } from "@/lib/accounting/ops/supplier-claims";

type Params = { params: Promise<{ id: string }> };

/**
 * «إشعار دائن من المورد» against an open claim — { supplierRef, noteDate?, net? (default: all that is open), vat? (the
 * supplier's, ±0.01 of the computed), notes? }: Dr AP (Dr supplier advances for what the invoice no longer owes) /
 * Cr supplier claims / Cr VAT input. accounting › ap (step-up).
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "ap");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    return NextResponse.json(await createCreditNote((await params).id, { supplierRef: String(b.supplierRef ?? ""), noteDate: (b.noteDate as string | null) ?? null, net: (b.net as string | number | null) ?? null, vat: (b.vat as string | number | null) ?? null, notes: (b.notes as string | null) ?? null }, auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
