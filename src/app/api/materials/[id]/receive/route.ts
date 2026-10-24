import { flushPostings } from "@/lib/accounting/ops/cost-ledger";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { auditInventoryReceipt } from "@/lib/services/inventory-receiving";
import { parseStockQuantity } from "@/lib/services/stock-quantity";
import { onMaterialReceipt } from "@/lib/accounting/ops/inventory-events";

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
      // Lock the material row first. A count (PATCH /api/materials/:id) takes the same lock, so a
      // receipt and a count are serialised and neither loses the other's units; a packaging draw
      // decrements atomically and reads its balance back (unified-packaging.ts).
      const locked = await tx.$queryRaw<{ id: string; quantityOnHand: number; isActive: boolean; unitOfMeasure: string }[]>`
        SELECT "id", "quantityOnHand", "isActive", "unitOfMeasure"::text AS "unitOfMeasure" FROM "MaterialItem" WHERE "id" = ${id} FOR UPDATE`;
      const item = locked[0];
      if (!item) throw { _appCode: 404, message: "Material not found." };
      if (!parseStockQuantity(b.quantity, { allowZero: false, unitOfMeasure: item.unitOfMeasure }).ok)
        throw { _appCode: 400, message: `quantity must be a whole number for a material counted in ${item.unitOfMeasure.toLowerCase()}s.`, code: "RECEIVE_QUANTITY_INVALID" };
      if (!item.isActive) throw { _appCode: 409, message: "This material is inactive; reactivate it before receiving." };
      const supplier = supplierId ? await tx.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true } }) : null;
      if (supplierId && !supplier) throw { _appCode: 404, message: "Supplier not found." };

      const previousQuantity = item.quantityOnHand;
      const newQuantity = Number((previousQuantity + quantity).toFixed(4));
      const label = [supplier ? `Supplier: ${supplier.name}` : null, reference ? `Ref: ${reference}` : null, notes].filter(Boolean).join(" · ");
      const movement = await tx.inventoryMovement.create({
        data: {
          type: "IN",
          category: "PACKAGING_MATERIAL",
          referenceEntityId: id,
          quantityChanged: quantity,
          previousQuantity,
          newQuantity,
          sourceDocType: "RECEIVING",
          sourceDocId: supplier?.id ?? id,
          userId: user.id,
          notes: `Received · ${label}`.slice(0, 1000),
        },
      });
      const updated = await tx.materialItem.update({ where: { id }, data: { quantityOnHand: newQuantity } });
      const purchase = supplier && unitCost !== null && unitCost > 0
        ? await tx.purchaseRecord.create({ data: { supplierId: supplier.id, type: "PACKAGING", itemId: id, materialItemId: id, quantity, costPerUnit: unitCost, totalCost: +(quantity * unitCost).toFixed(4), purchaseDate: new Date(), notes: [reference ? `Ref: ${reference}` : null, notes].filter(Boolean).join(" · ") || null, userId: user.id } })
        : null;
      await onMaterialReceipt(tx, { sourceId: purchase?.id ?? movement.id, materialItemId: id, supplierId: purchase ? supplier!.id : null, qty: quantity, unitCost: purchase ? unitCost : null, actor: user.id, movementId: movement.id });
      await auditInventoryReceipt(tx, user, { entityId: id, opening: false, movementId: movement.id, quantity, previousQuantity, newQuantity, supplier, reference, notes });
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
