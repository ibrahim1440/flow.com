"use client";

// Figma: ACC-24 (bank → ledger mappings, start date, unposted lines) and ACC-25 (bank ↔ ledger
// reconciliation per cash account, every difference itemised). ?view=reconcile opens ACC-25;
// ?view=corrections opens ACC-28 (reversal-and-replacement of posted lines).
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, Badge, Button, Card, CardTitle, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../finance/_components/ui";
import { riyadhToday, useAmount, useCan, useDay, useExplain } from "../_components/kit";
import { Corrections } from "./corrections";

type Acc = { id: string; code: string; nameAr: string | null; nameEn: string; type: string; controlKind: string; allowPosting: boolean; isActive: boolean };
type Mappings = {
  settings: { bankPostingFrom: string | null; ledgerCutoverDate: string | null } | null;
  cash: { id: string; code: string; nameAr: string | null; nameEn: string; type: string; active: boolean; glAccountId: string | null; glAccount: { code: string; nameAr: string | null; nameEn: string } | null }[];
  categories: { id: string; code: string; nameAr: string | null; nameEn: string; kind: string; active: boolean; glAccountId: string | null; glAccount: { code: string; nameAr: string | null; nameEn: string; controlKind: string } | null }[];
  events: Record<string, number>;
};
type Recon = { asOf: string; bankPostingFrom: string | null; accounts: { cashAccount: { id: string; code: string; nameAr: string | null; nameEn: string }; glAccount: { code: string; nameAr: string | null; nameEn: string } | null; book: string; ledger: string | null; difference: string | null;
  items: { openingBalanceAndBeforeStart: string; notPosted: { id: string; date: string; amount: string; reference: string | null; description: string | null; reason: string }[]; manualJournalsAfterStart: { entryNo: number; date: string; description: string | null; amount: string }[] } }[] };

export default function BankPage() {
  const { L } = useL();
  const sp = useSearchParams();
  const router = useRouter();
  const v = sp.get("view");
  const back = () => router.push("/dashboard/accounting/bank");
  if (v === "corrections") return <Corrections onBack={back} />;
  return v === "reconcile" ? <Reconcile onBack={back} L={L} /> : <Mapping onReconcile={() => router.push("/dashboard/accounting/bank?view=reconcile")} onCorrections={() => router.push("/dashboard/accounting/bank?view=corrections")} />;
}

function Mapping({ onReconcile, onCorrections }: { onReconcile: () => void; onCorrections: () => void }) {
  const { L } = useL();
  const day = useDay();
  const amt = useAmount();
  const explain = useExplain();
  const { can } = useCan();
  const m = useApi<Mappings>("/api/accounting/bank");
  const accounts = useApi<Acc[]>("/api/accounting/coa");
  const recon = useApi<Recon>(`/api/accounting/reports/bank-reconciliation?asOf=${riyadhToday()}`);
  const [from, setFrom] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const edit = can("bank_posting_manage");
  if (m.error) return <ErrorState error={m.error} onRetry={m.reload} />;
  if (!m.data || !accounts.data) return <LoadingState />;
  const accName = (a: { code: string; nameAr: string | null; nameEn: string } | null) => (a ? `${a.code} · ${L(a.nameAr ?? a.nameEn, a.nameEn)}` : null);
  const cashGl = accounts.data.filter((a) => a.isActive && a.allowPosting && a.type === "ASSET" && a.controlKind === "CASH");
  const catGl = accounts.data.filter((a) => a.isActive && a.allowPosting && !["RECEIVABLE", "CUSTOMER_ADVANCES", "COMMISSION_PAYABLE", "INVENTORY", "CASH"].includes(a.controlKind));
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key); setMsg(null);
    try { await fn(); setMsg({ tone: "ok", text: ok }); m.reload(); recon.reload(); } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy("");
  };
  const ev = m.data.events;
  const start = m.data.settings?.bankPostingFrom?.slice(0, 10) ?? "";
  const notPosted = (recon.data?.accounts ?? []).flatMap((a) => a.items.notPosted.map((x) => ({ ...x, account: a.cashAccount.code })));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L("الترحيل البنكي إلى دفتر الأستاذ", "Bank posting to the ledger")} sub={L("الحركات المؤكدة والمراجَعة في وحدة المالية تُرحّل مرة واحدة من تاريخ البدء · قبله تبقى القيود اليدوية", "Confirmed and reviewed bank lines in Finance post once from the start date · before it, manual journals stay")}
          right={<div className="flex gap-2 flex-wrap"><Button onClick={onCorrections}>{L("تصحيح حركات مرحّلة", "Correct posted lines")}</Button><Button onClick={onReconcile}>{L("مطابقة البنك مع الأستاذ ←", "Bank ↔ ledger reconciliation →")}</Button></div>} />
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <Field label={L("تاريخ بدء الترحيل البنكي", "Bank posting start date")} hint={L("لا يتغير بعد أول ترحيل بنكي · من هذا التاريخ لا تُقبل قيود يدوية على الحسابات النقدية", "Fixed after the first bank posting · from this date, no manual journals on cash accounts")}>
            <div className="flex gap-2">
              <input type="date" className={INPUT} value={from ?? start} disabled={!edit} onChange={(e) => setFrom(e.target.value)} />
              {edit && <Button busy={busy === "from"} disabled={!from || from === start} onClick={() => run("from", () => api("/api/accounting/settings", { method: "PATCH", json: { bankPostingFrom: from } }), L("حُفظ تاريخ البدء", "Start date saved"))}>{L("حفظ", "Save")}</Button>}
            </div>
          </Field>
          <div className="flex gap-2 flex-wrap">
            <Badge tone="ok">{L(`مرحّلة ${ev.TRANSLATED ?? 0}`, `Posted ${ev.TRANSLATED ?? 0}`)}</Badge>
            <Badge tone={(ev.BLOCKED ?? 0) + (ev.FAILED ?? 0) ? "bad" : "info"}>{L(`محجوبة ${(ev.BLOCKED ?? 0) + (ev.FAILED ?? 0)}`, `Blocked ${(ev.BLOCKED ?? 0) + (ev.FAILED ?? 0)}`)}</Badge>
            <Badge tone="info">{L(`قبل البدء/مكرر ${ev.SKIPPED ?? 0}`, `Before start/duplicate ${ev.SKIPPED ?? 0}`)}</Badge>
          </div>
        </div>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle title={L("ربط فئات الميزانية", "Budget category mapping")} sub={L("الطرف المقابل لكل تقسيم في الحركة البنكية", "The counterpart of each split on a bank line")} />
          <Table>
            <thead><tr><Th>{L("الفئة", "Category")}</Th><Th>{L("حساب الأستاذ", "Ledger account")}</Th><Th>{L("ملاحظة", "Note")}</Th></tr></thead>
            <tbody>{m.data.categories.filter((c) => c.active).map((c) => (
              <tr key={c.id}>
                <Td>{L(c.nameAr ?? c.nameEn, c.nameEn)}<span className="block text-[11px] text-brown">{c.kind === "RECEIPT" ? L("قبض", "Receipt") : L("دفع", "Payment")} · {c.code}</span></Td>
                <Td className="min-w-[180px]">{edit
                  ? <select aria-label={L(`حساب الفئة ${c.code}`, `Account for ${c.code}`)} className={INPUT} value={c.glAccountId ?? ""} onChange={(e) => run(`c${c.id}`, () => api(`/api/accounting/bank/categories/${c.id}`, { method: "PUT", json: { accountId: e.target.value || null } }), L("حُفظ الربط", "Mapping saved"))}>
                      <option value="">{L("غير مربوطة", "Not mapped")}</option>{catGl.map((a) => <option key={a.id} value={a.id}>{accName(a)}</option>)}
                    </select>
                  : c.glAccount ? accName(c.glAccount) : <Badge tone="bad">{L("غير مربوطة", "Not mapped")}</Badge>}</Td>
                <Td className="text-xs text-brown">{c.glAccount?.controlKind === "PAYABLE" ? L("بقدر المطابقة مع فواتير مرحّلة", "Only as far as matched to posted bills") : c.kind === "RECEIPT" ? L("متحصلات العملاء تنتظر المرحلة 3", "Customer receipts wait for stage 3") : !c.glAccountId ? <span className="text-red-700 font-bold">{L("الحركات عليها محجوبة", "Its lines are blocked")}</span> : ""}</Td>
              </tr>
            ))}</tbody>
          </Table>
        </Card>
        <Card>
          <CardTitle title={L("ربط الحسابات النقدية", "Cash account mapping")} sub={L("لكل حساب بنكي أو صندوق حساب أستاذ نقدي واحد", "One cash ledger account per bank account or till")} />
          <Table>
            <thead><tr><Th>{L("الحساب النقدي", "Cash account")}</Th><Th>{L("حساب الأستاذ", "Ledger account")}</Th></tr></thead>
            <tbody>{m.data.cash.filter((c) => c.active).map((c) => (
              <tr key={c.id}>
                <Td>{L(c.nameAr ?? c.nameEn, c.nameEn)}<span className="block text-[11px] text-brown">{c.code} · {c.type === "BANK" ? L("بنك", "Bank") : c.type === "CASH" ? L("نقدي", "Cash") : L("وسيط دفع", "Gateway")}</span></Td>
                <Td className="min-w-[200px]">{edit
                  ? <select aria-label={L(`حساب الأستاذ لـ ${c.code}`, `Ledger account for ${c.code}`)} className={INPUT} value={c.glAccountId ?? ""} onChange={(e) => run(`a${c.id}`, () => api(`/api/accounting/bank/cash/${c.id}`, { method: "PUT", json: { accountId: e.target.value || null } }), L("حُفظ الربط", "Mapping saved"))}>
                      <option value="">{L("غير مربوط", "Not mapped")}</option>{cashGl.map((a) => <option key={a.id} value={a.id}>{accName(a)}</option>)}
                    </select>
                  : c.glAccount ? accName(c.glAccount) : <Badge tone="bad">{L("غير مربوط", "Not mapped")}</Badge>}</Td>
              </tr>
            ))}</tbody>
          </Table>
        </Card>
      </div>

      <Card>
        <CardTitle title={L("حركات بنكية لم تُرحّل", "Bank lines not posted")} sub={L("كل حركة مع سببها — تُعالج في وحدة المالية أو بالربط أعلاه ثم «تشغيل الترحيل»", "Each line with its reason — fix it in Finance or with the mappings above, then run posting")}
          right={can("events_process") ? <Button kind="primary" busy={busy === "run"} onClick={() => run("run", () => api("/api/accounting/events/process", { method: "POST", json: {} }), L("اكتمل تشغيل الترحيل", "Posting run finished"))}>{L("تشغيل الترحيل الآن", "Run posting now")}</Button> : undefined} />
        {!start ? <Notice tone="warn">{L("لم يُحدَّد تاريخ بدء الترحيل البنكي؛ لا تُرحّل أي حركة بنكية.", "No bank posting start date is set; no bank line posts.")}</Notice> : !recon.data ? <LoadingState /> : notPosted.length === 0 ? <Notice tone="ok">{L("كل الحركات المؤكدة منذ تاريخ البدء مرحّلة.", "Every confirmed line since the start date has posted.")}</Notice> : (
          <Table>
            <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("الحساب", "Account")}</Th><Th>{L("المرجع", "Reference")}</Th><Th>{L("البيان", "Description")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{L("السبب", "Reason")}</Th></tr></thead>
            <tbody>{notPosted.map((x) => (
              <tr key={x.id}>
                <Td className="whitespace-nowrap">{day(x.date)}</Td><Td>{x.account}</Td><Td className="tabular-nums">{x.reference ?? "—"}</Td><Td>{x.description ?? "—"}</Td>
                <Td num>{amt(x.amount)}</Td>
                <Td className={`text-xs ${/stage 3|needs review|pending/i.test(x.reason) ? "text-amber-800" : "text-red-700"}`}>{x.reason === "needs review in Finance" ? L("تحتاج تصنيفاً ومراجعة في وحدة المالية", "Needs classification and review in Finance") : explain(x.reason.replace(/^(blocked|failed|pending): /, ""))}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Reconcile({ onBack, L }: { onBack: () => void; L: (ar: string, en: string) => string }) {
  const day = useDay();
  const amt = useAmount();
  const explain = useExplain();
  const [asOf, setAsOf] = useState(riyadhToday);
  const r = useApi<Recon>(`/api/accounting/reports/bank-reconciliation?asOf=${asOf}`);
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <LoadingState />;
  const withDiff = r.data.accounts.filter((a) => a.difference !== null && Number(a.difference) !== 0);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L(`مطابقة البنك مع دفتر الأستاذ — كما في ${day(asOf)}`, `Bank ↔ ledger reconciliation — as of ${day(asOf)}`)} sub={L("رصيد دفتر البنك (وحدة المالية) مقابل رصيد حساب الأستاذ النقدي · كل فرق مفصّل", "Bank book (Finance) against the cash ledger account · every difference itemised")} right={<Button onClick={onBack}>{L("← العودة للربط", "← Back to mappings")}</Button>} />
        <Field label={L("كما في", "As of")}><input type="date" className={`${INPUT} max-w-[180px]`} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <Table>
          <thead><tr><Th>{L("الحساب النقدي", "Cash account")}</Th><Th>{L("حساب الأستاذ", "Ledger account")}</Th><Th num>{L("رصيد دفتر البنك", "Bank book")}</Th><Th num>{L("رصيد الأستاذ", "Ledger")}</Th><Th num>{L("الفرق", "Difference")}</Th><Th></Th></tr></thead>
          <tbody>{r.data.accounts.map((a) => {
            const n = a.items.notPosted.length + a.items.manualJournalsAfterStart.length;
            return (
              <tr key={a.cashAccount.id}>
                <Td>{L(a.cashAccount.nameAr ?? a.cashAccount.nameEn, a.cashAccount.nameEn)}</Td>
                <Td>{a.glAccount ? `${a.glAccount.code} · ${L(a.glAccount.nameAr ?? a.glAccount.nameEn, a.glAccount.nameEn)}` : <Badge tone="bad">{L("غير مربوط", "Not mapped")}</Badge>}</Td>
                <Td num>{amt(a.book)}</Td><Td num>{a.ledger === null ? "—" : amt(a.ledger)}</Td>
                <Td num className={a.difference && Number(a.difference) !== 0 ? "text-red-700 font-bold" : ""}>{a.difference === null ? "—" : amt(a.difference)}</Td>
                <Td>{a.difference === null ? null : Number(a.difference) === 0 ? <Badge tone="ok">✓ {L("مطابق", "Agrees")}</Badge> : <Badge tone="warn">{L(`${n} بنود مفصّلة`, `${n} items listed`)}</Badge>}</Td>
              </tr>
            );
          })}</tbody>
        </Table>
      </Card>
      {withDiff.map((a) => {
        const sum = [...a.items.notPosted.map((x) => Number(x.amount)), ...a.items.manualJournalsAfterStart.map((x) => -Number(x.amount))].reduce((s, v) => s + v, 0);
        const explained = Math.abs(sum - Number(a.difference)) < 0.005;
        return (
          <Card key={a.cashAccount.id}>
            <CardTitle title={L(`تفصيل الفرق — ${a.cashAccount.nameAr ?? a.cashAccount.nameEn}`, `Difference detail — ${a.cashAccount.nameEn}`)} sub={L("رصيد البنك − رصيد الأستاذ = مجموع البنود أدناه", "Bank book − ledger = the sum of the items below")} />
            <Table>
              <thead><tr><Th>{L("البند", "Item")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{L("الحالة", "Status")}</Th></tr></thead>
              <tbody>
                {a.items.notPosted.map((x) => <tr key={x.id}><Td>{L(`حركة ${x.reference ?? ""} — ${x.description ?? ""}`, `Line ${x.reference ?? ""} — ${x.description ?? ""}`)} <span className="text-[11px] text-brown">{day(x.date)}</span></Td><Td num>{amt(x.amount)}</Td><Td className="text-xs">{x.reason === "needs review in Finance" ? L("تحتاج مراجعة", "Needs review") : explain(x.reason.replace(/^(blocked|failed|pending): /, ""))}</Td></tr>)}
                {a.items.manualJournalsAfterStart.map((x) => <tr key={x.entryNo}><Td>{L(`قيد يدوي #${x.entryNo} على الحساب بعد بدء الترحيل`, `Manual journal #${x.entryNo} on the account after the start`)}</Td><Td num>{amt(String(-Number(x.amount)))}</Td><Td></Td></tr>)}
                <tr className="bg-cream-dark font-extrabold"><Td>{explained ? L("المجموع = الفرق ✓", "Total = difference ✓") : L("المجموع لا يساوي الفرق — راجع الرصيد الافتتاحي للحساب النقدي", "Total ≠ difference — check the cash account's opening balance")}</Td><Td num>{amt(sum.toFixed(2))}</Td><Td></Td></tr>
              </tbody>
            </Table>
          </Card>
        );
      })}
      <Notice tone="info">{L(`رصيد دفتر البنك = الرصيد الافتتاحي للحساب النقدي + الحركات المؤكدة. بدء الترحيل البنكي: ${r.data.bankPostingFrom ? day(r.data.bankPostingFrom) : "غير محدد"}.`, `Bank book = the cash account's opening balance + confirmed lines. Bank posting start: ${r.data.bankPostingFrom ? day(r.data.bankPostingFrom) : "not set"}.`)}</Notice>
    </div>
  );
}
