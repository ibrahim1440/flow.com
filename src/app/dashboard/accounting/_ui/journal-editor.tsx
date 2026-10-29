"use client";

// «إنشاء قيد يدوي» (QOYOD-REF §8.9; Figma ACC-20 / 20b) — batch 22 WP-J. Qoyod's manual-journal form, easier:
//   header  «نوع الحساب» (narrows every line's account list) · «الوصف»* · «الموقع» (the default location of the lines —
//           a manual journal keeps a location per line, council Q-F1) · «التاريخ»* (today) · an optional foreign currency
//           and its rate;
//   lines   الحساب · مدين / دائن بالعملة المحلية · مدين / دائن بالعملة الأجنبية (typing one fills the riyal amount at the
//           rate — an entry aid: the entry is kept in SAR) · التعليقات · الموقع · مركز التكلفة · الطرف; a totals row;
//           «إضافة المزيد» (Shift+A) and the order toggle «المدين ثم الدائن / الترتيب الأصلي»;
//   after   «المرفقات» (links) and «معلومات إضافية»;
//   buttons «حفظ مع التأجيل» (saves and submits, then the deferral schedule is made from the chosen line once the entry
//           is posted — the deferrals service links a schedule to a POSTED journal line only, council F1), «حفظ» (save and
//           submit for approval), «حفظ كمسودة», «إلغاء».
// Control accounts are not offered (their sub-ledgers feed them). The server re-checks every rule.
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { Btn } from "@/components/ops/ui";
import { Section } from "@/components/chrome";
import { FormHead, FormField, AddMore, Collapse, Seg, useShiftA } from "@/components/forms/QoyodForm";
import { Msg, acctFetch, money, todayRiyadh, useApi, useLang } from "./shell";
import { useAccountantView } from "./qoyod-pages";

type Dims = {
  accounts: { id: string; code: string; nameAr: string | null; nameEn: string; type: string; controlType: string | null; allowManualJournal: boolean }[];
  branches: { id: string; code: string; nameAr: string | null; nameEn: string }[];
  costCenters: { id: string; code: string; nameAr: string | null; nameEn: string }[];
  customers: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
};
type Template = { id: string; nameAr: string; nameEn: string | null; kind: string; months: number; isActive: boolean; balanceAccount: { id: string; code: string; nameAr: string | null; nameEn: string } | null };
export type EditorLine = { accountId: string; description: string; debit: string; credit: string; branchId: string; costCenterId: string; partyType: string; partyId: string; fxDebit?: string; fxCredit?: string; key?: number };
export type EditorValue = { entryDate: string; description: string; lines: EditorLine[]; attachments?: { name: string; url: string }[] };
/** The deferral asked for with «حفظ مع التأجيل», kept on this device until the entry is posted (journals/[id]). */
export type DeferIntent = { templateId: string; lineNo: number; startDate: string; description: string };
export const deferKey = (entryId: string) => `hiqbah.je.defer.${entryId}`;

let seq = 0;
const blank = (branchId = ""): EditorLine => ({ accountId: "", description: "", debit: "", credit: "", branchId, costCenterId: "", partyType: "", partyId: "", fxDebit: "", fxCredit: "", key: ++seq });
const AMOUNT = /^\d{0,13}(\.\d{0,2})?$/;
const RATE = /^\d{0,6}(\.\d{0,6})?$/;
/** Exact integer halalas from the typed text (no float): the live balance indicator only — the server re-checks with Decimal. */
const cents = (v: string | undefined) => {
  if (!v || !AMOUNT.test(v)) return 0;
  const [w, f = ""] = v.split(".");
  return Number(w || "0") * 100 + Number((f + "00").slice(0, 2));
};
/** foreign × rate, rounded to the halala (an entry aid; the server receives the riyal amount). */
const atRate = (fx: string, rate: string): string => {
  if (!fx || !AMOUNT.test(fx) || !rate || !RATE.test(rate) || !(Number(rate) > 0)) return "";
  return (Math.round(cents(fx) * Number(rate)) / 100).toFixed(2);
};
const ACCOUNT_TYPES: [string, string, string][] = [["", "كل الأنواع", "All types"], ["ASSET", "الأصول", "Assets"], ["LIABILITY", "الخصوم", "Liabilities"], ["EQUITY", "حقوق الملكية", "Equity"], ["REVENUE", "الإيرادات", "Revenue"], ["EXPENSE", "المصروفات", "Expenses"]];
const CURRENCIES = ["USD", "EUR", "GBP", "AED", "KWD", "BHD", "QAR", "OMR", "EGP", "CNY"];

export function JournalEditor({ initial, entryId }: { initial?: EditorValue; entryId?: string }) {
  const { L } = useLang();
  const router = useRouter();
  const qoyod = useAccountantView();
  const dims = useApi<Dims>("/api/accounting/dimensions");
  const tpls = useApi<{ templates: Template[] }>("/api/accounting/deferrals/templates?active=1");
  const [v, setV] = useState<EditorValue>(() => {
    const base = initial ?? { entryDate: todayRiyadh(), description: "", lines: [blank(), blank()] };
    return { ...base, lines: base.lines.map((l) => ({ fxDebit: "", fxCredit: "", ...l, key: l.key ?? ++seq })) };
  });
  const [accountType, setAccountType] = useState("");
  const [location, setLocation] = useState("");
  const [currency, setCurrency] = useState("");
  const [rate, setRate] = useState("");
  const [order, setOrder] = useState<"original" | "debitFirst">("original");
  const [attachments, setAttachments] = useState<{ name: string; url: string }[]>(initial?.attachments ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defer, setDefer] = useState<{ templateId: string; lineNo: number; startDate: string } | null>(null);
  const manualAccounts = useMemo(() => (dims.data?.accounts ?? []).filter((a) => a.allowManualJournal), [dims.data]);
  const accountById = useMemo(() => new Map(manualAccounts.map((a) => [a.id, a])), [manualAccounts]);
  const dr = v.lines.reduce((s, l) => s + cents(l.debit), 0);
  const cr = v.lines.reduce((s, l) => s + cents(l.credit), 0);
  const fxDr = v.lines.reduce((s, l) => s + cents(l.fxDebit), 0);
  const fxCr = v.lines.reduce((s, l) => s + cents(l.fxCredit), 0);
  const balanced = dr === cr && dr > 0;
  const fxOn = !!currency && RATE.test(rate) && Number(rate) > 0;
  const set = (i: number, patch: Partial<EditorLine>) => setV((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const add = useCallback(() => setV((x) => ({ ...x, lines: [...x.lines, blank(location)] })), [location]);
  useShiftA(add);

  // «المدين ثم الدائن»: debit lines first (stable); «الترتيب الأصلي»: the order they were entered in. The saved order is
  // the one shown.
  const shown = useMemo(() => {
    const idx = v.lines.map((l, i) => ({ l, i }));
    if (order === "original") return idx;
    const side = (l: EditorLine) => (cents(l.debit) > 0 ? 0 : cents(l.credit) > 0 ? 1 : 2);
    return [...idx].sort((a, b) => side(a.l) - side(b.l) || a.i - b.i);
  }, [v.lines, order]);

  function setLocationAll(b: string) {
    // The header location fills the lines that have none (or the previous header value); a line's own location stays.
    setV((x) => ({ ...x, lines: x.lines.map((l) => (l.branchId && l.branchId !== location ? l : { ...l, branchId: b })) }));
    setLocation(b);
  }

  const deferCandidates = useMemo(() => {
    const t = (tpls.data?.templates ?? []).find((x) => x.id === defer?.templateId);
    if (!t?.balanceAccount) return [];
    return shown.map(({ l }, n) => ({ l, n: n + 1 })).filter(({ l }) => l.accountId === t.balanceAccount!.id && (cents(l.debit) > 0 || cents(l.credit) > 0));
  }, [tpls.data, defer?.templateId, shown]);

  async function save(mode: "draft" | "submit" | "defer") {
    setBusy(mode); setError(null);
    try {
      if (mode === "defer" && (!defer?.templateId || !deferCandidates.some((c) => c.n === defer.lineNo))) {
        throw new Error(L("اختر القالب وسطرًا على حساب الميزانية الخاص به (مصروف مدفوع مقدمًا أو إيراد مؤجل).", "Choose the template and a line on its balance-sheet account (prepaid expense or deferred revenue)."));
      }
      const lines = shown.map(({ l }) => l).filter((l) => l.accountId || l.debit || l.credit);
      const body = {
        entryDate: v.entryDate, description: v.description,
        lines: lines.map((l) => ({
          accountId: l.accountId, description: l.description || undefined, debit: l.debit || "0", credit: l.credit || "0",
          branchId: l.branchId || null, costCenterId: l.costCenterId || null, partyType: l.partyType || null, partyId: l.partyId || null,
        })),
        attachments: attachments.filter((a) => a.name.trim() && a.url.trim()),
      };
      const saved = entryId
        ? await acctFetch<{ id: string }>(`/api/accounting/journals/${entryId}`, { method: "PATCH", json: body })
        : await acctFetch<{ id: string }>("/api/accounting/journals", { method: "POST", json: body });
      if (mode !== "draft") await acctFetch(`/api/accounting/journals/${saved.id}/submit`, { method: "PATCH", json: {} });
      if (mode === "defer" && defer) {
        // The line's number among the SAVED lines (empty ones dropped) — the entry page finds it after posting.
        const savedNo = lines.indexOf(shown[defer.lineNo - 1].l) + 1;
        const intent: DeferIntent = { templateId: defer.templateId, lineNo: savedNo, startDate: defer.startDate || v.entryDate, description: v.description };
        try { localStorage.setItem(deferKey(saved.id), JSON.stringify(intent)); } catch { /* the entry page still offers it once posted */ }
        router.push(`/dashboard/accounting/journals/${saved.id}?defer=${encodeURIComponent(defer.templateId)}&line=${savedNo}&start=${encodeURIComponent(intent.startDate)}`);
        return;
      }
      router.push(`/dashboard/accounting/journals/${saved.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const name = (x: { nameAr: string | null; nameEn: string }) => L(x.nameAr ?? x.nameEn, x.nameEn);
  const accountsFor = (selected: string) => manualAccounts.filter((a) => !accountType || a.type === accountType || a.id === selected);
  const addLabel = qoyod ? L("إضافة المزيد", "Add more") : L("إضافة سطر", "Add line");
  const fxHead = currency ? ` · ${currency}` : "";
  const fxTitle = fxOn ? undefined : L("اختر العملة الأجنبية وسعر الصرف أولًا", "Choose the foreign currency and its rate first");
  return (
    <Section title={entryId ? L("تعديل القيد اليدوي", "Edit the manual journal") : qoyod ? L("إنشاء قيد يدوي", "Create a manual journal") : L("قيد يدوي جديد", "New manual journal")} testId="journal-editor" className="is-flush">
      <Msg error={error} onClose={() => setError(null)} />
      <FormHead>
        <FormField label={L("نوع الحساب", "Account type")} help={L("يحصر قائمة الحسابات في السطور", "Narrows the account list of the lines")} testId="je-account-type-field">
          <Select value={accountType} onChange={(e) => setAccountType(e.target.value)} aria-label={L("نوع الحساب", "Account type")} data-testid="je-account-type">
            {ACCOUNT_TYPES.map(([k, a, b]) => <option key={k} value={k}>{L(a, b)}</option>)}
          </Select>
        </FormField>
        <FormField label={L("الوصف", "Description")} required htmlFor="je-description" help={L("حتى 500 حرف", "Up to 500 characters")}>
          <input id="je-description" className="hr-input" maxLength={500} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} data-testid="je-description" aria-required="true" />
        </FormField>
        <FormField label={L("الموقع", "Location")} help={L("يُطبَّق على السطور؛ ويمكن تغييره لكل سطر", "Applied to the lines; each line can differ")}>
          <Select value={location} onChange={(e) => setLocationAll(e.target.value)} aria-label={L("الموقع", "Location")} placeholder={L("اختر الموقع", "Choose the location")} data-testid="je-location">
            <option value="">{L("اختر الموقع", "Choose the location")}</option>
            {(dims.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
          </Select>
        </FormField>
        <FormField label={L("التاريخ", "Date")} required htmlFor="je-date">
          <input id="je-date" type="date" className="hr-input" value={v.entryDate} onChange={(e) => setV({ ...v, entryDate: e.target.value })} data-testid="je-date" aria-required="true" />
        </FormField>
        <FormField label={L("العملة الأجنبية", "Foreign currency")} help={L("اختياري: أدخل المبلغ بالعملة الأجنبية فيُحسب بالريال بسعر الصرف؛ يُحفظ القيد بالريال.", "Optional: type the foreign amount and the riyal amount follows at the rate; the entry is kept in SAR.")}>
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label={L("العملة الأجنبية", "Foreign currency")} data-testid="je-currency">
            <option value="">{L("بدون — ريال سعودي فقط", "None — SAR only")}</option>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          {currency ? <input className="hr-input acct-amount qf-addon" style={{ maxWidth: 130 }} inputMode="decimal" dir="ltr" placeholder={L("سعر الصرف", "Rate")} aria-label={L(`سعر صرف ${currency} بالريال`, `${currency} rate in SAR`)} value={rate} aria-invalid={!!rate && !RATE.test(rate)} onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ""))} data-testid="je-rate" /> : null}
        </FormField>
      </FormHead>

      <div className="qf-lines-bar">
        <AddMore onClick={add} label={addLabel} testId="je-add-line" />
        <Seg value={order} onChange={setOrder} label={L("ترتيب السطور", "Line order")} testId="je-order" options={[{ value: "debitFirst", label: L("المدين ثم الدائن", "Debits first") }, { value: "original", label: L("الترتيب الأصلي", "Original order") }]} />
        <span className={`acct-balanced ${balanced ? "is-ok" : "is-bad"}`} data-testid="je-balance">
          {balanced ? L("● متوازن", "● Balanced") : L(`● غير متوازن · الفرق ${money(Math.abs(dr - cr) / 100)}`, `● Not balanced · difference ${money(Math.abs(dr - cr) / 100)}`)}
        </span>
      </div>
      <div className="hr-tablewrap" style={{ margin: "12px 16px 0" }}>
        <table className="hr-table acct-lines" data-testid="je-lines">
          <thead><tr>
            <th>#</th><th>{L("الحساب", "Account")}</th>
            <th className="num">{L("مدين بالعملة المحلية", "Debit (local)")}</th><th className="num">{L("دائن بالعملة المحلية", "Credit (local)")}</th>
            <th className="num">{L(`مدين بالعملة الأجنبية${fxHead}`, `Debit (foreign)${fxHead}`)}</th><th className="num">{L(`دائن بالعملة الأجنبية${fxHead}`, `Credit (foreign)${fxHead}`)}</th>
            <th>{L("التعليقات", "Comments")}</th><th className="acct-hide-m">{L("الموقع", "Location")}</th><th className="acct-hide-m">{L("مركز التكلفة", "Cost centre")}</th><th className="acct-hide-m">{L("الطرف", "Party")}</th>
            <th><span className="hr-sr">{L("حذف", "Remove")}</span></th>
          </tr></thead>
          <tbody>
            {shown.map(({ l, i }, n) => (
              <tr key={l.key ?? i} data-testid="je-line">
                <td className="hr-num">{n + 1}</td>
                <td style={{ minWidth: 220 }}>
                  <Select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} aria-label={L(`حساب السطر ${n + 1}`, `Line ${n + 1} account`)} placeholder={L("اختر الحساب", "Choose the account")} data-testid={`je-account-${i}`}>
                    <option value="">{L("اختر الحساب", "Choose the account")}</option>
                    {accountsFor(l.accountId).map((a) => <option key={a.id} value={a.id}>{`${a.code} · ${name(a)}`}</option>)}
                  </Select>
                </td>
                <td><input className="hr-input acct-amount" inputMode="decimal" dir="ltr" value={l.debit} aria-invalid={!!l.debit && !AMOUNT.test(l.debit)} onChange={(e) => set(i, { debit: e.target.value.replace(/[^\d.]/g, ""), fxDebit: "", ...(e.target.value ? { credit: "", fxCredit: "" } : {}) })} aria-label={L(`مدين السطر ${n + 1}`, `Line ${n + 1} debit`)} data-testid={`je-debit-${i}`} /></td>
                <td><input className="hr-input acct-amount" inputMode="decimal" dir="ltr" value={l.credit} aria-invalid={!!l.credit && !AMOUNT.test(l.credit)} onChange={(e) => set(i, { credit: e.target.value.replace(/[^\d.]/g, ""), fxCredit: "", ...(e.target.value ? { debit: "", fxDebit: "" } : {}) })} aria-label={L(`دائن السطر ${n + 1}`, `Line ${n + 1} credit`)} data-testid={`je-credit-${i}`} /></td>
                <td><input className="hr-input acct-amount" inputMode="decimal" dir="ltr" disabled={!fxOn} value={l.fxDebit ?? ""} onChange={(e) => { const fx = e.target.value.replace(/[^\d.]/g, ""); set(i, { fxDebit: fx, debit: atRate(fx, rate), ...(fx ? { credit: "", fxCredit: "" } : {}) }); }} aria-label={L(`مدين السطر ${n + 1} بالعملة الأجنبية`, `Line ${n + 1} foreign debit`)} title={fxTitle} data-testid={`je-fxdebit-${i}`} /></td>
                <td><input className="hr-input acct-amount" inputMode="decimal" dir="ltr" disabled={!fxOn} value={l.fxCredit ?? ""} onChange={(e) => { const fx = e.target.value.replace(/[^\d.]/g, ""); set(i, { fxCredit: fx, credit: atRate(fx, rate), ...(fx ? { debit: "", fxDebit: "" } : {}) }); }} aria-label={L(`دائن السطر ${n + 1} بالعملة الأجنبية`, `Line ${n + 1} foreign credit`)} title={fxTitle} data-testid={`je-fxcredit-${i}`} /></td>
                <td><input className="hr-input" value={l.description} onChange={(e) => set(i, { description: e.target.value })} aria-label={L(`تعليق السطر ${n + 1}`, `Line ${n + 1} comment`)} data-testid={`je-comment-${i}`} /></td>
                <td className="acct-hide-m">
                  <Select value={l.branchId} onChange={(e) => set(i, { branchId: e.target.value })} aria-label={L("الموقع", "Location")} placeholder="—">
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
                <td><button type="button" className="hr-btn is-ghost hr-iconbtn" aria-label={L(`حذف السطر ${n + 1}`, `Remove line ${n + 1}`)} disabled={v.lines.length <= 2} onClick={() => setV({ ...v, lines: v.lines.filter((_, j) => j !== i) })}>×</button></td>
              </tr>
            ))}
            <tr className="is-total">
              <td /><td>{L("الإجمالي", "Total")}</td>
              <td className="num hr-num" data-testid="je-total-debit">{money(dr / 100)}</td><td className="num hr-num" data-testid="je-total-credit">{money(cr / 100)}</td>
              <td className="num hr-num" data-testid="je-total-fxdebit">{fxOn ? money(fxDr / 100) : "—"}</td><td className="num hr-num">{fxOn ? money(fxCr / 100) : "—"}</td>
              <td colSpan={5} />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="acct-hint" style={{ padding: "8px 16px 0" }}>{L("حسابات المراقبة (الذمم، المخزون، الضريبة) لا تظهر في القائمة: تُرحَّل من دفاترها الفرعية فقط. يُقدَّم القيد للاعتماد ويعتمده شخص غير المُعدّ.", "Control accounts (receivables, inventory, VAT) are not listed: their sub-ledgers post them. A journal is submitted for approval and approved by someone other than its preparer.")}{fxOn ? L(` المبالغ بـ ${currency} مساعدة إدخال: يُحفظ القيد بالريال (حفظ العملة الأجنبية مع القيد يأتي مع «العملات الأجنبية»).`, ` ${currency} amounts are an entry aid: the entry is kept in SAR (keeping the foreign amount on the entry comes with «Foreign currencies»).`) : ""}</p>

      <div className="qf-collapses" style={{ marginTop: 12 }}>
        <Collapse title={L("المرفقات", "Attachments")} count={attachments.length ? `(${attachments.length})` : undefined} testId="je-attachments">
          {attachments.map((a, k) => (
            <div key={k} className="acct-row">
              <input className="hr-input" placeholder={L("اسم المرفق", "Attachment name")} aria-label={L("اسم المرفق", "Attachment name")} value={a.name} maxLength={200} onChange={(e) => setAttachments(attachments.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)))} />
              <input className="hr-input" dir="ltr" placeholder="https://…" aria-label={L("رابط المرفق", "Attachment link")} value={a.url} maxLength={1000} onChange={(e) => setAttachments(attachments.map((x, j) => (j === k ? { ...x, url: e.target.value } : x)))} aria-invalid={!!a.url && !/^https:\/\//.test(a.url)} />
              <button type="button" className="hr-btn is-ghost hr-iconbtn" aria-label={L("حذف المرفق", "Remove attachment")} onClick={() => setAttachments(attachments.filter((_, j) => j !== k))}>×</button>
            </div>
          ))}
          <div><button type="button" className="hr-btn is-sm" disabled={attachments.length >= 20} onClick={() => setAttachments([...attachments, { name: "", url: "" }])} data-testid="je-attach-add">+ {L("إضافة مرفق (رابط)", "Add an attachment (link)")}</button></div>
          <p className="acct-hint">{L("رابط https لكل مستند (فاتورة، عقد، كشف)؛ 20 مرفقًا على الأكثر.", "An https link per document (invoice, contract, statement); at most 20.")}</p>
        </Collapse>
        <Collapse title={L("معلومات إضافية", "Additional information")} testId="je-more">
          <dl className="acct-kv-grid">
            <div><dt>{L("نوع القيد", "Entry type")}</dt><dd>{L("يدوي", "Manual")}</dd></div>
            <div><dt>{L("العملة", "Currency")}</dt><dd>{L("ريال سعودي", "Saudi riyal")}{fxOn ? ` · ${currency} @ ${rate}` : ""}</dd></div>
            <div><dt>{L("السطور", "Lines")}</dt><dd className="hr-num">{v.lines.filter((l) => l.accountId).length}</dd></div>
          </dl>
        </Collapse>
      </div>

      {defer ? (
        <div className="acct-card" style={{ margin: "0 16px 12px" }} data-testid="je-defer-panel">
          <h3>{L("حفظ مع التأجيل", "Save with a deferral")}</h3>
          <p className="acct-hint">{L("يُحفظ القيد ويُقدَّم للاعتماد؛ وعند ترحيله يُنشأ جدول التأجيل من السطر المختار بنقرة واحدة في صفحة القيد (الجدول يرتبط بسطر قيد مرحّل فقط). السطر يكون على حساب الميزانية الخاص بالقالب.", "The entry is saved and submitted; once it is posted the deferral schedule is made from the chosen line in one click on the entry page (a schedule links to a posted journal line only). The line sits on the template's balance-sheet account.")}</p>
          <div className="acct-row">
            <label className="hr-field"><span className="hr-label">{L("قالب التأجيل", "Deferral template")}</span>
              <Select value={defer.templateId} onChange={(e) => setDefer({ ...defer, templateId: e.target.value, lineNo: 0 })} aria-label={L("قالب التأجيل", "Deferral template")} data-testid="je-defer-template">
                <option value="">{L("اختر القالب", "Choose the template")}</option>
                {(tpls.data?.templates ?? []).filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{`${L(t.nameAr, t.nameEn ?? t.nameAr)} · ${t.months} ${L("شهر", "months")}`}</option>)}
              </Select></label>
            <label className="hr-field"><span className="hr-label">{L("السطر", "Line")}</span>
              <Select value={defer.lineNo ? String(defer.lineNo) : ""} onChange={(e) => setDefer({ ...defer, lineNo: Number(e.target.value) })} aria-label={L("السطر", "Line")} data-testid="je-defer-line">
                <option value="">{deferCandidates.length ? L("اختر السطر", "Choose the line") : L("لا سطر على حساب القالب", "No line on the template's account")}</option>
                {deferCandidates.map(({ l, n }) => <option key={n} value={n}>{`#${n} · ${accountById.get(l.accountId)?.code ?? ""} · ${money((cents(l.debit) || cents(l.credit)) / 100)}`}</option>)}
              </Select></label>
            <label className="hr-field"><span className="hr-label">{L("بداية التأجيل", "Deferral start")}</span>
              <input type="date" className="hr-input" value={defer.startDate} onChange={(e) => setDefer({ ...defer, startDate: e.target.value })} data-testid="je-defer-start" /></label>
          </div>
          {tpls.data && !(tpls.data.templates ?? []).some((t) => t.isActive) ? <p className="acct-warn">{L("لا قوالب تأجيل نشطة: أنشئ قالبًا في «قوالب التأجيل».", "No active deferral templates: create one in «Deferral templates».")}</p> : null}
          <span className="acct-actions">
            <Btn variant="primary" disabled={!balanced || !!busy || !v.description.trim() || !defer.templateId || !defer.lineNo} busy={busy === "defer"} onClick={() => save("defer")} data-testid="je-defer-confirm">{L("حفظ وتقديم مع التأجيل", "Save and submit with the deferral")}</Btn>
            <Btn variant="ghost" onClick={() => setDefer(null)}>{L("رجوع", "Back")}</Btn>
          </span>
        </div>
      ) : null}

      <div className="qf-actions">
        <Btn variant="primary" busy={busy === "submit"} disabled={!balanced || !!busy} onClick={() => save("submit")} data-testid="je-submit">{qoyod ? L("حفظ", "Save") : L("حفظ وتقديم للاعتماد", "Save and submit")}</Btn>
        <Btn disabled={!balanced || !!busy} onClick={() => setDefer(defer ?? { templateId: "", lineNo: 0, startDate: v.entryDate })} data-testid="je-save-defer">{L("حفظ مع التأجيل", "Save with a deferral")}</Btn>
        <Btn variant="ghost" busy={busy === "draft"} disabled={!!busy} onClick={() => save("draft")} data-testid="je-save">{L("حفظ كمسودة", "Save as draft")}</Btn>
        <Btn variant="ghost" onClick={() => router.back()} data-testid="je-cancel">{L("إلغاء", "Cancel")}</Btn>
        <span className="qf-actions-note hr-num">{qoyod ? L("«حفظ» يقدّم القيد للاعتماد · ", "«Save» submits the entry for approval · ") : ""}{L("المدين", "Debit")} {money(dr / 100)} · {L("الدائن", "Credit")} {money(cr / 100)}</span>
      </div>
    </Section>
  );
}
