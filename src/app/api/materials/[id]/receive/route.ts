import { flushPostings } from "@/lib/accounting/ops/cost-ledger";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { parseStockQuantity } from "@/lib/services/stock-quantity";
import { receiveMaterial } from "@/lib/services/purchase-receipts";

type Params = { params: Promise<{ id: string }> };

/**
 * Receive a delivery of packaging material (bags, labels, cartons): the routine, NON-privileged
 * path (inventory privileges Option A, review P2-4). A count changes the balance either way and is
 * an inventory adjustment (privileged, PATCH /api/materials/:id); receiving only ever ADDS what
 * arrived, so it stays with the receiving duty and its PIN-only staff.
 *
 * Body: { quantity > 0, supplierId? | reference?  (at least one), notes? }
 * Writes, in one transaction: an IN movement (RECEIVING) with the quantity, the login and the
 * supplier / reference; the new balance; and an INVENTORY_RECEIVED audit row.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("inventory", "receive");
  if (error) return error;
  const { id } = await params;

  let b: Record<string, unknown>;
  try {
    b = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Strict (re-review P3-B): a JSON number or a plain decimal string, > 0, ≤ 1,000,000, at most 4
  // decimals; whole numbers for a material counted in pieces / units (checked once the row is read).
  const parsed = parseStockQuantity(b.quantity, { allowZero: false });
  if (!parsed.ok)
    return NextResponse.json({ error: `quantity ${parsed.message} (receiving only adds stock; a count is an adjustment).`, code: "RECEIVE_QUANTITY_INVALID" }, { status: 400 });
  const quantity = parsed.value;
  const supplierId = typeof b.supplierId === "string" && b.supplierId.trim() ? b.supplierId.trim() : null;
  const reference = typeof b.reference === "string" && b.reference.trim() ? b.reference.trim().slice(0, 120) : null;
  if (!supplierId && !reference)
    return NextResponse.json({ error: "Name the supplier or the delivery reference (delivery note, invoice number).", code: "RECEIVE_SOURCE_REQUIRED" }, { status: 400 });
  const notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim().slice(0, 500) : null;
  // Accounting A3 (optional): the unit cost of what arrived. With a supplier it makes the receipt a costed GRN
  // (a purchase record, Dr inventory / Cr GRNI); without one the quantity arrives at zero cost and the supplier
  // invoice's stock line capitalises it.
  let unitCost: number | null = null;
  if (b.unitCost !== undefined && b.unitCost !== null && b.unitCost !== "") {
    const n = typeof b.unitCost === "number" ? b.unitCost : typeof b.unitCost === "string" && /^\d{1,12}(\.\d{1,6})?$/.test(b.unitCost.trim()) ? Number(b.unitCost) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 1e9)
      return NextResponse.json({ error: "تكلفة الوحدة رقم عشري ≥ 0.", errorEn: "unitCost is a decimal ≥ 0.", code: "RECEIVE_UNIT_COST_INVALID" }, { status: 400 });
    unitCost = n;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // The shared receive service (src/lib/services/purchase-receipts.ts): the row lock, the whole-number rule, the
      // IN movement, the balance, the costed GRN when a supplier and a unit cost are given, and the receipt audit.
      const { material: updated, movement } = await receiveMaterial(tx, user, { materialItemId: id, quantity, rawQuantity: b.quantity, supplierId, reference, notes, unitCost });
      await flushPostings(tx);
      return { material: updated, movement };
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string; code?: string };
      return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
