"use client";

// «القيود السهلة» — the journal-template editor: name, description, the amount mode (fixed amounts, or percentages of a
// total entered at use time), lines (account, side, amount / percentage, branch, cost centre, party, memo). The balance
// (fixed) or the 100 % per side (percent) is shown live; the server — and the database at commit — check it again.
import { useMemo, useState } from "react";
import { Select } from "@/components/ui/Select";
import { Btn, Field } from "@/components/ops/ui";
import { Msg, acctFetch, money, useApi, useLang } from "./shell";

type Dims = {
  accounts: { id: string; code: string; nameAr: string | null; nameEn: string; allowManualJournal: boolean }[];
  branches: { id: string; nameAr: string | null; nameEn: string }[];
  costCenters: { id: string; nameAr: string | null; nameEn: string }[];
  customers: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
};
export type TplLine = { accountId: string; side: "D" | "C"; amount: string; percent: string; description: string; branchId: string; costCenterId: string; partyType: string; partyId: string };
export type TplValue = { name: string; description: string; amountMode: "FIXED" | "PERCENT"; lines: TplLine[] };
export type TplSaved = { id: string; updatedAt: string };

const blank = (side: "D" | "C"): TplLine => ({ accountId: "", side, amount: "", percent: "", description: "", branchId: "", costCenterId: "", partyType: "", partyId: "" });
export const blankTemplate = (): TplValue => ({ name: "", description: "", amountMode: "FIXED", lines: [blank("D"), blank("C")] });
const AMOUNT = /^\d{0,13}(\.\d{0,2})?$/;
const PCT = /^\d{0,3}(\.\d{0,4})?$/;
/** Exact integers from typed text (halalas / ten-thousandths of a percent): the live indicator only — no float. */
const scaled = (v: string, dp: number, re: RegExp) => {
  if (!v || !re.test(v)) return 0;
  const [w, f = ""] = v.split(".");
  return Number(w || "0") * 10 ** dp + Number((f + "0000").slice(0, dp));
};

export function TemplateEditor({ initial, id, expectedUpdatedAt, onSaved, onCancel }: { initial?: TplValue; id?: string; expectedUpdatedAt?: string; onSaved: (t: TplSaved) => void; onCancel: () => void }) {
  const { L } = useLang();
  const dims = useApi<Dims>("/api/accounting/dimensions");
  const [v, setV] = useState<TplValue>(initial ?? blankTemplate());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accounts = useMemo(() => (dims.data?.accounts ?? []).filter((a) => a.allowManualJournal), [dims.data]);
  const pct = v.amountMode === "PERCENT";
  const sum = (side: "D" | "C") => v.lines.filter((l) => l.side === side).reduce((s, l) => s + (pct ? scaled(l.percent, 4, PCT) : scaled(l.amount, 2, AMOUNT)), 0);
  const dr = sum("D"), cr = sum("C");
  const ok = pct ? dr === 1_000_000 && cr === 1_000_000 : dr === cr && dr > 0;
  const set = (i: number, patch: Partial<TplLine>) => setV((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const name = (x: { nameAr: string | null; nameEn: string }) => L(x.nameAr ?? x.nameEn, x.nameEn);
  const fmtPct = (n: number) => `${(n / 10_000).toFixed(4).replace(/\.?0+$/, "")}٪`;

  async function save() {
    setBusy(true); setError(null);
    try {
      const body = {
        name: v.name, description: v.description || null, amountMode: v.amountMode, expectedUpdatedAt,
        lines: v.lines.filter((l) => l.accountId || l.amount || l.percent).map((l) => ({
          accountId: l.accountId, side: l.side, ...(pct ? { percent: l.percent } : { amount: l.amount }), description: l.description || null,
          branchId: l.branchId || null, costCenterId: l.costCenterId || null, partyType: l.partyType || null, partyId: l.partyId || null,
        })),
      };
      const saved = id ? await acctFetch<TplSaved>(`/api/accounting/journal-templates/${id}`, { method: "PATCH", json: body }) : await acctFetch<TplSaved>("/api/accounting/journal-templates", { method: "POST", json: body });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="acct-card" data-testid="template-editor">
      <Msg error={error} onClose={() => setError(null)} />
      <div className="acct-row">
        <div className="acct-grow"><Field label={L("اسم القالب", "Template name")}><input className="hr-input" maxLength={120} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} data-testid="tpl-name" /></Field></div>
        <Field label={L("طريقة المبالغ", "Amounts")}>
          <Select value={v.amountMode} onChange={(e) => setV({ ...v, amountMode: e.target.value as TplValue["amountMode"] })} aria-label={L("طريقة المبالغ", "Amounts")} data-testid="tpl-mode">
            <option value="FIXED">{L("مبالغ ثابتة", "Fixed amounts")}</option>
            <option value="PERCENT">{L("نسب من إجمالي يُدخل عند الاستخدام", "Percentages of a total entered at use")}</option>
          </Select>
        </Field>
      </div>
      <Field label={L("الوصف", "Description")} help={L("يصبح وصف القيد عند الاستخدام · حتى 500 حرف", "Becomes the journal's description · up to 500 characters")}>
        <input className="hr-input" maxLength={500} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} data-testid="tpl-description" />
      </Field>
      <div className="hr-tablewrap">
        <table className="hr-table acct-lines" data-testid="tpl-lines">
          <thead><tr><th>#</th><th>{L("الحساب", "Account")}</th><th>{L("الجانب", "Side")}</th><th className="num">{pct ? L("النسبة ٪", "Percent %") : L("المبلغ · ر.س", "Amount · SAR")}</th><th>{L("البيان", "Memo")}</th><th className="acct-hide-m">{L("الفرع", "Branch")}</th><th className="acct-hide-m">{L("مركز التكلفة", "Cost centre")}</th><th className="acct-hide-m">{L("الطرف", "Party")}</th><th><span className="hr-sr">{L("حذف", "Remove")}</span></th></tr></thead>
          <tbody>
            {v.lines.map((l, i) => (
              <tr key={i}>
                <td className="hr-num">{i + 1}</td>
                <td style={{ minWidth: 200 }}>
                  <Select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} aria-label={L(`حساب السطر ${i + 1}`, `Line ${i + 1} account`)} placeholder={L("اختر الحساب", "Choose the account")} data-testid={`tpl-account-${i}`}>
                    <option value="">{L("اختر الحساب", "Choose the account")}</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{`${a.code} · ${name(a)}`}</option>)}
                  </Select>
                </td>
                <td>
                  <Select value={l.side} onChange={(e) => set(i, { side: e.target.value as "D" | "C" })} aria-label={L(`جانب السطر ${i + 1}`, `Line ${i + 1} side`)} data-testid={`tpl-side-${i}`}>
                    <option value="D">{L("مدين", "Debit")}</option>
                    <option value="C">{L("دائن", "Credit")}</option>
                  </Select>
                </td>
                <td>{pct
                  ? <input className="hr-input acct-amount" inputMode="decimal" dir="ltr" value={l.percent} aria-invalid={!!l.percent && !PCT.test(l.percent)} onChange={(e) => set(i, { percent: e.target.value.replace(/[^\d.]/g, "") })} aria-label={L(`نسبة السطر ${i + 1}`, `Line ${i + 1} percent`)} data-testid={`tpl-value-${i}`} />
                  : <input className="hr-input acct-amount" inputMode="decimal" dir="ltr" value={l.amount} aria-invalid={!!l.amount && !AMOUNT.test(l.amount)} onChange={(e) => set(i, { amount: e.target.value.replace(/[^\d.]/g, "") })} aria-label={L(`مبلغ السطر ${i + 1}`, `Line ${i + 1} amount`)} data-testid={`tpl-value-${i}`} />}
                </td>
                <td><input className="hr-input" maxLength={500} value={l.description} onChange={(e) => set(i, { description: e.target.value })} aria-label={L("بيان السطر", "Line memo")} /></td>
                <td className="acct-hide-m">
                  <Select value={l.branchId} onChange={(e) => set(i, { branchId: e.target.value })} aria-label={L("الفرع", "Branch")} placeholder="—">
                    <option value="">—</option>
                    {(dims.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
                  </Select>
                </td>
                <td className="acct-hide-m">
                  <Select value={l.costCenterId} onChange={(e) => set(i, { costCenterId: e.target.value })} aria-label={L("مركز التكلفة", "Cost centre")} placeholder="—">
                    <option value="">—</option>
                    {(dims.data?.costCenters ?? []).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}
                  </Select>
                </td>
                <td className="acct-hide-m">
                  <Select value={l.partyType && l.partyId ? `${l.partyType}:${l.partyId}` : ""} onChange={(e) => { const [t, pid] = e.target.value.split(":"); set(i, { partyType: t ?? "", partyId: pid ?? "" }); }} aria-label={L("الطرف", "Party")} placeholder="—">
                    <option value="">—</option>
                    {(dims.data?.customers ?? []).map((c) => <option key={c.id} value={`CUSTOMER:${c.id}`}>{L("عميل", "Customer")} · {c.name}</option>)}
                    {(dims.data?.suppliers ?? []).map((s) => <option key={s.id} value={`SUPPLIER:${s.id}`}>{L("مورد", "Supplier")} · {s.name}</option>)}
                  </Select>
                </td>
                <td><button type="button" className="hr-btn is-ghost hr-iconbtn" aria-label={L(`حذف السطر ${i + 1}`, `Remove line ${i + 1}`)} disabled={v.lines.length <= 2} onClick={() => setV({ ...v, lines: v.lines.filter((_, j) => j !== i) })}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="acct-foot" style={{ borderTop: 0 }}>
        <span className="acct-actions">
          <button type="button" className="hr-btn is-ghost" onClick={() => setV({ ...v, lines: [...v.lines, blank("D")] })} data-testid="tpl-add-debit">+ {L("سطر مدين", "Debit line")}</button>
          <button type="button" className="hr-btn is-ghost" onClick={() => setV({ ...v, lines: [...v.lines, blank("C")] })} data-testid="tpl-add-credit">+ {L("سطر دائن", "Credit line")}</button>
        </span>
        <span className={`acct-balanced ${ok ? "is-ok" : "is-bad"}`} data-testid="tpl-balance">
          {pct
            ? (ok ? L("● النسب مكتملة: 100٪ لكل جانب", "● Complete: 100 % per side") : L(`● المدين ${fmtPct(dr)} · الدائن ${fmtPct(cr)} — المطلوب 100٪ لكل جانب`, `● Debit ${fmtPct(dr)} · credit ${fmtPct(cr)} — each side needs 100 %`))
            : (ok ? L(`● متوازن · ${money(dr / 100)}`, `● Balanced · ${money(dr / 100)}`) : L(`● غير متوازن · الفرق ${money(Math.abs(dr - cr) / 100)}`, `● Not balanced · difference ${money(Math.abs(dr - cr) / 100)}`))}
        </span>
      </div>
      {pct ? <p className="acct-hint">{L("عند الاستخدام يُدخل الإجمالي، ويُقرَّب كل سطر إلى أقرب هللة، ويأخذ آخر سطر في كل جانب الباقي فيتوازن القيد دائمًا.", "At use the total is entered; each line is rounded to the halala and the last line of each side takes the remainder, so the journal always balances.")}</p> : null}
      <p className="acct-hint">{L("حسابات المراقبة (الذمم، المخزون، الضريبة) لا تظهر: تُرحَّل من دفاترها الفرعية. استخدام القالب يفتح القيد اليدوي معبّأً، ويمر بالاعتماد والترحيل المعتادين.", "Control accounts (receivables, inventory, VAT) are not listed: their sub-ledgers post them. Using the template opens the manual journal prefilled; it goes through the usual approval and posting.")}</p>
      <div className="acct-foot">
        <span className="acct-actions">
          <Btn variant="primary" busy={busy} disabled={!ok || !v.name.trim() || busy} onClick={save} data-testid="tpl-save">{id ? L("حفظ التغييرات", "Save changes") : L("حفظ القالب", "Save template")}</Btn>
          <Btn variant="ghost" onClick={onCancel}>{L("إلغاء", "Cancel")}</Btn>
        </span>
      </div>
    </section>
  );
}
