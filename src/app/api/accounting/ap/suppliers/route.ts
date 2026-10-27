import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { requireApRead } from "@/lib/accounting/ops/http";
import { opsRefuse } from "@/lib/accounting/ops/refusals";
import { supplierOpeningOutstanding } from "@/lib/accounting/ops/ap";
import { auditFromRequest, setAuditContext } from "@/lib/accounting/audit";

/** Suppliers as AP parties (VAT number, credit terms). */
export async function GET() {
  const { error } = await requireApRead();
  if (error) return error;
  const rows = await prisma.supplier.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, vatNumber: true, isNonResident: true, kind: true, paymentTermsDays: true } });
  // A5: the opening balance still unpaid (only suppliers with an opening AP line carry one).
  const withOpening = await prisma.$queryRaw<{ id: string }[]>`SELECT DISTINCT l."partyId" AS id FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId" WHERE j."type"::text = 'OPENING' AND l."partyType" = 'SUPPLIER'`;
  const open = new Map<string, string>();
  for (const s of withOpening) open.set(s.id, (await supplierOpeningOutstanding(prisma, s.id)).toFixed(2));
  return NextResponse.json(rows.map((r) => ({ ...r, openingOutstanding: open.get(r.id) ?? "0.00" })));
}

/** Set a supplier's VAT number / credit terms / non-resident flag (phase 2). accounting › ap. */
export async function PATCH(request: Request) {
  const { user, error } = await requireSub("accounting", "ap");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    const id = typeof b.id === "string" ? b.id : "";
    const vat = b.vatNumber === null || b.vatNumber === "" ? null : String(b.vatNumber ?? "").trim();
    if (vat !== null && !/^\d{15}$/.test(vat)) throw opsRefuse("OPS_BAD_INPUT", "A VAT number is 15 digits.", "الرقم الضريبي 15 رقمًا.");
    const terms = b.paymentTermsDays === null || b.paymentTermsDays === "" || b.paymentTermsDays === undefined ? null : Number(b.paymentTermsDays);
    if (terms !== null && (!Number.isInteger(terms) || terms < 0 || terms > 365)) throw opsRefuse("OPS_BAD_INPUT", "Terms are 0–365 days.", "شروط الدفع من 0 إلى 365 يومًا.");
    // Phase 2: a non-resident supplier (its services are reverse-charged, P-RC15). Left as it is when not sent.
    const nonResident = b.isNonResident === undefined ? undefined : b.isNonResident === true;
    // CA2: who bills the import VAT — customs or a clearing agent; anyone else is a goods / services supplier.
    const kind = b.kind === undefined ? undefined : String(b.kind);
    if (kind !== undefined && !["GOODS_SERVICES", "CUSTOMS", "CLEARING_AGENT"].includes(kind)) throw opsRefuse("OPS_BAD_INPUT", "kind is GOODS_SERVICES, CUSTOMS or CLEARING_AGENT.", "نوع المورد: مورد بضائع/خدمات أو جمارك أو مخلّص جمركي.");
    if (!(await prisma.supplier.findUnique({ where: { id } }))) throw opsRefuse("OPS_NOT_FOUND");
    // EA4: the change is attributed in the accounting audit (ledger_audit_row on "Supplier") to the person who made it.
    return NextResponse.json(await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, auditFromRequest(request, user.id));
      return tx.supplier.update({ where: { id }, data: { vatNumber: vat, paymentTermsDays: terms, ...(nonResident === undefined ? {} : { isNonResident: nonResident }), ...(kind === undefined ? {} : { kind }) }, select: { id: true, name: true, vatNumber: true, isNonResident: true, kind: true, paymentTermsDays: true } });
    }));
  } catch (err) {
    return acctError(err);
  }
}
