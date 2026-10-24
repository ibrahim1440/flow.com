import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { requireApRead } from "@/lib/accounting/ops/http";
import { opsRefuse } from "@/lib/accounting/ops/refusals";
import { supplierOpeningOutstanding } from "@/lib/accounting/ops/ap";

/** Suppliers as AP parties (VAT number, credit terms). */
export async function GET() {
  const { error } = await requireApRead();
  if (error) return error;
  const rows = await prisma.supplier.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, vatNumber: true, paymentTermsDays: true } });
  // A5: the opening balance still unpaid (only suppliers with an opening AP line carry one).
  const withOpening = await prisma.$queryRaw<{ id: string }[]>`SELECT DISTINCT l."partyId" AS id FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId" WHERE j."type"::text = 'OPENING' AND l."partyType" = 'SUPPLIER'`;
  const open = new Map<string, string>();
  for (const s of withOpening) open.set(s.id, (await supplierOpeningOutstanding(prisma, s.id)).toFixed(2));
  return NextResponse.json(rows.map((r) => ({ ...r, openingOutstanding: open.get(r.id) ?? "0.00" })));
}

/** Set a supplier's VAT number / credit terms. accounting › ap. */
export async function PATCH(request: Request) {
  const { error } = await requireSub("accounting", "ap");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    const id = typeof b.id === "string" ? b.id : "";
    const vat = b.vatNumber === null || b.vatNumber === "" ? null : String(b.vatNumber ?? "").trim();
    if (vat !== null && !/^\d{15}$/.test(vat)) throw opsRefuse("OPS_BAD_INPUT", "A VAT number is 15 digits.", "الرقم الضريبي 15 رقمًا.");
    const terms = b.paymentTermsDays === null || b.paymentTermsDays === "" || b.paymentTermsDays === undefined ? null : Number(b.paymentTermsDays);
    if (terms !== null && (!Number.isInteger(terms) || terms < 0 || terms > 365)) throw opsRefuse("OPS_BAD_INPUT", "Terms are 0–365 days.", "شروط الدفع من 0 إلى 365 يومًا.");
    if (!(await prisma.supplier.findUnique({ where: { id } }))) throw opsRefuse("OPS_NOT_FOUND");
    return NextResponse.json(await prisma.supplier.update({ where: { id }, data: { vatNumber: vat, paymentTermsDays: terms }, select: { id: true, name: true, vatNumber: true, paymentTermsDays: true } }));
  } catch (err) {
    return acctError(err);
  }
}
