import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnySub, requireAuth, forbidden } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { opsRefuse } from "@/lib/accounting/ops/refusals";
import { auditFromRequest, setAuditContext } from "@/lib/accounting/audit";
import { supplierBalances } from "@/lib/accounting/ops/purchase-invoice";
import { purchaseCan } from "@/lib/purchases/gates";

/**
 * «الموردين» — suppliers with VAT number, payment terms, contact and, for an AP reader, the open balance (posted,
 * unpaid) and what awaits approval. Readable by the inventory module (as GET /api/suppliers) or an AP reader; the
 * balances only for the latter.
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  const can = purchaseCan(user.permissions);
  if (!can.read && !hasModuleAccess(user.permissions, "inventory")) return forbidden();
  try {
    const rows = await supplierBalances();
    return NextResponse.json({ can, rows: can.read ? rows : rows.map((r) => ({ ...r, openBalance: null, awaitingApproval: null })) });
  } catch (err) {
    return acctError(err);
  }
}

/**
 * Rename a supplier or change its contact — catalogue maintenance with the gate of POST /api/suppliers
 * (inventory › receive or adjust). The VAT number and terms stay with accounting › ap (PATCH /api/accounting/ap/suppliers).
 */
export async function PATCH(request: Request) {
  const { user, error } = await requireAnySub("inventory", ["receive", "adjust"]);
  if (error) return error;
  try {
    const b = await jsonBody(request);
    const id = typeof b.id === "string" ? b.id : "";
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
    if (!name) throw opsRefuse("OPS_BAD_INPUT", "The supplier name is required.", "اسم المورد مطلوب.");
    const contact = typeof b.contact === "string" && b.contact.trim() ? b.contact.trim().slice(0, 120) : null;
    if (!(await prisma.supplier.findUnique({ where: { id } }))) throw opsRefuse("OPS_NOT_FOUND");
    // N7: the change is attributed in the accounting audit (ledger_audit_row on "Supplier") to the person who made it.
    return NextResponse.json(await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, auditFromRequest(request, user.id));
      return tx.supplier.update({ where: { id }, data: { name, contact }, select: { id: true, name: true, contact: true } });
    }));
  } catch (err) {
    return acctError(err);
  }
}
