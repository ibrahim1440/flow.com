"use client";

// «إصدار إشعار دائن / مدين» against an issued invoice (Figma ZT-06a frames the printed note; the creation form is not
// drawn — Direction 2.1 controls). Credit: the original's lines with what is still creditable; full or chosen lines,
// a quantity / price per line, never more than invoiced (the database refuses it too). Debit: free lines. Both need
// a reason code and a reason, are saved as a DRAFT and issued from the note's page — by another person than the
// preparer (four-eyes; SIMPLE MODE records the bypass).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useMemo, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { DocNo, InvShell, Msg, REASONS, money, useApi, useLang, useWrite } from "../../_ui/inv";
import { LinesEditor, Totals, emptyLine, type EditLine } from "../../_ui/editor";

type Line = { id: string; description: string; skuCode: string | null; quantity: string; unit: "UNIT" | "KG"; unitPrice: string; discountPercent: string; taxCategory: "S" | "Z" | "E" | "O"; taxRatePercent: string; exemptionReasonCode: string | null; lineNet: string };
type Doc = { id: string; number: string | null; status: string; kind: string; family: string; totals: { grand: string }; lines: Line[]; buyer: { name: string } };
type Creditable = { lines: { lineId: string; quantity: string; lineNet: string; credited: string; left: string }[] };
type Search = { kind?: string };
const NO_SEARCH: Promise<Search> = Promise.resolve({});

export default function CreditNotePage({ params, searchParams = NO_SEARCH }: { params: Promise<{ id: string }>; searchParams?: Promise<Search> }) {
  const { id } = use(params);
  const sp = use(searchParams);
  const debit = sp.kind === "DEBIT_NOTE";
  const { L } = useLang();
  const router = useRouter();
  const doc = useApi<Doc>(`/api/sales/invoices/${id}`);
  const cred = useApi<Creditable>(debit ? null : `/api/sales/invoices/${id}/notes`);
  const w = useWrite();
  const [reasonCode, setReasonCode] = useState(debit ? "PRICE_ADJUSTMENT" : "RETURN");
  const [reason, setReason] = useState("");
  const [pick, setPick] = useState<Record<string, { on: boolean; quantity: string; unitPrice: string }>>({});
  const [debitLines, setDebitLines] = useState<EditLine[]>([emptyLine()]);
  const d = doc.data;
  const leftOf = (lineId: string) => cred.data?.lines.find((x) => x.lineId === lineId);
  const chosen: EditLine[] = useMemo(() => (d?.lines ?? []).filter((l) => pick[l.id]?.on).map((l) => ({
    description: l.description, quantity: pick[l.id].quantity, unit: l.unit, unitPrice: pick[l.id].unitPrice, discountPercent: l.discountPercent,
    taxCategory: l.taxCategory, taxRatePercent: l.taxRatePercent, exemptionReasonCode: l.exemptionReasonCode, originalLineId: l.id, skuCode: l.skuCode,
  })), [d, pick]);
  const submit = async (full: boolean) => {
    const body = debit
      ? { kind: "DEBIT_NOTE", reasonCode, reason, lines: debitLines }
      : full ? { kind: "CREDIT_NOTE", reasonCode, reason, full: true } : { kind: "CREDIT_NOTE", reasonCode, reason, lines: chosen };
    const r = await w.run<{ id: string }>("note", `/api/sales/invoices/${id}/notes`, "POST", body);
    if (r) router.push(`/dashboard/sales/invoices/${r.id}`);
  };
  const title = debit ? L("إشعار مدين", "Debit note") : L("إشعار دائن", "Credit note");
  return (
    <InvShell title={title} testId={debit ? "debit-note-form" : "credit-note-form"}>
      <Msg error={w.error ?? doc.error ?? cred.error} />
      {!d ? <OpsLoading /> : d.status !== "ISSUED" || d.kind !== "INVOICE" ? <p className="acct-hint">{L("يصدر الإشعار على فاتورة صادرة فقط.", "A note is issued against an issued invoice only.")}</p> : (
        <>
          <div className="acct-card">
            <h2>{L("على الفاتورة", "Against invoice")} <Link href={`/dashboard/sales/invoices/${id}`}><DocNo n={d.number} /></Link> · <bdi>{d.buyer.name}</bdi> · <span className="hr-num">{money(d.totals.grand)}</span></h2>
            <div className="acct-row">
              <label className="hr-field"><span className="hr-label">{L("سبب الإصدار", "Reason code")}</span>
                <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} data-testid="reason-code">
                  {Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
                </Select></label>
              <label className="hr-field acct-grow"><span className="hr-label">{L("السبب (يُطبع على الإشعار)", "Reason (printed on the note)")}</span>
                <input className="hr-input" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="reason" /></label>
            </div>
          </div>
          {debit ? (
            <div className="acct-card">
              <h2>{L("بنود الإشعار المدين", "Debit note lines")}</h2>
              <LinesEditor lines={debitLines} onChange={setDebitLines} />
              <Totals lines={debitLines} />
            </div>
          ) : (
            <div className="acct-card">
              <h2>{L("ما يُخفَّض", "What is credited")}</h2>
              {!cred.data ? <OpsLoading rows={3} /> : (
                <div className="hr-tablewrap">
                  <table className="hr-table is-dense inv-lines" data-testid="credit-lines">
                    <thead><tr><th /><th>{L("البند", "Line")}</th><th className="num">{L("المفوتر", "Invoiced")}</th><th className="num">{L("المتبقي للتخفيض", "Left to credit")}</th><th className="num">{L("الكمية", "Qty")}</th><th className="num">{L("سعر الوحدة", "Unit price")}</th></tr></thead>
                    <tbody>{d.lines.map((l, i) => {
                      const left = leftOf(l.id);
                      const p = pick[l.id] ?? { on: false, quantity: l.quantity, unitPrice: l.unitPrice };
                      const set = (patch: Partial<typeof p>) => setPick((x) => ({ ...x, [l.id]: { ...p, ...patch } }));
                      return (
                        <tr key={l.id} data-testid={`credit-line-${i}`}>
                          <td><input type="checkbox" checked={p.on} disabled={!left || Number(left.left) <= 0} onChange={(e) => set({ on: e.target.checked })} aria-label={L("تضمين البند", "Include line")} data-testid={`credit-pick-${i}`} /></td>
                          <td><bdi>{l.description}</bdi>{l.skuCode ? <span className="inv-sub acct-code">{l.skuCode}</span> : null}</td>
                          <td className="num hr-num">{l.quantity} · {money(l.lineNet)}</td>
                          <td className="num hr-num">{money(left?.left)}</td>
                          <td><input className="hr-input acct-amount" inputMode="decimal" value={p.quantity} disabled={!p.on} onChange={(e) => set({ quantity: e.target.value })} data-testid={`credit-qty-${i}`} /></td>
                          <td><input className="hr-input acct-amount" inputMode="decimal" value={p.unitPrice} disabled={!p.on} onChange={(e) => set({ unitPrice: e.target.value })} data-testid={`credit-price-${i}`} /></td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                </div>
              )}
              {chosen.length ? <Totals lines={chosen} /> : null}
            </div>
          )}
          <div className="acct-foot">
            <span className="acct-hint">{L("يُحفظ مسودة؛ يصدره شخص آخر غير مُعدّه.", "Saved as a draft; issued by someone other than its preparer.")}</span>
            <span className="acct-actions">
              <Link className="hr-btn" href={`/dashboard/sales/invoices/${id}`}>{L("رجوع", "Back")}</Link>
              {!debit ? <button type="button" className="hr-btn" disabled={!!w.busy || reason.trim().length < 3} onClick={() => submit(true)} data-testid="credit-full">{L("إشعار بكامل الفاتورة", "Credit the whole invoice")}</button> : null}
              <button type="button" className="hr-btn is-primary" disabled={!!w.busy || reason.trim().length < 3 || (!debit && chosen.length === 0)} onClick={() => submit(false)} data-testid="save-note">{L("حفظ مسودة الإشعار", "Save the note draft")}</button>
            </span>
          </div>
        </>
      )}
    </InvShell>
  );
}
