"use client";

// «محرر القيد» (Figma ACC-20 / 20b): date, type (manual, read-only), description; lines with account, description,
// branch, cost centre, party (customer / supplier on AR / AP), debit and credit; the totals and the balance state
// live; «حفظ كمسودة» and «حفظ وتقديم للاعتماد». Control accounts are not offered (their sub-ledgers feed them).
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { Btn, Field } from "@/components/ops/ui";
import { Msg, acctFetch, money, todayRiyadh, useApi, useLang } from "./shell";

type Dims = {
  accounts: { id: string; code: string; nameAr: string | null; nameEn: string; type: string; controlType: string | null; allowManualJournal: boolean }[];
  branches: { id: string; code: string; nameAr: string | null; nameEn: string }[];
  costCenters: { id: string; code: string; nameAr: string | null; nameEn: string }[];
  customers: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
};
export type EditorLine = { accountId: string; description: string; debit: string; credit: string; branchId: string; costCenterId: string; partyType: string; partyId: string };
export type EditorValue = { entryDate: string; description: string; lines: EditorLine[] };

const blank = (): EditorLine => ({ accountId: "", description: "", debit: "", credit: "", branchId: "", costCenterId: "", partyType: "", partyId: "" });
const AMOUNT = /^\d{0,13}(\.\d{0,2})?$/;
/** Exact integer halalas from the typed text (no float): the live balance indicator only — the server re-checks with Decimal. */
const cents = (v: string) => {
  if (!v || !AMOUNT.test(v)) return 0;
  const [w, f = ""] = v.split(".");
  return Number(w || "0") * 100 + Number((f + "00").slice(0, 2));
};

export function JournalEditor({ initial, entryId }: { initial?: EditorValue; entryId?: string }) {
  const { L } = useLang();
  const router = useRouter();
  const dims = useApi<Dims>("/api/accounting/dimensions");
  const [v, setV] = useState<EditorValue>(initial ?? { entryDate: todayRiyadh(), description: "", lines: [blank(), blank()] });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manualAccounts = useMemo(() => (dims.data?.accounts ?? []).filter((a) => a.allowManualJournal), [dims.data]);
  const dr = v.lines.reduce((s, l) => s + cents(l.debit), 0);
  const cr = v.lines.reduce((s, l) => s + cents(l.credit), 0);
  const balanced = dr === cr && dr > 0;
  const set = (i: number, patch: Partial<EditorLine>) => setV((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  async function save(submit: boolean) {
    setBusy(submit ? "submit" : "draft"); setError(null);
    try {
      const body = {
        entryDate: v.entryDate, description: v.description,
        lines: v.lines.filter((l) => l.accountId || l.debit || l.credit).map((l) => ({
          accountId: l.accountId, description: l.description || undefined, debit: l.debit || "0", credit: l.credit || "0",
          branchId: l.branchId || null, costCenterId: l.costCenterId || null, partyType: l.partyType || null, partyId: l.partyId || null,
        })),
      };
      const saved = entryId
        ? await acctFetch<{ id: string }>(`/api/accounting/journals/${entryId}`, { method: "PATCH", json: body })
        : await acctFetch<{ id: string }>("/api/accounting/journals", { method: "POST", json: body });
      if (submit) await acctFetch(`/api/accounting/journals/${saved.id}/submit`, { method: "PATCH", json: {} });
      router.push(`/dashboard/accounting/journals/${saved.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const name = (x: { nameAr: string | null; nameEn: string }) => L(x.nameAr ?? x.nameEn, x.nameEn);
  return (
    <section className="acct-card" data-testid="journal-editor">
      <Msg error={error} onClose={() => setError(null)} />
      <div className="acct-row">
        <Field label={L("تاريخ القيد", "Entry date")}><input type="date" className="hr-input" value={v.entryDate} onChange={(e) => setV({ ...v, entryDate: e.target.value })} data-testid="je-date" /></Field>
        <Field label={L("النوع", "Type")} help={L("يُقفل بعد إنشاء المسودة", "Fixed once the draft exists")}><input className="hr-input" value={L("يدوي", "Manual")} readOnly aria-readonly="true" /></Field>
        <div className="acct-grow"><Field label={L("الوصف", "Description")} help={L("حتى 500 حرف", "Up to 500 characters")}><input className="hr-input" maxLength={500} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} data-testid="je-description" /></Field></div>
      </div>
      <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
        <h3>{L("السطور", "Lines")} <span className="acct-hint" style={{ fontWeight: 400 }}>{L("سطران على الأقل · مدين أو دائن في كل سطر · ريال سعودي", "At least two lines · a debit or a credit on each · SAR")}</span></h3>
      </div>
      <div className="hr-tablewrap">
        <table className="hr-table acct-lines" data-testid="je-lines">
          <thead><tr><th>#</th><th>{L("الحساب", "Account")}</th><th>{L("الوصف", "Description")}</th><th className="acct-hide-m">{L("الفرع", "Branch")}</th><th className="acct-hide-m">{L("مركز التكلفة", "Cost centre")}</th><th className="acct-hide-m">{L("الطرف", "Party")}</th><th className="num">{L("مدين · ر.س", "Debit · SAR")}</th><th className="num">{L("دائن · ر.س", "Credit · SAR")}</th><th><span className="hr-sr">{L("حذف", "Remove")}</span></th></tr></thead>
          <tbody>
            {v.lines.map((l, i) => (
              <tr key={i}>
                <td className="hr-num">{i + 1}</td>
                <td style={{ minWidth: 220 }}>
                  <Select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} aria-label={L(`حساب السطر ${i + 1}`, `Line ${i + 1} account`)} placeholder={L("اختر الحساب", "Choose the account")} data-testid={`je-account-${i}`}>
                    <option value="">{L("اختر الحساب", "Choose the account")}</option>
                    {manualAccounts.map((a) => <option key={a.id} value={a.id}>{`${a.code} · ${name(a)}`}</option>)}
                  </Select>
                </td>
                <td><input className="hr-input" value={l.description} onChange={(e) => set(i, { description: e.target.value })} aria-label={L("وصف السطر", "Line description")} /></td>
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
                  <Select value={l.partyType && l.partyId ? `${l.partyType}:${l.partyId}` : ""} onChange={(e) => { const [t, id] = e.target.value.split(":"); set(i, { partyType: t ?? "", partyId: id ?? "" }); }} aria-label={L("الطرف", "Party")} placeholder="—">
                    <option value="">—</option>
                    {(dims.data?.customers ?? []).map((c) => <option key={c.id} value={`CUSTOMER:${c.id}`}>{L("عميل", "Customer")} · {c.name}</option>)}
                    {(dims.data?.suppliers ?? []).map((s) => <option key={s.id} value={`SUPPLIER:${s.id}`}>{L("مورد", "Supplier")} · {s.name}</option>)}
                  </Select>
                </td>
                <td><input className="hr-input acct-amount" inputMode="decimal" dir="ltr" value={l.debit} aria-invalid={!!l.debit && !AMOUNT.test(l.debit)} onChange={(e) => set(i, { debit: e.target.value.replace(/[^\d.]/g, ""), ...(e.target.value ? { credit: "" } : {}) })} aria-label={L(`مدين السطر ${i + 1}`, `Line ${i + 1} debit`)} data-testid={`je-debit-${i}`} /></td>
                <td><input className="hr-input acct-amount" inputMode="decimal" dir="ltr" value={l.credit} aria-invalid={!!l.credit && !AMOUNT.test(l.credit)} onChange={(e) => set(i, { credit: e.target.value.replace(/[^\d.]/g, ""), ...(e.target.value ? { debit: "" } : {}) })} aria-label={L(`دائن السطر ${i + 1}`, `Line ${i + 1} credit`)} data-testid={`je-credit-${i}`} /></td>
                <td><button type="button" className="hr-btn is-ghost hr-iconbtn" aria-label={L(`حذف السطر ${i + 1}`, `Remove line ${i + 1}`)} disabled={v.lines.length <= 2} onClick={() => setV({ ...v, lines: v.lines.filter((_, j) => j !== i) })}>×</button></td>
              </tr>
            ))}
            <tr className="is-total">
              <td /><td colSpan={2}>{L("المجموع", "Total")}</td><td className="acct-hide-m" colSpan={3} />
              <td className="num hr-num" data-testid="je-total-debit">{money(dr / 100)}</td><td className="num hr-num" data-testid="je-total-credit">{money(cr / 100)}</td><td />
            </tr>
          </tbody>
        </table>
      </div>
      <div className="acct-foot" style={{ borderTop: 0 }}>
        <button type="button" className="hr-btn is-ghost" onClick={() => setV({ ...v, lines: [...v.lines, blank()] })} data-testid="je-add-line">+ {L("إضافة سطر", "Add line")}</button>
        <span className={`acct-balanced ${balanced ? "is-ok" : "is-bad"}`} data-testid="je-balance">
          {balanced ? L("● متوازن", "● Balanced") : L(`● غير متوازن · الفرق ${money(Math.abs(dr - cr) / 100)}`, `● Not balanced · difference ${money(Math.abs(dr - cr) / 100)}`)}
        </span>
      </div>
      <p className="acct-hint">{L("حسابات المراقبة (الذمم، المخزون، الضريبة) لا تظهر في القائمة: تُرحَّل من دفاترها الفرعية فقط. يُقدَّم القيد للاعتماد ويعتمده شخص غير المُعدّ.", "Control accounts (receivables, inventory, VAT) are not listed: their sub-ledgers post them. A journal is submitted for approval and approved by someone other than its preparer.")}</p>
      <div className="acct-foot">
        <span className="acct-actions">
          <Btn variant="primary" busy={busy === "submit"} disabled={!balanced || !!busy} onClick={() => save(true)} data-testid="je-submit">{L("حفظ وتقديم للاعتماد", "Save and submit")}</Btn>
          <Btn busy={busy === "draft"} disabled={!!busy} onClick={() => save(false)} data-testid="je-save">{L("حفظ كمسودة", "Save as draft")}</Btn>
          <Btn variant="ghost" onClick={() => router.back()}>{L("إلغاء", "Cancel")}</Btn>
        </span>
        <span className="hr-caption hr-num">{L("المدين", "Debit")} {money(dr / 100)} · {L("الدائن", "Credit")} {money(cr / 100)}</span>
      </div>
    </section>
  );
}
