"use client";

// The draft editor (Figma ZT-14): buyer particulars (prefilled from the customer, frozen at issue), the invoice
// family, the supply date and terms, the lines (description, quantity, unit price, discount, VAT category and
// rate) and the totals — computed by the same E-10 engine the server stores and the database re-checks.
import { useMemo } from "react";
import { Select } from "@/components/ui/Select";
import { priceInvoice, parseLines, EXEMPTION_REASONS, type RawLine } from "@/lib/services/invoicing/pricing";
import { CATEGORY, money, useLang } from "./inv";

export type EditLine = {
  description: string; descriptionEn?: string | null; quantity: string; unit: "UNIT" | "KG"; unitPrice: string; discountPercent: string;
  taxCategory: "S" | "Z" | "E" | "O"; taxRatePercent: string; exemptionReasonCode?: string | null;
  orderItemId?: string | null; productSkuId?: string | null; skuCode?: string | null; originalLineId?: string | null; deliveryId?: string | null;
  /** The editor's own cap (what is left to invoice / credit on the source line), when there is one. */
  max?: string | null;
};
export type Buyer = { name: string; nameEn?: string | null; vatNumber: string; crNumber: string; city: string; district: string; street: string; buildingNo: string; postalCode: string; address?: string | null };
export type DraftState = { family: "STANDARD" | "SIMPLIFIED"; buyer: Buyer; supplyDate: string; paymentTermsDays: string; notes: string; lines: EditLine[] };

export const emptyLine = (): EditLine => ({ description: "", quantity: "1", unit: "UNIT", unitPrice: "", discountPercent: "0", taxCategory: "S", taxRatePercent: "15" });

export function useTotals(lines: EditLine[]) {
  return useMemo(() => {
    const { lines: clean, problems } = parseLines(lines as unknown as RawLine[]);
    if (problems.length) return { ok: false as const, problems, priced: null };
    return { ok: true as const, problems, priced: priceInvoice(clean) };
  }, [lines]);
}

export function Totals({ lines }: { lines: EditLine[] }) {
  const { L } = useLang();
  const t = useTotals(lines);
  if (!t.priced) return <p className="acct-hint">{L("أكمل البنود لترى الإجماليات.", "Complete the lines to see the totals.")}</p>;
  const p = t.priced;
  return (
    <dl className="inv-totals" data-testid="draft-totals">
      <div><dt>{L("الإجمالي قبل الخصم", "Gross before discount")}</dt><dd>{money(p.grossTotal.toFixed(2))}</dd></div>
      {p.discountTotal.greaterThan(0) ? <div><dt>{L("الخصم", "Discount")}</dt><dd>{money(p.discountTotal.toFixed(2))}</dd></div> : null}
      <div><dt>{L("الإجمالي قبل الضريبة", "Total before VAT")}</dt><dd>{money(p.taxableTotal.toFixed(2))}</dd></div>
      {p.breakdown.map((b) => (
        <div key={`${b.category}${b.rate}`}><dt>{b.category === "S" ? L(`ضريبة القيمة المضافة ${Number(b.rate)}%`, `VAT ${Number(b.rate)}%`) : L(`${CATEGORY[b.category][0]} (0%)`, `${CATEGORY[b.category][1]} (0%)`)}</dt><dd>{money(b.tax)}</dd></div>
      ))}
      <div className="g"><dt>{L("الإجمالي شامل الضريبة · ر.س", "Total incl. VAT · SAR")}</dt><dd data-testid="draft-grand">{money(p.grandTotal.toFixed(2))}</dd></div>
      {!p.lineVatDifference.isZero() ? <p className="acct-hint">{L(`ضريبة المستند تُحسب على الإجمالي لكل فئة (قاعدة E-10)؛ مجموع ضريبة البنود يختلف بـ ${p.lineVatDifference.toFixed(2)}.`, `Document VAT is computed on the total per category (E-10); the sum of line VAT differs by ${p.lineVatDifference.toFixed(2)}.`)}</p> : null}
    </dl>
  );
}

export function LinesEditor({ lines, onChange, lockItems, testId = "draft-lines" }: { lines: EditLine[]; onChange: (lines: EditLine[]) => void; lockItems?: boolean; testId?: string }) {
  const { L } = useLang();
  const set = (i: number, patch: Partial<EditLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const t = useTotals(lines);
  return (
    <div className="hr-tablewrap">
      <table className="hr-table is-dense inv-lines" data-testid={testId}>
        <thead><tr>
          <th>#</th><th>{L("الوصف", "Description")}</th><th className="num">{L("الكمية", "Qty")}</th><th>{L("الوحدة", "Unit")}</th>
          <th className="num">{L("سعر الوحدة", "Unit price")}</th><th className="num">{L("الخصم %", "Disc. %")}</th><th>{L("الضريبة", "VAT")}</th>
          <th className="num">{L("قبل الضريبة", "Before VAT")}</th><th />
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} data-testid={`line-${i}`}>
              <td className="hr-num">{i + 1}</td>
              <td className="w-desc">
                <input className="hr-input" value={l.description} disabled={lockItems} onChange={(e) => set(i, { description: e.target.value })} aria-label={L("الوصف", "Description")} data-testid={`line-desc-${i}`} />
                {l.skuCode ? <span className="inv-sub acct-code">{l.skuCode}</span> : null}
                {l.max ? <span className="inv-sub">{L("المتبقي", "Left")} <bdi className="hr-num">{l.max}</bdi></span> : null}
              </td>
              <td><input className="hr-input acct-amount" inputMode="decimal" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} aria-label={L("الكمية", "Quantity")} data-testid={`line-qty-${i}`} /></td>
              <td>{lockItems ? (l.unit === "KG" ? L("كغ", "kg") : L("عبوة", "unit")) : (
                <Select value={l.unit} onChange={(e) => set(i, { unit: e.target.value === "KG" ? "KG" : "UNIT" })} aria-label={L("الوحدة", "Unit")}>
                  <option value="UNIT">{L("عبوة", "unit")}</option><option value="KG">{L("كغ", "kg")}</option>
                </Select>)}</td>
              <td><input className="hr-input acct-amount" inputMode="decimal" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} aria-label={L("سعر الوحدة", "Unit price")} data-testid={`line-price-${i}`} /></td>
              <td><input className="hr-input acct-amount" inputMode="decimal" value={l.discountPercent} onChange={(e) => set(i, { discountPercent: e.target.value })} aria-label={L("الخصم", "Discount")} data-testid={`line-disc-${i}`} /></td>
              <td>
                <Select value={l.taxCategory} onChange={(e) => { const c = e.target.value as EditLine["taxCategory"]; set(i, { taxCategory: c, taxRatePercent: c === "S" ? "15" : "0", exemptionReasonCode: c === "S" ? null : EXEMPTION_REASONS.find((x) => x.category === c)?.code ?? null }); }} aria-label={L("فئة الضريبة", "VAT category")}>
                  {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
                </Select>
                {l.taxCategory !== "S" ? (
                  <Select value={l.exemptionReasonCode ?? ""} onChange={(e) => set(i, { exemptionReasonCode: e.target.value || null })} aria-label={L("سبب الإعفاء", "Exemption reason")}>
                    {EXEMPTION_REASONS.filter((x) => x.category === l.taxCategory).map((x) => <option key={x.code} value={x.code}>{L(x.ar, x.en)}</option>)}
                  </Select>
                ) : null}
              </td>
              <td className="num hr-num">{t.priced ? money(t.priced.lines[i]?.lineNet.toFixed(2)) : ""}</td>
              <td>{!lockItems ? <button type="button" className="hr-btn is-ghost is-sm" onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label={L("حذف البند", "Remove line")}>×</button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!lockItems ? <button type="button" className="hr-btn is-sm" onClick={() => onChange([...lines, emptyLine()])} data-testid="add-line">{L("إضافة بند", "Add line")}</button> : null}
      {t.problems.length ? <ul className="inv-check" role="status">{t.problems.slice(0, 6).map((p, k) => <li key={k}>{p.index >= 0 ? L(`البند ${p.index + 1}: `, `Line ${p.index + 1}: `) : ""}{L(p.ar, p.en)}</li>)}</ul> : null}
    </div>
  );
}

export function BuyerFields({ buyer, family, onChange }: { buyer: Buyer; family: "STANDARD" | "SIMPLIFIED"; onChange: (b: Buyer) => void }) {
  const { L } = useLang();
  const f = (k: keyof Buyer, ar: string, en: string, opts: { mono?: boolean; required?: boolean } = {}) => (
    <label className="hr-field"><span className="hr-label">{L(ar, en)}{opts.required ? " *" : ""}</span>
      <input className={`hr-input${opts.mono ? " acct-amount" : ""}`} value={(buyer[k] as string) ?? ""} onChange={(e) => onChange({ ...buyer, [k]: e.target.value })} data-testid={`buyer-${k}`} /></label>
  );
  return (
    <div className="acct-kv-grid">
      {f("name", "اسم المشتري", "Buyer name", { required: true })}
      {f("vatNumber", "الرقم الضريبي للمشتري", "Buyer VAT number", { mono: true, required: family === "STANDARD" })}
      {f("crNumber", "السجل التجاري", "Commercial registration", { mono: true })}
      {f("city", "المدينة", "City")}
      {f("district", "الحي", "District")}
      {f("street", "الشارع", "Street")}
      {f("buildingNo", "رقم المبنى", "Building no.", { mono: true })}
      {f("postalCode", "الرمز البريدي", "Postal code", { mono: true })}
    </div>
  );
}
