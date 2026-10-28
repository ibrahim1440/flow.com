// «نقص من المورد» (feat/supplier-shortfall, 20261119090000_supplier_shortfall) — the pure rules (no database), shared by
// the purchase-invoice service, the settings route and the invoice form.
//
//   A stock line of the one-step purchase invoice may be billed for more than was received («المستلم أقل من الفاتورة»):
//     billed  = the quantity on the supplier's tax invoice (≥ received);   line net = billed × unit cost (the VAT too);
//     received enters stock at received × unit cost (the receipt, as before);   shortfall = billed − received.
//   Its treatment:
//     CLAIM     «مطالبة المورد» (the default)  Dr SUPPLIER_CLAIMS (an open claim, settled by a credit note, replacement
//                                              goods or an abandonment);
//     LOSS      «خسارة»                       Dr PURCHASE_SHORTAGE (inventory › adjust + step-up + a reason);
//     ABSORBED  within the weight tolerance (default 0.5 % of the billed quantity) and no treatment chosen: into the cost
//               (IAS 2 — a normal loss is part of the cost of the goods received).
export const SHORTFALL_TOLERANCE_DEFAULT = 0.5;
export const ABANDON_REVERSE_VAT_DEFAULT = true;
/** Council F5: the tolerance is at most 2 % (CHECK and API); above 1 % the settings screen warns. */
export const SHORTFALL_TOLERANCE_MAX = 2;
export const SHORTFALL_TOLERANCE_WARN = 1;
export type ShortfallTreatment = "CLAIM" | "LOSS" | "ABSORBED";

type Num = { toString(): string } | number | null | undefined;
const num = (v: Num) => (v === null || v === undefined ? null : String(Number(v.toString())));

/** Settings › Inventory «نقص من المورد»: the stored values (null = default) and those in force. */
export function supplierShortfallFromRow(row: { purchaseShortfallTolerancePercent?: Num; purchaseAbandonReverseVat?: boolean | null } | null | undefined) {
  const t = num(row?.purchaseShortfallTolerancePercent);
  const v = row?.purchaseAbandonReverseVat ?? null;
  return {
    tolerancePercent: t === null ? SHORTFALL_TOLERANCE_DEFAULT : Number(t),
    abandonReverseVat: v === null ? ABANDON_REVERSE_VAT_DEFAULT : v,
    stored: { tolerancePercent: t, abandonReverseVat: v },
  };
}

/** The shortfall as a percentage of the billed quantity. */
export function shortfallPercent(billed: number, received: number): number {
  return billed > 0 ? ((billed - received) / billed) * 100 : 0;
}

/**
 * The treatment a line gets: the one chosen (CLAIM / LOSS), else ABSORBED when the shortfall is within the tolerance,
 * else CLAIM. A float comparison with a tiny epsilon (the inputs have at most 4 decimals).
 */
export function resolveShortfallTreatment(o: { billed: number; received: number; requested?: string | null; tolerancePercent: number }): ShortfallTreatment {
  if (o.requested === "CLAIM" || o.requested === "LOSS") return o.requested;
  return shortfallPercent(o.billed, o.received) <= o.tolerancePercent + 1e-9 ? "ABSORBED" : "CLAIM";
}
