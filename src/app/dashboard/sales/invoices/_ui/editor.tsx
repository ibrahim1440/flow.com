"use client";

// The draft editor (Figma ZT-14): buyer particulars (prefilled from the customer, frozen at issue), the invoice
// family, the supply date and terms, the lines (description, quantity, unit price, discount, VAT category and
// rate) and the totals — computed by the same E-10 engine the server stores and the database re-checks.
import { useMemo, useState } from "react";
import { Select } from "@/components/ui/Select";
import { priceInvoice, parseLines, inclusiveDifference, EXEMPTION_REASONS, type RawLine } from "@/lib/services/invoicing/pricing";
import { CATEGORY, money, useLang } from "./inv";
import { AssetSalePicker } from "./asset-sale";
import { AddMore, TaxSummary, useShiftA } from "@/components/forms/QoyodForm";

export type EditLine = {
  description: string; descriptionEn?: string | null; quantity: string; unit: "UNIT" | "KG"; unitPrice: string; discountPercent: string;
  taxCategory: "S" | "Z" | "E" | "O"; taxRatePercent: string; exemptionReasonCode?: string | null;
  orderItemId?: string | null; productSkuId?: string | null; skuCode?: string | null; originalLineId?: string | null; deliveryId?: string | null;
  /** The editor's own cap (what is left to invoice / credit on the source line), when there is one. */
  max?: string | null;
  /** «بيع أصل ثابت» (BATCH 22 WP-F): the asset sold and the disposal it will make; `rett`: land / buildings (RETT reminder). */
  kind?: "ITEM" | "FIXED_ASSET_SALE"; fixedAssetId?: string | null; disposalKind?: "SALE" | "SCRAP" | null; rett?: boolean;
  /** «شامل؟» (BATCH 22 WP-K): the price is typed VAT-inclusive (`unitPriceGross`); the server derives the net unit price. */
  priceIncludesVat?: boolean; unitPriceGross?: string | null;
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

/** «شامل؟»: the net unit price the server will derive from the typed gross (display). */
function netUnit(l: EditLine): string {
  const c = parseLines([l] as unknown as RawLine[]).lines[0];
  return c ? money(c.unitPrice.toFixed(2)) : "";
}

/** «فرق التقريب» of an inclusive line (qty × typed gross vs the line's value) — a few halalas at most; "" when none. */
function roundingDiff(t: ReturnType<typeof useTotals>, i: number, l: EditLine): string {
  const c = t.priced ? parseLines([l] as unknown as RawLine[]).lines[0] : null;
  if (!c || !c.enteredGrossUnitPrice) return "";
  const d = inclusiveDifference(c);
  return d.isZero() ? "" : d.toFixed(2);
}

export function Totals({ lines, qoyod = false }: { lines: EditLine[]; qoyod?: boolean }) {
  const { L } = useLang();
  const t = useTotals(lines);
  if (!t.priced) return <p className="acct-hint">{L("أكمل البنود لترى الإجماليات.", "Complete the lines to see the totals.")}</p>;
  const p = t.priced;
  return (
    <div>
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
    {/* «ملخص الضريبة» S / Z / E / O (the accountant workspace): the document breakdown, as stored at issue. */}
    {qoyod ? <TaxSummary title={L("ملخص الضريبة", "VAT summary")} head={[L("الفئة", "Category"), L("الاجمالي قبل الضريبة", "Taxable amount"), L("قيمة الضريبة", "VAT")]} testId="draft-tax-summary"
      rows={p.breakdown.map((b) => ({ key: `${b.category}${b.rate}`, label: `${b.category} · ${L(CATEGORY[b.category][0], CATEGORY[b.category][1])} ${Number(b.rate)}%`, base: money(b.taxable), vat: money(b.tax) }))} /> : null}
    </div>
  );
}

/**
 * `lockItems`: a credit note's lines keep the original's item, unit and tax. `lockCommercial` (BATCH 22 WP-C, council
 * Q-F3): the accountant correcting a requested draft changes compliance fields only — quantity, unit, price, discount and
 * the set of lines are locked (the server refuses them too: REQUEST_COMMERCIAL_LOCKED).
 *
 * `qoyod` (batch 22 WP-J, QOYOD-REF §8.3 — the accountant workspace): Qoyod's per-line «الاجمالي قبل الضريبة · قيمة
 * الضريبة · القيمة» and «إضافة المزيد» with its Shift+A shortcut. Display only: the same lines and totals engine.
 * `inclusive` (WP-K, default = `qoyod`): the «شامل؟» column — the price typed VAT-inclusive, the net derived on the server.
 */
export function LinesEditor({ lines, onChange, lockItems, lockCommercial, sellAssets, testId = "draft-lines", qoyod = false, inclusive = qoyod }: { lines: EditLine[]; onChange: (lines: EditLine[]) => void; lockItems?: boolean; lockCommercial?: boolean; sellAssets?: boolean; testId?: string; qoyod?: boolean; inclusive?: boolean }) {
  const { L } = useLang();
  const fixedSet = lockItems || lockCommercial;
  const [picking, setPicking] = useState(false);
  const set = (i: number, patch: Partial<EditLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const t = useTotals(lines);
  useShiftA(() => onChange([...lines, emptyLine()]), qoyod && !fixedSet);
  return (
    <div className="hr-tablewrap">
      <table className="hr-table is-dense inv-lines" data-testid={testId}>
        <thead><tr>
          <th>#</th><th>{L("الوصف", "Description")}</th><th className="num">{L("الكمية", "Qty")}</th><th>{L("الوحدة", "Unit")}</th>
          <th className="num">{L("سعر الوحدة", "Unit price")}</th>{inclusive ? <th>{L("شامل؟", "Incl. VAT?")}</th> : null}<th className="num">{L("الخصم %", "Disc. %")}</th><th>{L("الضريبة", "VAT")}</th>
          <th className="num">{qoyod ? L("الاجمالي قبل الضريبة", "Before VAT") : L("قبل الضريبة", "Before VAT")}</th>
          {qoyod ? <><th className="num">{L("قيمة الضريبة", "VAT amount")}</th><th className="num">{L("القيمة", "Amount")}</th></> : null}<th />
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} data-testid={`line-${i}`}>
              <td className="hr-num">{i + 1}</td>
              <td className="w-desc">
                <input className="hr-input" value={l.description} disabled={lockItems} onChange={(e) => set(i, { description: e.target.value })} aria-label={L("الوصف", "Description")} data-testid={`line-desc-${i}`} />
                {l.skuCode ? <span className="inv-sub acct-code">{l.skuCode}</span> : null}
                {l.max ? <span className="inv-sub">{L("المتبقي", "Left")} <bdi className="hr-num">{l.max}</bdi></span> : null}
                {l.kind === "FIXED_ASSET_SALE" ? (
                  <span className="inv-sub" data-testid={`line-asset-${i}`}>
                    <span className="inv-chip is-warn">{L("بيع أصل ثابت", "Fixed-asset sale")}</span>{" "}
                    <Select value={l.disposalKind ?? "SALE"} disabled={fixedSet} onChange={(e) => set(i, { disposalKind: e.target.value === "SCRAP" ? "SCRAP" : "SALE" })} aria-label={L("نوع الاستبعاد", "Disposal kind")}>
                      <option value="SALE">{L("بيع", "Sale")}</option><option value="SCRAP">{L("خردة مُباعة", "Scrap sold")}</option>
                    </Select>
                    {l.rett || (l.taxCategory === "E" && l.exemptionReasonCode === "VATEX-SA-30") ? <span className="inv-chip" data-testid={`line-rett-${i}`}>{L("عقار: معفى من ضريبة القيمة المضافة؛ تذكير بضريبة التصرفات العقارية (خارج النظام)", "Real estate: VAT-exempt; RETT reminder (outside this system)")}</span> : null}
                  </span>
                ) : null}
              </td>
              <td><input className="hr-input acct-amount" inputMode="decimal" value={l.quantity} disabled={lockCommercial || l.kind === "FIXED_ASSET_SALE"} onChange={(e) => set(i, { quantity: e.target.value })} aria-label={L("الكمية", "Quantity")} data-testid={`line-qty-${i}`} /></td>
              <td>{fixedSet ? (l.unit === "KG" ? L("كغ", "kg") : L("عبوة", "unit")) : (
                <Select value={l.unit} onChange={(e) => set(i, { unit: e.target.value === "KG" ? "KG" : "UNIT" })} aria-label={L("الوحدة", "Unit")}>
                  <option value="UNIT">{L("عبوة", "unit")}</option><option value="KG">{L("كغ", "kg")}</option>
                </Select>)}</td>
              <td>{l.priceIncludesVat
                ? <input className="hr-input acct-amount" inputMode="decimal" value={l.unitPriceGross ?? ""} disabled={lockCommercial} onChange={(e) => set(i, { unitPriceGross: e.target.value })} aria-label={L("سعر الوحدة شامل الضريبة", "Unit price incl. VAT")} data-testid={`line-price-${i}`} />
                : <input className="hr-input acct-amount" inputMode="decimal" value={l.unitPrice} disabled={lockCommercial} onChange={(e) => set(i, { unitPrice: e.target.value })} aria-label={L("سعر الوحدة", "Unit price")} data-testid={`line-price-${i}`} />}
                {l.priceIncludesVat && t.priced?.lines[i] ? <span className="inv-sub">{L("الصافي", "Net")} <bdi className="hr-num" data-testid={`line-net-unit-${i}`}>{netUnit(l)}</bdi>{(() => { const d = roundingDiff(t, i, l); return d ? <> · {L("فرق التقريب", "Rounding")} <bdi className="hr-num" data-testid={`line-rounding-${i}`}>{d}</bdi></> : null; })()}</span> : null}
              </td>
              {inclusive ? <td><label className="pur-check" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={!!l.priceIncludesVat} disabled={lockCommercial}
                onChange={(e) => set(i, e.target.checked ? { priceIncludesVat: true, unitPriceGross: l.unitPrice || l.unitPriceGross || "" } : { priceIncludesVat: false, unitPrice: l.unitPriceGross || l.unitPrice, unitPriceGross: null })}
                aria-label={L("السعر شامل الضريبة؟", "Price includes VAT?")} data-testid={`line-incl-${i}`} /></label></td> : null}
              <td><input className="hr-input acct-amount" inputMode="decimal" value={l.discountPercent} disabled={lockCommercial} onChange={(e) => set(i, { discountPercent: e.target.value })} aria-label={L("الخصم", "Discount")} data-testid={`line-disc-${i}`} /></td>
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
              {qoyod ? <>
                <td className="num hr-num" data-testid={`line-vat-${i}`}>{t.priced ? money(t.priced.lines[i]?.lineTax.toFixed(2)) : ""}</td>
                <td className="num hr-num" data-testid={`line-total-${i}`}>{t.priced ? money(t.priced.lines[i]?.lineTotal.toFixed(2)) : ""}</td>
              </> : null}
              <td>{!fixedSet ? <button type="button" className="hr-btn is-ghost is-sm" onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label={L("حذف البند", "Remove line")}>×</button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!fixedSet ? (qoyod
        ? <div style={{ padding: "8px 0" }}><AddMore onClick={() => onChange([...lines, emptyLine()])} label={L("إضافة المزيد", "Add more")} testId="add-line" /></div>
        : <button type="button" className="hr-btn is-sm" onClick={() => onChange([...lines, emptyLine()])} data-testid="add-line">{L("إضافة بند", "Add line")}</button>) : null}
      {!fixedSet && sellAssets ? <button type="button" className="hr-btn is-sm" onClick={() => setPicking(true)} data-testid="add-asset-sale">+ {L("بيع أصل ثابت", "Sell a fixed asset")}</button> : null}
      {picking ? <AssetSalePicker onClose={() => setPicking(false)} onPick={(l) => { setPicking(false); onChange([...lines.filter((x) => x.description || x.unitPrice), l]); }} /> : null}
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
