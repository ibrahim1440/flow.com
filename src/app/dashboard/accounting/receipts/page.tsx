"use client";

// «سندات العملاء» — the accountant's receipts (BATCH22 WP-D; owner answer 2). Sales records a collection; the accountant
// reviews it here and confirms it («تأكيد السند»: the database numbers the «سند قبض» RCT-YYYY-NNNNNN and the receipt posts to
// the chosen deposit account, applied to the chosen invoices), returns it for correction («إعادة للتصحيح», a reason) or
// rejects it. A receipt for an invoice with no deal («+ سند قبض») is recorded here and confirmed by a second person.
// Every rule is the API's: this page shows what it may do and why not.
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { OpsLoading, OpsEmpty, Btn, Notice } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { AcctShell, Msg, money, todayRiyadh, useApi, useLang, useWrite, type Setup } from "../_ui/shell";
import { DateRange, FilterCard, Section, ListFooter, ListPageSize, useFilters, usePaging } from "@/components/chrome";
import { UNASSIGNED_LOCATION, useLocationName, useLocations } from "../_ui/locations";

type Who = { id: string; name: string } | null;
type Row = {
  id: string; receiptNumber: string | null; status: string; source: string; amountGross: string; currency: string; paymentMethod: string; collectedAt: string;
  referenceNumber: string | null; note: string | null; submittedAt: string; decidedAt: string | null; decisionReason: string | null; decisionReasonCode: string | null;
  reversedAt: string | null; reversalReason: string | null; receiptMemo: string | null; sodBypass: boolean; branchId?: string | null;
  submittedBy: { id: string; name: string }; decidedBy: Who;
  customer: { id: string; name: string; nameAr: string | null } | null; opportunity: { id: string; title: string } | null;
  quote: { quoteNumber: string } | null; invoice: { id: string; number: string | null } | null;
  depositAccount: { code: string; nameAr: string | null; nameEn: string } | null;
  correctedBy: { id: string; status: string } | null; _count: { evidence: number };
  ageDays: number | null; tone: "ok" | "amber" | "red" | null;
  can: { confirm: boolean; reject: boolean; reverse: boolean; selfRecorded: boolean };
};
type List = { view: string; rows: Row[]; counts: Record<string, number>; totals: Record<string, string>; can: { confirm: boolean; reject: boolean; reverse: boolean; record: boolean; editVoucher: boolean; allowSelfApproval: boolean } };
type Detail = {
  receipt: Row & { arApplications: { id: string; amount: string; appliedDate: string; invoice: { id: string; number: string | null } }[]; evidence: { id: string; filename: string }[]; order: { orderNumber: number } | null };
  open: { id: string; number: string; issueDate: string; dueDate: string | null; total: string; open: string; ofOrder: boolean; own: boolean }[];
  proposal: { invoiceId: string; amount: string }[];
  deposit: { accounts: { id: string; code: string; nameAr: string | null; nameEn: string; controlType: string | null }[]; byMethod: Record<string, string | null> } | null;
  entries: { id: string; status: string; sourceEvent: string; type: string }[];
  can: { confirm: boolean; reject: boolean; reverse: boolean; editVoucher: boolean; selfRecorded: boolean; selfWouldBypass: boolean; selfConfirm?: "ALLOWED" | "NEEDS_OTHER" | null };
};
type Eligible = { invoices: { id: string; number: string; issueDate: string; dueDate: string | null; total: string; open: string; currency: string; customer: { id: string; name: string; nameAr: string | null }; openDeal: { id: string; title: string } | null }[] };

const METHOD: Record<string, [string, string]> = { BANK_TRANSFER: ["تحويل بنكي", "Bank transfer"], CASH: ["نقدًا", "Cash"], CHEQUE: ["شيك", "Cheque"], POS_CARD: ["بطاقة (مدى)", "Card (mada)"], OTHER: ["أخرى", "Other"] };
const VIEWS: [string, string, string][] = [["pending", "بانتظار التأكيد", "Awaiting confirmation"], ["confirmed", "سندات القبض", "Receipts"], ["returned", "معادة للتصحيح", "Returned"], ["rejected", "مرفوضة", "Rejected"], ["reversed", "معكوسة", "Reversed"], ["all", "الكل", "All"]];
const day = (s: string | null | undefined) => (s ? new Date(new Date(s).getTime() + 3 * 3600_000).toISOString().slice(0, 10) : "");
const key = () => `rct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function StatusChip({ r }: { r: Row }) {
  const { L } = useLang();
  const [ar, en, tone] = r.status === "PENDING_VERIFICATION" ? ["بانتظار التأكيد", "Awaiting confirmation", "warning"]
    : r.status === "APPROVED" ? ["مؤكد", "Confirmed", "success"]
    : r.status === "REVERSED" ? ["معكوس", "Reversed", "cancelled"]
    : r.decisionReasonCode === "RETURN_FOR_CORRECTION" ? ["أُعيد للتصحيح", "Returned for correction", "info"] : ["مرفوض", "Rejected", "danger"];
  return <span className={`hr-dot tone-${tone}`} data-testid={`rct-status-${r.id}`}><span>{L(ar, en)}</span></span>;
}

function AgeChip({ r }: { r: Row }) {
  const { L } = useLang();
  if (r.ageDays === null) return <span className="hr-caption">—</span>;
  const tone = r.tone === "red" ? "danger" : r.tone === "amber" ? "warning" : "neutral";
  return <span className={`hr-dot tone-${tone}`} title={L("أيام عمل (الجمعة والسبت عطلة)", "Business days (Friday and Saturday off)")}><span>{L(`${r.ageDays} يوم عمل`, `${r.ageDays} business days`)}</span></span>;
}

function Receipts() {
  const { L, ar } = useLang();
  const router = useRouter();
  const sp = useSearchParams();
  const setup = useApi<Setup>("/api/accounting/setup");
  const [view, setView] = useState(sp.get("view") ?? "pending");
  const f = useFilters({ q: "", from: "", to: "" });
  const a = f.applied;
  const qs = new URLSearchParams({ view, ...(a.q ? { q: a.q } : {}), ...(a.from ? { from: a.from } : {}), ...(a.to ? { to: a.to } : {}) });
  const list = useApi<List>(`/api/accounting/receipts?${qs}`);
  const { pageRows, pager } = usePaging(list.data?.rows ?? []);
  const [openId, setOpenId] = useState<string | null>(sp.get("id"));
  const [creating, setCreating] = useState(sp.get("new") === "1");
  const w = useWrite();
  const cust = (c: Row["customer"]) => (c ? (ar ? c.nameAr || c.name : c.name) : "—");
  const close = () => { setOpenId(null); setCreating(false); router.replace("/dashboard/accounting/receipts"); list.reload(); };

  const newBtn = list.data?.can.record ? <Btn variant="primary" onClick={() => setCreating(true)} data-testid="rct-new">+ {L("سند قبض", "Receipt")}</Btn> : undefined;
  return (
    <AcctShell setup={setup.data} title={L("سندات العملاء", "Customer receipts")} actions={newBtn}>
      <Msg error={w.error ?? list.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <p className="acct-scope">{L("تسجّل المبيعات التحصيل وتراجعه أنت: «تأكيد السند» يعطيه رقم «سند قبض» ويرحّله إلى حساب الإيداع الذي تختاره. لا يُعدَّل المبلغ ولا التاريخ ولا الطريقة ولا الصفقة — هذه أساس العمولة؛ أعِده للمندوب للتصحيح بسبب واضح.", "Sales records the collection and you review it: «Confirm» gives it a receipt number and posts it to the deposit account you choose. The amount, date, method and deal are never edited — they are the commission basis; return it to the rep with a clear reason.")}</p>
      <nav className="hr-tabs is-underline" role="tablist" aria-label={L("حالات السندات", "Receipt states")} data-testid="rct-views">
        {VIEWS.map(([k, ta, te]) => (
          <button key={k} type="button" role="tab" className="hr-tab" aria-selected={view === k} onClick={() => setView(k)} data-testid={`rct-view-${k}`}>
            {L(ta, te)}{list.data?.counts[k] ? <span className="hr-count">{list.data.counts[k]}</span> : null}
          </button>
        ))}
      </nav>
      <FilterCard onApply={f.apply} onReset={f.reset} busy={list.loading} testId="rct-filter">
        <div className="qc-field"><label className="qc-label" htmlFor="rct-q">{L("بحث", "Search")}</label>
          <input id="rct-q" className="hr-input" placeholder={L("رقم السند، المرجع، العميل، الفاتورة", "Receipt no., reference, customer, invoice")} value={f.draft.q} onChange={(e) => f.set("q", e.target.value)} /></div>
        <DateRange from={f.draft.from} to={f.draft.to} onChange={(r) => f.setDraft({ ...f.draft, ...r })} label={L("تاريخ التحصيل", "Collected")} />
      </FilterCard>
      {!list.data ? <OpsLoading /> : list.data.rows.length === 0 ? (
        <OpsEmpty title={a.q || a.from || a.to ? L("لا نتائج لهذا البحث", "No results for this search") : view === "pending" ? L("لا سندات بانتظار التأكيد", "No receipt awaits confirmation") : L("لا سندات في هذه الحالة", "No receipt in this state")}
          body={a.q || a.from || a.to ? L("غيّر البحث أو أعد تعيين الفلاتر.", "Change the search or reset the filters.") : L("ما تسجّله المبيعات من تحصيلات يظهر هنا لتأكيده.", "Collections Sales records appear here for you to confirm.")} />
      ) : (
        <Section title={L(VIEWS.find((v) => v[0] === view)?.[1] ?? "", VIEWS.find((v) => v[0] === view)?.[2] ?? "")} testId="rct-section">
          <ListPageSize {...pager} />
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="rct-list">
              <thead><tr>
                <th>{L("رقم السند", "Receipt no.")}</th><th>{L("العميل", "Customer")}</th><th className="acct-hide-m">{L("مقابل", "Against")}</th>
                <th className="num">{L("المبلغ", "Amount")}</th><th className="acct-hide-m">{L("الطريقة", "Method")}</th><th className="acct-hide-m">{L("تاريخ التحصيل", "Collected")}</th>
                <th className="acct-hide-m">{L("سجّله", "Recorded by")}</th><th>{view === "pending" ? L("العمر", "Age") : L("الحالة", "Status")}</th><th></th>
              </tr></thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.id} data-testid={`rct-row-${r.id}`}>
                    <td>{r.receiptNumber ? <bdi dir="ltr" className="acct-code">{r.receiptNumber}</bdi> : <span className="hr-caption">{L("يُعطى الرقم عند التأكيد", "Numbered at confirmation")}</span>}</td>
                    <td>{cust(r.customer)}</td>
                    <td className="acct-hide-m">{r.source === "ACCOUNTANT" ? <>{L("فاتورة", "Invoice")} <bdi dir="ltr" className="acct-code">{r.invoice?.number}</bdi></> : <>{r.opportunity?.title}{r.quote ? <span className="hr-caption"> · <bdi dir="ltr">{r.quote.quoteNumber}</bdi></span> : null}</>}</td>
                    <td className="num hr-num">{money(r.amountGross)} <span className="hr-caption">{L("ر.س", "SAR")}</span></td>
                    <td className="acct-hide-m">{L(METHOD[r.paymentMethod]?.[0] ?? r.paymentMethod, METHOD[r.paymentMethod]?.[1] ?? r.paymentMethod)}</td>
                    <td className="acct-hide-m hr-num">{day(r.collectedAt)}</td>
                    <td className="acct-hide-m">{r.submittedBy.name}</td>
                    <td>{view === "pending" ? <AgeChip r={r} /> : <StatusChip r={r} />}</td>
                    <td><Btn size="sm" variant={r.can.confirm ? "primary" : "ghost"} onClick={() => setOpenId(r.id)} data-testid={`rct-open-${r.id}`}>{r.can.confirm ? L("مراجعة", "Review") : L("عرض", "View")}</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListFooter {...pager} noun={L("سند", "receipts")} emptyText={L("لا توجد سندات", "No receipts")} />
        </Section>
      )}
      {openId ? <ReceiptDrawer id={openId} onClose={close} /> : null}
      {creating ? <NewReceipt onClose={close} onCreated={(id) => { setCreating(false); setOpenId(id); list.reload(); }} /> : null}
    </AcctShell>
  );
}

function ReceiptDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { L, ar } = useLang();
  const d = useApi<Detail>(`/api/accounting/receipts/${id}`);
  const w = useWrite();
  const [deposit, setDeposit] = useState<string | null>(null);
  const [memo, setMemo] = useState("");
  // «الموقع» (WP-B): null = keep the recorded one; "none" = «غير محدد».
  const [branch, setBranch] = useState<string | null>(null);
  const branches = useLocations();
  const locName = useLocationName();
  const [alloc, setAlloc] = useState<Record<string, string> | null>(null);
  const [mode, setMode] = useState<"view" | "return" | "reject" | "reverse">("view");
  const [reason, setReason] = useState("");
  const r = d.data?.receipt;
  // The defaults until the accountant changes them: the method's deposit account and the proposed allocation (its own
  // invoice, its order's, then the oldest).
  const depositValue = deposit ?? (d.data ? d.data.deposit?.byMethod[d.data.receipt.paymentMethod] ?? "" : "");
  const allocValue = useMemo(() => alloc ?? (d.data ? Object.fromEntries(d.data.proposal.map((p) => [p.invoiceId, p.amount])) : {}), [alloc, d.data]);
  const allocated = useMemo(() => Object.values(allocValue).reduce((s, v) => s + (Number(v) || 0), 0), [allocValue]);
  const amount = Number(r?.amountGross ?? 0);
  const over = allocated > amount + 0.001;
  const cust = r?.customer ? (ar ? r.customer.nameAr || r.customer.name : r.customer.name) : "—";

  async function act(action: string, extra: Record<string, unknown> = {}, ok?: string) {
    const res = await w.run<{ receiptNumber?: string | null }>(action, `/api/sales/collections/${id}/actions`, "POST", { action, ...extra }, ok);
    if (res) { d.reload(); setMode("view"); setReason(""); }
  }
  const confirm = () => act("approve", {
    ...(d.data?.can.editVoucher ? { ...(depositValue ? { depositAccountId: depositValue } : {}), ...(memo.trim() ? { memo } : {}), ...(branch !== null ? { branchId: branch === UNASSIGNED_LOCATION ? null : branch } : {}), allocation: Object.entries(allocValue).filter(([, v]) => Number(v) > 0).map(([invoiceId, v]) => ({ invoiceId, amount: Number(v).toFixed(2) })) } : {}),
  }, L("أُكّد السند وأُعطي رقم سند القبض.", "Confirmed: the receipt is numbered."));

  const footer = !r ? null : mode !== "view" ? (
    <><Btn onClick={() => { setMode("view"); setReason(""); }}>{L("رجوع", "Back")}</Btn>
      <Btn variant="danger" busy={!!w.busy} disabled={reason.trim().length < (mode === "return" ? 10 : 3)} data-testid="rct-reason-submit"
        onClick={() => act(mode === "reject" ? "reject" : mode === "return" ? "return" : "reverse", { reason }, mode === "return" ? L("أُعيد السند للمندوب للتصحيح.", "Returned to the rep for correction.") : mode === "reject" ? L("رُفض السند.", "Rejected.") : L("عُكس السند وقيده.", "Reversed with its entry."))}>
        {mode === "return" ? L("إعادة للتصحيح", "Return for correction") : mode === "reject" ? L("رفض", "Reject") : L("عكس السند", "Reverse")}</Btn></>
  ) : (
    <><Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn>
      {r.status === "APPROVED" && r.receiptNumber ? <Link className="hr-btn is-ghost" href={`/dashboard/accounting/receipts/${id}/print`} data-testid="rct-print">{L("طباعة سند القبض", "Print receipt")}</Link> : null}
      {d.data?.can.reverse ? <Btn variant="ghost" onClick={() => setMode("reverse")} data-testid="rct-reverse">{L("عكس", "Reverse")}</Btn> : null}
      {d.data?.can.reject ? <Btn variant="ghost" onClick={() => setMode("reject")} data-testid="rct-reject">{L("رفض", "Reject")}</Btn> : null}
      {d.data?.can.reject ? <Btn onClick={() => setMode("return")} data-testid="rct-return">{L("إعادة للتصحيح", "Return for correction")}</Btn> : null}
      {d.data?.can.confirm ? <Btn variant="primary" busy={w.busy === "approve"} disabled={over} onClick={confirm} data-testid="rct-confirm">{L("تأكيد السند", "Confirm receipt")}</Btn> : null}</>
  );

  return (
    <Dialog open title={r?.receiptNumber ? `${L("سند قبض", "Receipt")} ${r.receiptNumber}` : L("مراجعة التحصيل", "Review collection")} onClose={onClose} actions={footer}>
      <Msg error={w.error ?? d.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!r ? <OpsLoading /> : (
        <div className="hr-stack" data-testid="rct-drawer">
          <dl className="hr-kv">
            <div><dt>{L("الحالة", "Status")}</dt><dd><StatusChip r={r} /></dd></div>
            <div><dt>{L("رقم السند", "Receipt no.")}</dt><dd data-testid="rct-number">{r.receiptNumber ? <bdi dir="ltr">{r.receiptNumber}</bdi> : L("يُعطى الرقم عند التأكيد", "Numbered at confirmation")}</dd></div>
            <div><dt>{L("العميل", "Customer")}</dt><dd>{cust}</dd></div>
            <div><dt>{L("المبلغ", "Amount")}</dt><dd className="hr-num">{money(r.amountGross)} {L("ر.س", "SAR")} <span className="hr-caption">{L("شامل الضريبة", "incl. VAT")}</span></dd></div>
            <div><dt>{L("تاريخ التحصيل", "Collected on")}</dt><dd className="hr-num">{day(r.collectedAt)}</dd></div>
            <div><dt>{L("الطريقة", "Method")}</dt><dd>{L(METHOD[r.paymentMethod]?.[0] ?? r.paymentMethod, METHOD[r.paymentMethod]?.[1] ?? r.paymentMethod)}{r.referenceNumber ? <> · <bdi dir="ltr">{r.referenceNumber}</bdi></> : null}</dd></div>
            <div><dt>{L("مقابل", "Against")}</dt><dd>{r.source === "ACCOUNTANT" ? <>{L("فاتورة بلا صفقة", "Invoice with no deal")} <bdi dir="ltr">{r.invoice?.number}</bdi> · {L("بلا عمولة", "no commission")}</> : <>{r.opportunity?.title}{r.quote ? <> · <bdi dir="ltr">{r.quote.quoteNumber}</bdi></> : null}</>}</dd></div>
            <div><dt>{L("سجّله", "Recorded by")}</dt><dd>{r.submittedBy.name} · <span className="hr-num">{day(r.submittedAt)}</span></dd></div>
            {r.decidedBy ? <div><dt>{r.status === "APPROVED" || r.status === "REVERSED" ? L("أكّده", "Confirmed by") : L("قرّره", "Decided by")}</dt><dd>{r.decidedBy.name} · <span className="hr-num">{day(r.decidedAt)}</span>{r.sodBypass ? <span className="hr-caption"> · {L("استثناء فصل المهام", "SoD exception")}</span> : null}</dd></div> : null}
            {r.depositAccount ? <div><dt>{L("حساب الإيداع", "Deposit account")}</dt><dd><bdi dir="ltr" className="acct-code">{r.depositAccount.code}</bdi> {L(r.depositAccount.nameAr || r.depositAccount.nameEn, r.depositAccount.nameEn)}</dd></div> : null}
            {r.status !== "PENDING_VERIFICATION" ? <div><dt>{L("الموقع", "Location")}</dt><dd data-testid="rct-location-view">{locName(r.branchId)}</dd></div> : null}
            {r.receiptMemo ? <div><dt>{L("الوصف", "Description")}</dt><dd>{r.receiptMemo}</dd></div> : null}
            {r.note ? <div><dt>{L("ملاحظة المندوب", "Rep's note")}</dt><dd>{r.note}</dd></div> : null}
            {r.decisionReason ? <div><dt>{L("السبب", "Reason")}</dt><dd>{r.decisionReason}</dd></div> : null}
            {r.reversalReason ? <div><dt>{L("سبب العكس", "Reversal reason")}</dt><dd>{r.reversalReason}</dd></div> : null}
            <div><dt>{L("المرفقات", "Evidence")}</dt><dd>{r.evidence.length ? r.evidence.map((e) => e.filename).join(" ، ") : L("لا مرفقات", "None")}</dd></div>
          </dl>
          {/* Four-eyes (owner rule 2026-10-29): self-confirmation only while no other accountant may confirm. */}
          {r.status === "PENDING_VERIFICATION" && d.data?.can.selfRecorded && (d.data.can.selfConfirm === "NEEDS_OTHER" || (!d.data.can.selfConfirm && !d.data.can.confirm)) ? <Notice tone="info"><span data-testid="rct-needs-other">{L("يحتاج تأكيد شخص آخر", "Needs another person to confirm")}</span></Notice> : null}
          {r.status === "PENDING_VERIFICATION" && d.data?.can.selfConfirm === "ALLOWED" && d.data.can.confirm ? <Notice tone="warning"><span data-testid="rct-self-confirm">{L("تأكيد ذاتي (محاسب واحد) — يُسجَّل في استثناءات فصل المهام", "Self-confirmation (one accountant) — listed in the SoD exceptions")}</span></Notice> : null}
          {mode !== "view" ? (
            <label className="hr-field"><span className="hr-label">{mode === "return" ? L("سبب الإعادة (يراه المندوب) — 10 أحرف على الأقل", "Reason (the rep sees it) — at least 10 characters") : L("السبب", "Reason")}</span>
              <textarea className="hr-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="rct-reason" /></label>
          ) : d.data?.can.confirm && d.data.can.editVoucher ? (
            <>
              <label className="hr-field"><span className="hr-label">{L("حساب الإيداع", "Deposit account")}</span>
                <Select value={depositValue} onChange={(e) => setDeposit(e.target.value)} data-testid="rct-deposit">
                  <option value="">{L("حسب الطريقة (الافتراضي)", "By method (default)")}</option>
                  {(d.data.deposit?.accounts ?? []).map((x) => <option key={x.id} value={x.id}>{x.code} · {L(x.nameAr || x.nameEn, x.nameEn)}</option>)}
                </Select>
                {!d.data.deposit?.accounts.length ? <span className="hr-caption">{L("لا دليل حسابات بعد — يُرحَّل السند عند تفعيل المحاسبة.", "No chart of accounts yet — the receipt posts once accounting is active.")}</span> : null}
              </label>
              {branches.length ? (
                <label className="hr-field"><span className="hr-label">{L("الموقع", "Location")}</span>
                  <Select value={branch ?? r.branchId ?? ""} onChange={(e) => setBranch(e.target.value)} data-testid="rct-location">
                    {!r.branchId ? <option value="">{L("الافتراضي (موقع الفواتير)", "Default (the invoices' location)")}</option> : null}
                    {branches.map((b) => <option key={b.id} value={b.id}>{L(b.nameAr, b.nameEn)}</option>)}
                    <option value={UNASSIGNED_LOCATION}>{L("غير محدد", "Unassigned")}</option>
                  </Select></label>
              ) : null}
              <label className="hr-field"><span className="hr-label">{L("الوصف", "Description")}</span>
                <input className="hr-input" maxLength={500} value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="rct-memo" /></label>
              <div>
                <span className="hr-label">{L("التخصيص على الفواتير", "Applied to invoices")}</span>
                {d.data.open.length ? (
                  <table className="hr-table is-dense" data-testid="rct-alloc">
                    <thead><tr><th>{L("الفاتورة", "Invoice")}</th><th className="acct-hide-m">{L("الاستحقاق", "Due")}</th><th className="num">{L("المتبقي", "Open")}</th><th className="num">{L("المخصص", "Apply")}</th></tr></thead>
                    <tbody>{d.data.open.map((o) => (
                      <tr key={o.id}><td><bdi dir="ltr" className="acct-code">{o.number}</bdi>{o.own ? <span className="hr-caption"> · {L("فاتورة السند", "this receipt's")}</span> : o.ofOrder ? <span className="hr-caption"> · {L("من الطلب", "of the order")}</span> : null}</td>
                        <td className="acct-hide-m hr-num">{o.dueDate ?? o.issueDate}</td><td className="num hr-num">{money(o.open)}</td>
                        <td className="num"><input className="hr-input acct-amount" style={{ width: 110 }} inputMode="decimal" aria-label={L(`المخصص على ${o.number}`, `Apply to ${o.number}`)} value={allocValue[o.id] ?? ""} onChange={(e) => setAlloc({ ...allocValue, [o.id]: e.target.value })} data-testid={`rct-alloc-${o.number}`} /></td></tr>
                    ))}</tbody>
                  </table>
                ) : <p className="hr-caption">{L("لا فواتير مفتوحة للعميل — يبقى المبلغ رصيدًا دائنًا له (دفعة مقدمة).", "No open invoice — the amount stays the customer's credit (an advance).")}</p>}
                <p className={over ? "hr-caption tone-danger" : "hr-caption"} data-testid="rct-alloc-total">{L(`المخصص ${money(allocated)} من ${money(amount)} ر.س؛ الباقي ${money(Math.max(amount - allocated, 0))} رصيد دائن للعميل.`, `Applied ${money(allocated)} of SAR ${money(amount)}; the rest ${money(Math.max(amount - allocated, 0))} stays the customer's credit.`)}{over ? ` ${L("المخصص أكبر من المبلغ.", "More than the amount.")}` : ""}</p>
              </div>
            </>
          ) : r.arApplications.length ? (
            <div><span className="hr-label">{L("خُصص على", "Applied to")}</span>
              <ul className="hr-stack" style={{ margin: 0, paddingInlineStart: 18 }}>{r.arApplications.map((x) => <li key={x.id}><bdi dir="ltr" className="acct-code">{x.invoice.number}</bdi> · <span className="hr-num">{money(x.amount)}</span></li>)}</ul></div>
          ) : null}
          {d.data?.entries.length ? <p className="hr-caption">{L("القيود:", "Entries:")} {d.data.entries.map((e) => <Link key={e.id} href={`/dashboard/accounting/journals/${e.id}`} className="acct-code">{e.sourceEvent === "RECEIVED" ? L("قيد سند القبض", "Receipt entry") : e.sourceEvent.startsWith("APPLIED") ? L("قيد تخصيص", "Application entry") : L("قيد إلغاء تخصيص", "Unapplication entry")}{e.status === "REVERSED" ? ` (${L("معكوس", "reversed")})` : ""} </Link>)}</p>
            : r.status === "APPROVED" ? <p className="hr-caption">{L("لم يُرحَّل قيد: المحاسبة غير مفعّلة بعد أو التاريخ قبل بدء التشغيل (الرصيد الافتتاحي يشمله).", "No entry: accounting is not active yet, or the date is before go-live (the opening balances hold it).")}</p> : null}
        </div>
      )}
    </Dialog>
  );
}

function NewReceipt({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { L, ar } = useLang();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const el = useApi<Eligible>(`/api/accounting/receipts/eligible${search ? `?q=${encodeURIComponent(search)}` : ""}`);
  const w = useWrite();
  const [form, setForm] = useState({ invoiceId: "", amountGross: "", collectedAt: todayRiyadh(), paymentMethod: "BANK_TRANSFER", referenceNumber: "", note: "" });
  const [idem] = useState(key);
  const picked = el.data?.invoices.find((i) => i.id === form.invoiceId) ?? null;
  async function save() {
    const r = await w.run<{ collectionId: string }>("save", "/api/accounting/receipts", "POST", { ...form, idempotencyKey: idem }, L("سُجّل السند وينتظر تأكيد شخص آخر.", "Recorded; it awaits another person's confirmation."));
    if (r) onCreated(r.collectionId);
  }
  return (
    <Dialog open title={L("سند قبض لفاتورة بلا صفقة", "Receipt for an invoice with no deal")} onClose={onClose}
      actions={<><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn><Btn variant="primary" busy={w.busy === "save"} disabled={!picked || !!picked.openDeal || !(Number(form.amountGross) > 0)} onClick={save} data-testid="rct-new-save">{L("حفظ وإرسال للتأكيد", "Save and send for confirmation")}</Btn></>}>
      <Msg error={w.error ?? el.error} />
      <div className="hr-stack" data-testid="rct-new-form">
        <p className="hr-caption">{L("لفواتير لا صفقة خلفها (يدوية أو متكررة) ولعميل بلا صفقة مفتوحة. لا عمولة عليه، ويؤكده شخص آخر.", "For invoices with no deal behind them (manual or recurring), for a customer with no open deal. No commission; another person confirms it.")}</p>
        <form role="search" className="acct-row" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
          <label className="hr-field"><span className="hr-label">{L("ابحث عن الفاتورة", "Find the invoice")}</span><input className="hr-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("رقم الفاتورة أو العميل", "Invoice no. or customer")} data-testid="rct-new-q" /></label>
          <Btn type="submit">{L("بحث", "Search")}</Btn>
        </form>
        <label className="hr-field"><span className="hr-label">{L("الفاتورة", "Invoice")}</span>
          <Select value={form.invoiceId} onChange={(e) => { const i = el.data?.invoices.find((x) => x.id === e.target.value); setForm({ ...form, invoiceId: e.target.value, amountGross: i ? i.open : form.amountGross }); }} data-testid="rct-new-invoice">
            <option value="">{el.loading ? L("جارٍ التحميل…", "Loading…") : L("اختر الفاتورة", "Choose the invoice")}</option>
            {(el.data?.invoices ?? []).map((i) => <option key={i.id} value={i.id}>{i.number} · {ar ? i.customer.nameAr || i.customer.name : i.customer.name} · {L("المتبقي", "open")} {money(i.open)}</option>)}
          </Select></label>
        {picked?.openDeal ? <Notice tone="warning"><span data-testid="rct-new-open-deal">{L(`للعميل صفقة مفتوحة («${picked.openDeal.title}») — يسجّل المندوب التحصيل على الصفقة.`, `The customer has an open deal ("${picked.openDeal.title}") — the rep records the collection on the deal.`)}</span></Notice> : null}
        <div className="acct-row">
          <label className="hr-field"><span className="hr-label">{L("المبلغ (شامل الضريبة) ر.س", "Amount (incl. VAT) SAR")}</span><input className="hr-input" inputMode="decimal" dir="ltr" value={form.amountGross} onChange={(e) => setForm({ ...form, amountGross: e.target.value })} data-testid="rct-new-amount" /></label>
          <label className="hr-field"><span className="hr-label">{L("تاريخ التحصيل", "Collected on")}</span><input type="date" className="hr-input" value={form.collectedAt} max={todayRiyadh()} onChange={(e) => setForm({ ...form, collectedAt: e.target.value })} /></label>
          <label className="hr-field"><span className="hr-label">{L("الطريقة", "Method")}</span><Select value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}>{Object.entries(METHOD).map(([k, [a, e]]) => <option key={k} value={k}>{L(a, e)}</option>)}</Select></label>
        </div>
        <label className="hr-field"><span className="hr-label">{L("مرجع الدافع (اختياري)", "Payer's reference (optional)")}</span><input className="hr-input" dir="ltr" value={form.referenceNumber} onChange={(e) => setForm({ ...form, referenceNumber: e.target.value })} /></label>
        <label className="hr-field"><span className="hr-label">{L("ملاحظة (اختياري)", "Note (optional)")}</span><input className="hr-input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      </div>
    </Dialog>
  );
}

export default function ReceiptsPage() {
  return <Suspense fallback={null}><Receipts /></Suspense>;
}
