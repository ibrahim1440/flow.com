"use client";

import { useEffect, useState } from "react";
import { HandCoins, ArrowRightLeft, Receipt, Plus, Send, Eye, Pencil, Info } from "lucide-react";
import { useUser } from "../../user-context";
import { parseMoney } from "@/lib/finance/money";
import { riyadhDateString } from "@/lib/finance/dates";
import { CLASS_LABELS, type TxnClass } from "@/lib/finance/classes";
import { monthName } from "../_components/helpers";
import { isProfitLike, PROFIT_HINT } from "@/lib/finance/profit-hint";
import { Badge, Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, api, useApi, useFinance, useHasSub, useIdempotencyKey, useL, withBranch, type Tone } from "../_components/ui";

type Cat = {
  id: string; code: string; nameEn: string; nameAr: string | null; branchKey: string; priority: number; fundingType: string; targetAmount: number | null;
  replenish: boolean; rollover: string; spendingLimit: number | null; isTaxReserve: boolean; active: boolean; approverEmployeeId: string | null; finCategoryId: string | null;
  openingCarried: number; allocations: number; incoming: number; payments: number; outgoing: number; balance: number; reserved: number; available: number;
  obligationsRemaining: number; unfunded: number; fundingNeed: number; fundedThisMonth: number;
};
type Pool = {
  branchKey: string; eligibleCash: number; allocated: number; unallocated: number; restrictedCash: number; pendingIn: number; pendingOut: number;
  pendingOutAwaitingReview: number; committedBeyondBalance: number; overspent: number; duplicatePairs: number; duplicateAdjustment: number;
  unlinkedPayments: { reservationId: string; lineId: string; amount: number }[]; unlinkedPaymentsAmbiguous: number;
};
type Step = { seq: number; method: string; categoryId: string | null; percent: string | null; weight: number | null; capAmount: string | null };
type Version = { id: string; branchKey: string; versionNo: number; status: string; baseClasses: string[]; autoExecute: boolean; notes: string | null; approvedAt: string | null; approvedBy: string | null; steps: Step[] };
type Setup = { branches: { id: string; code: string; nameEn: string; nameAr: string | null }[]; people: { id: string; name: string; duties: string[] }[]; finCategories: { id: string; code: string; nameEn: string; nameAr: string | null; kind: string }[]; scope: { all: boolean } };
type Reservation = { id: string; amount: string; payee: string; purpose: string; dueDate: string | null; status: string; category: { code: string; nameEn: string; nameAr: string | null }; obligationId: string | null };

const M = (s: string | number | null) => (s === null ? 0 : Math.round(Number(s) * 100));
const METHOD: Record<string, [string, string]> = {
  RECEIPT_TAX_COMPONENT: ["ضريبة القيمة المضافة من المستندات المطابقة", "VAT from matched documents"],
  PERCENT_OF_BASE: ["من الأساس", "of the base"],
  FUND_OBLIGATIONS: ["تمويل الالتزامات المستحقة", "Fund obligations due"],
  FILL_TARGET: ["ملء الهدف", "Fill target"],
  WEIGHTED_REMAINDER: ["توزيع الباقي بالأوزان", "Weighted remainder"],
  LEAVE_UNALLOCATED: ["الباقي يبقى غير مخصص", "Leave the rest unallocated"],
};
const PHASE = ["RECEIPT_TAX_COMPONENT", "PERCENT_OF_BASE", "FUND_OBLIGATIONS", "FILL_TARGET", "WEIGHTED_REMAINDER", "LEAVE_UNALLOCATED"];

export default function AllocationPage() {
  const [thisMonth] = useState(() => riyadhDateString().slice(0, 7));
  const { L, name, money, lang } = useL();
  const user = useUser();
  const { refresh, branch } = useFinance();
  const canAllocate = useHasSub(user?.permissions, "allocate");
  const canPrepare = useHasSub(user?.permissions, "budget_prepare");
  const cats = useApi<Cat[]>("/api/finance/categories");
  const pools = useApi<Pool[]>("/api/finance/pools");
  const rules = useApi<Version[]>("/api/finance/rules");
  const setup = useApi<Setup>("/api/finance/setup");
  const res = useApi<Reservation[]>("/api/finance/reservations");
  const [dlg, setDlg] = useState<null | "manual" | "transfer" | "request" | "category" | "rules">(null);
  const [editCat, setEditCat] = useState<Cat | null>(null);
  const [newCatBranch, setNewCatBranch] = useState<string | null>(null);
  const [editVersion, setEditVersion] = useState<Version | null>(null);
  const [ledger, setLedger] = useState<Cat | null>(null);
  const reloadAll = () => { cats.reload(); pools.reload(); rules.reload(); res.reload(); refresh(); };
  const branchName = (k: string) => (k === "COMPANY" ? L("مستوى الشركة", "Company level") : name(setup.data?.branches.find((b) => b.id === k) ?? { nameEn: k }));

  if ((cats.loading && !cats.data) || (pools.loading && !pools.data)) return <LoadingState />;
  if (cats.error) return <ErrorState error={cats.error} onRetry={cats.reload} />;
  if (pools.error) return <ErrorState error={pools.error} onRetry={pools.reload} />;
  const list = cats.data ?? [];
  const catName = (id: string | null) => name(list.find((c) => c.id === id) ?? null);
  const policy = (c: Cat): [string, Tone] | null => {
    if (c.isTaxReserve) return [L("من ضريبة الفواتير", "From invoice VAT"), "info"];
    if (c.fundingType === "MONTHLY_TARGET") return [L(`${money(c.targetAmount).replace(".00", "")} شهرياً`, `${money(c.targetAmount).replace(".00", "")} monthly`), "brand"];
    if (c.fundingType === "RESERVE_TARGET") return [c.replenish ? L(`احتياطي ${money(c.targetAmount).replace(".00", "")} يُعاد ملؤه`, `Reserve ${money(c.targetAmount).replace(".00", "")}, refilled`) : L(`احتياطي ${money(c.targetAmount).replace(".00", "")} لمرة واحدة`, `Reserve ${money(c.targetAmount).replace(".00", "")}, one-time`), "ok"];
    if (c.spendingLimit) return [L(`حد ${money(c.spendingLimit).replace(".00", "")}`, `Limit ${money(c.spendingLimit).replace(".00", "")}`), "warn"];
    return null;
  };
  // As in the design: with several branches in view, a branch whose categories have never
  // held money is not listed (choose that branch in the header to manage its categories).
  const allBranches = [...new Set(list.map((c) => c.branchKey))];
  const active = (bk: string) => list.some((c) => c.branchKey === bk && (c.balance !== 0 || c.reserved !== 0 || c.allocations !== 0 || c.openingCarried !== 0 || c.payments !== 0 || c.incoming !== 0 || c.outgoing !== 0));
  const withActivity = allBranches.filter(active);
  const byBranch = allBranches.length > 1 && withActivity.length > 0 ? withActivity : allBranches;

  return (
    <div className="flex flex-col gap-5">
      {(pools.data ?? []).map((p) => {
        const share = p.eligibleCash > 0 ? Math.max(0, Math.min(1, p.allocated / p.eligibleCash)) : 0;
        return (
          <Card key={p.branchKey}>
            <CardTitle title={L(`${branchName(p.branchKey)} — النقد المؤهل للتخصيص`, `${branchName(p.branchKey)} — cash eligible for allocation`)} sub={L("النقد المؤكد في الحسابات غير المقيدة", "Confirmed cash in unrestricted accounts")}
              right={canAllocate && <>
                <Button icon={HandCoins} onClick={() => setDlg("manual")}>{L("تخصيص يدوي", "Manual allocation")}</Button>
                <Button icon={ArrowRightLeft} onClick={() => setDlg("transfer")}>{L("تحويل بين الفئات", "Transfer between categories")}</Button>
                <Button kind="primary" icon={Receipt} onClick={() => setDlg("request")}>{L("طلب دفع", "Payment request")}</Button>
              </>} />
            <div className="flex items-end gap-3 flex-wrap">
              <div><p className="text-xs font-bold text-brown">{L("النقد المؤهل", "Eligible cash")}</p><p className="text-[22px] font-extrabold tabular-nums">{money(p.eligibleCash)}</p></div>
              <span className="text-xl font-bold text-brown-light pb-1">=</span>
              <div><p className="text-xs font-bold text-brown">{L("مخصص للفئات", "Allocated to categories")}</p><p className="text-[22px] font-extrabold tabular-nums text-orange">{money(p.allocated)}</p></div>
              <span className="text-xl font-bold text-brown-light pb-1">+</span>
              <div><p className="text-xs font-bold text-brown">{L("غير مخصص", "Unallocated")}</p><p className={`text-[22px] font-extrabold tabular-nums ${p.unallocated < 0 ? "text-red-600" : "text-teal-600"}`}>{money(p.unallocated)}</p></div>
            </div>
            <div className="h-3 rounded-full bg-cream-dark overflow-hidden flex" aria-hidden>
              <div className="bg-orange h-full" style={{ width: `${share * 100}%` }} />
              <div className="bg-teal-600 h-full flex-1" />
            </div>
            <div className="flex gap-5 flex-wrap text-xs text-brown">
              <span>{L(`مستبعد من التخصيص: نقد مقيد ${money(p.restrictedCash)}`, `Excluded: restricted cash ${money(p.restrictedCash)}`)}</span>
              <span>{L(`وارد معلّق غير محتسب: ${money(p.pendingIn)} · صادر معلّق مخصوم من المؤهل: ${money(p.pendingOut)}`, `Pending in, not counted: ${money(p.pendingIn)} · pending out, deducted from eligible: ${money(p.pendingOut)}`)}</span>
              {p.pendingOutAwaitingReview > 0 && <span className="text-amber-700">{L(`صادر معلّق بانتظار المراجعة (غير مخصوم بعد): ${money(p.pendingOutAwaitingReview)}`, `Pending out awaiting review (not deducted yet): ${money(p.pendingOutAwaitingReview)}`)}</span>}
              {p.committedBeyondBalance > 0 && <span>{L(`التزامات معتمدة تتجاوز رصيد فئاتها (ضمن المخصص): ${money(p.committedBeyondBalance)}`, `Approved commitments beyond category balances (inside allocated): ${money(p.committedBeyondBalance)}`)}</span>}
              {p.overspent > 0 && <span>{L(`صُرف من فئات بأكثر من رصيدها: ${money(p.overspent)}`, `Spent beyond category balances: ${money(p.overspent)}`)}</span>}
              {p.unlinkedPayments.length > 0 && <span className="text-amber-700">{L(`${p.unlinkedPayments.length} سطر صادر يطابق طلب دفع معتمداً ولم يُسجَّل الدفع عليه — محتسب مرة واحدة؛ استخدم «تسجيل الدفع المنفّذ»`, `${p.unlinkedPayments.length} outgoing line(s) match an approved payment request not yet recorded — counted once; use "Record payment made"`)}</span>}
              {p.duplicatePairs > 0 && <span className="text-amber-700">{L(`${p.duplicatePairs} تكرار محتمل محتسب مرة واحدة حتى المراجعة (${money(p.duplicateAdjustment)})`, `${p.duplicatePairs} possible duplicates counted once until reviewed (${money(p.duplicateAdjustment)})`)}</span>}
              {p.unallocated < 0 && <Badge tone="bad">{L("التخصيصات تتجاوز النقد — راجع الفئات", "Allocations exceed cash — review categories")}</Badge>}
            </div>
          </Card>
        );
      })}

      {byBranch.length === 0 ? (
        <EmptyState title={L("لا توجد فئات تخصيص", "No allocation categories")} body={L("أنشئ فئات مثل الرواتب والإيجار والبن الأخضر، أو أضف الفئات المقترحة من الإعدادات.", "Create categories such as salaries, rent and green coffee, or add the suggested ones from Settings.")}>
          {canPrepare && <Button kind="primary" icon={Plus} onClick={() => { setEditCat(null); setNewCatBranch(null); setDlg("category"); }}>{L("فئة جديدة", "New category")}</Button>}
        </EmptyState>
      ) : byBranch.map((bk) => {
        const rows = list.filter((c) => c.branchKey === bk);
        const tot = (k: keyof Cat) => rows.reduce((s, c) => s + (c[k] as number), 0);
        return (
          <Card key={bk} pad="p-4">
            <CardTitle title={byBranch.length === 1
                ? L(`فئات التخصيص — ${monthName(thisMonth, "ar")} ${thisMonth.slice(0, 4)}`, `Allocation categories — ${monthName(thisMonth, "en")} ${thisMonth.slice(0, 4)}`)
                : L(`فئات التخصيص — ${branchName(bk)}`, `Allocation categories — ${branchName(bk)}`)}
              sub={L("الرصيد = الافتتاحي المرحّل + التخصيصات + الواردة − المدفوعات − الصادرة · المتاح = الرصيد − المحجوز", "Balance = opening carried + allocations + incoming − payments − outgoing · Available = balance − reserved")}
              right={canPrepare && <Button icon={Plus} onClick={() => { setEditCat(null); setNewCatBranch(bk); setDlg("category"); }}>{L("فئة جديدة", "New category")}</Button>} />
            <Table>
              <thead><tr>
                <Th>{L("الفئة", "Category")}</Th><Th>{L("السياسة", "Policy")}</Th><Th num>{L("افتتاحي مرحّل", "Opening carried")}</Th><Th num>{L("تخصيصات", "Allocations")}</Th>
                <Th num>{L("واردة", "Incoming")}</Th><Th num>{L("مدفوعات", "Payments")}</Th><Th num>{L("صادرة", "Outgoing")}</Th><Th num>{L("الرصيد", "Balance")}</Th><Th num>{L("محجوز", "Reserved")}</Th><Th num>{L("المتاح", "Available")}</Th>
              </tr></thead>
              <tbody>
                {rows.map((c) => { const p = policy(c); return (
                  <tr key={c.id} className="hover:bg-cream cursor-pointer" onClick={() => setLedger(c)}>
                    <Td className="font-medium">{name(c)}{!c.active && <span className="ms-2"><Badge>{L("غير نشطة", "Inactive")}</Badge></span>}{isProfitLike(c) && <p data-testid="profit-hint" className="flex items-start gap-1 text-[11px] font-normal text-amber-700 max-w-[320px]"><Info size={12} className="mt-0.5 flex-shrink-0" aria-hidden />{L(PROFIT_HINT.ar, PROFIT_HINT.en)}</p>}</Td>
                    <Td>{p ? <Badge tone={p[1]}>{p[0]}</Badge> : <span className="text-brown-light">—</span>}</Td>
                    <Td num className="text-brown">{money(c.openingCarried)}</Td><Td num>{money(c.allocations)}</Td><Td num className="text-brown">{money(c.incoming)}</Td>
                    <Td num>{money(c.payments)}</Td><Td num className="text-brown">{money(c.outgoing)}</Td>
                    <Td num className={`font-bold ${c.balance < 0 ? "text-red-600" : ""}`}>{money(c.balance)}</Td><Td num className="text-brown">{money(c.reserved)}</Td>
                    <Td num className={`font-bold ${c.available < 0 ? "text-red-600" : "text-orange"}`}>{money(c.available)}</Td>
                  </tr>
                ); })}
                <tr className="bg-cream-dark font-bold">
                  <Td className="font-extrabold">{L("الإجمالي", "Total")}</Td><Td />
                  <Td num>{money(tot("openingCarried"))}</Td><Td num>{money(tot("allocations"))}</Td><Td num>{money(tot("incoming"))}</Td><Td num>{money(tot("payments"))}</Td><Td num>{money(tot("outgoing"))}</Td><Td num>{money(tot("balance"))}</Td><Td num>{money(tot("reserved"))}</Td><Td num>{money(tot("available"))}</Td>
                </tr>
              </tbody>
            </Table>
          </Card>
        );
      })}

      {(res.data?.length ?? 0) > 0 && (
        <Card pad="p-4">
          <CardTitle title={L("طلبات الدفع المفتوحة", "Open payment requests")} sub={L("مبالغ محجوزة من الفئات حتى تسجيل الدفع المنفّذ", "Amounts held in categories until the payment made is recorded")} />
          <Table>
            <thead><tr><Th>{L("الفئة", "Category")}</Th><Th>{L("المستفيد", "Payee")}</Th><Th>{L("الاستحقاق", "Due")}</Th><Th>{L("الحالة", "Status")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th /></tr></thead>
            <tbody>{res.data!.map((r) => (
              <tr key={r.id}>
                <Td>{name(r.category)}</Td><Td>{r.payee} · <span className="text-brown">{r.purpose}</span></Td><Td className="text-brown">{r.dueDate?.slice(0, 10) ?? "—"}</Td>
                <Td><Badge tone={r.status === "ACTIVE" ? "brand" : "warn"}>{r.status === "ACTIVE" ? L("محجوز", "Reserved") : L("بانتظار موافقة التجاوز", "Awaiting override approval")}</Badge></Td>
                <Td num className="font-bold">{money(M(r.amount))}</Td>
                <Td>{canAllocate && <ReservationActions r={r} onDone={reloadAll} />}</Td>
              </tr>
            ))}</tbody>
          </Table>
        </Card>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-4 items-start">
        <RulesCard versions={rules.data ?? []} catName={catName} fundingOf={(cid) => list.find((c) => c.id === cid)?.fundingType} people={setup.data?.people ?? []} canPrepare={canPrepare} canAllocate={canAllocate}
          onEdit={(v) => { setEditVersion(v); setDlg("rules"); }} onChanged={reloadAll} />
        <PreviewCard versions={rules.data ?? []} catName={catName} />
      </div>

      <ManualAllocationDialog open={dlg === "manual"} onClose={() => setDlg(null)} cats={list} onDone={reloadAll} />
      <TransferDialog open={dlg === "transfer"} onClose={() => setDlg(null)} cats={list} people={setup.data?.people ?? []} onDone={reloadAll} />
      <PaymentRequestDialog open={dlg === "request"} onClose={() => setDlg(null)} cats={list} people={setup.data?.people ?? []} onDone={reloadAll} />
      <CategoryDialog open={dlg === "category"} onClose={() => setDlg(null)} cat={editCat} defaultBranch={newCatBranch} setup={setup.data} onDone={reloadAll} />
      <RulesEditor open={dlg === "rules"} onClose={() => setDlg(null)} version={editVersion} cats={list} onDone={reloadAll} branch={branch} />
      <LedgerDialog cat={ledger} onClose={() => setLedger(null)} onEdit={canPrepare ? (c) => { setLedger(null); setEditCat(c); setDlg("category"); } : undefined} lang={lang} />
    </div>
  );
}

function ReservationActions({ r, onDone }: { r: Reservation; onDone: () => void }) {
  const { L, money } = useL();
  const { branch } = useFinance();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [txnId, setTxnId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const outs = useApi<{ rows: { id: string; txnDate: string; amount: string; status: string; description: string | null; cashAccount: { code: string } }[] }>(open ? "/api/finance/transactions?take=100" : null);
  async function exec() {
    setBusy(true); setErr(null);
    try { await api(withBranch(`/api/finance/reservations/${r.id}/execute`, branch), { method: "POST", json: { txnId } }); setOpen(false); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="flex gap-1.5 justify-end">
      {r.status === "ACTIVE" && <Button kind="primary" onClick={() => setOpen(true)}>{L("تسجيل الدفع المنفّذ", "Record payment made")}</Button>}
      <Button kind="ghost" busy={busy} onClick={async () => { const reason = prompt(L("سبب الإلغاء", "Reason")); if (!reason) return; setBusy(true); try { await api(withBranch(`/api/finance/reservations/${r.id}/release`, branch), { method: "POST", json: { reason } }); onDone(); } finally { setBusy(false); } }}>{L("إلغاء الحجز", "Release")}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={L("تسجيل الدفع المنفّذ", "Record payment made")} sub={L("لا يرسل النظام أي أموال عبر البنك. نفّذ التحويل من الخدمات المصرفية، ثم اختر هنا السطر الصادر الذي يمثّله (قيد يدوي معلّق أو سطر من الكشف). يُخصم المبلغ من الفئة ويُحرر الحجز في العملية نفسها، وعند وصول الكشف يؤكّد السطر نفسه دون حركة ثانية.", "The application never sends money through the bank. Make the transfer in online banking, then choose the outgoing line that represents it (a pending manual entry or a statement line). The category is reduced and the reservation released together; when the statement arrives it confirms the same line with no second movement.")}>
        <Field label={L("السطر الصادر", "Outgoing line")}>
          <select className={INPUT} value={txnId} onChange={(e) => setTxnId(e.target.value)}>
            <option value="">—</option>
            {outs.data?.rows.filter((t) => Number(t.amount) < 0 && t.status !== "VOID").map((t) => <option key={t.id} value={t.id}>{t.txnDate.slice(0, 10)} · {t.cashAccount.code} · {money(M(t.amount))} · {t.status === "PENDING" ? L("معلّق", "pending") : L("مؤكد", "confirmed")} · {t.description}</option>)}
          </select>
        </Field>
        {err && <Notice tone="bad">{err}</Notice>}
        <div className="flex gap-2"><Button kind="primary" busy={busy} disabled={!txnId} onClick={exec}>{L("تسجيل", "Record")}</Button><Button onClick={() => setOpen(false)}>{L("إلغاء", "Cancel")}</Button></div>
      </Dialog>
    </div>
  );
}

function RulesCard({ versions, catName, fundingOf, people, canPrepare, canAllocate, onEdit, onChanged }: { versions: Version[]; catName: (id: string | null) => string; fundingOf: (id: string | null) => string | undefined; people: Setup["people"]; canPrepare: boolean; canAllocate: boolean; onEdit: (v: Version | null) => void; onChanged: () => void }) {
  const { L, money } = useL();
  const { branch } = useFinance();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const active = versions.find((v) => v.status === "ACTIVE");
  const drafts = versions.filter((v) => v.status === "DRAFT" || v.status === "PENDING_APPROVAL" || v.status === "REJECTED");
  const show = active ?? drafts[0];
  const who = (id: string | null) => people.find((p) => p.id === id)?.name ?? "—";
  if (!show) return (
    <EmptyState title={L("لا توجد قواعد تخصيص", "No allocation rules")} body={L("الإيصالات لا تُخصص تلقائياً دون قواعد معتمدة. يمكن التخصيص اليدوي دائماً.", "Receipts are never allocated automatically without approved rules. Manual allocation is always available.")}>
      {canPrepare && <Button kind="primary" icon={Plus} onClick={() => onEdit(null)}>{L("إنشاء مسودة", "Create a draft")}</Button>}
    </EmptyState>
  );
  const ordered = [...show.steps].sort((a, b) => PHASE.indexOf(a.method) - PHASE.indexOf(b.method) || a.seq - b.seq);
  const statusBadge: Record<string, [string, string, Tone]> = { ACTIVE: ["نشط", "Active", "ok"], DRAFT: ["مسودة", "Draft", "info"], PENDING_APPROVAL: ["بانتظار الاعتماد", "Awaiting approval", "warn"], REJECTED: ["مرفوض", "Rejected", "bad"] };
  const sb = statusBadge[show.status] ?? [show.status, show.status, "info" as Tone];
  async function submit(v: Version) {
    setBusy(true); setErr(null);
    try { await api(withBranch(`/api/finance/rules/${v.id}/submit`, branch), { method: "POST", json: {} }); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Card>
      <CardTitle title={L(`قواعد التخصيص — الإصدار ${show.versionNo}`, `Allocation rules — version ${show.versionNo}`)}
        sub={show.status === "ACTIVE" ? L(`اعتمدها ${who(show.approvedBy)} · ${show.approvedAt?.slice(0, 10)} · التنفيذ التلقائي: ${show.autoExecute ? "مفعّل" : "متوقف"}`, `Approved by ${who(show.approvedBy)} · ${show.approvedAt?.slice(0, 10)} · automatic execution: ${show.autoExecute ? "on" : "off"}`) : undefined}
        right={<Badge tone={sb[2]}>{L(sb[0], sb[1])}</Badge>} />
      <div className="rounded-[10px] bg-slate-100 px-3 py-2.5 text-xs text-slate-600 flex flex-col gap-1">
        <p className="font-medium">{L("أساس النسب: صافي الإيداع غير المخصص (بعد رسوم البوابة) ناقص ضريبة القيمة المضافة المحتجزة.", "Percentage base: the receipt's unallocated net deposit (after gateway fees) minus the VAT reserved.")}</p>
        <p>{L("أنواع الأساس", "Base receipt types")}: {show.baseClasses.map((c) => L(CLASS_LABELS[c as TxnClass]?.ar ?? c, CLASS_LABELS[c as TxnClass]?.en ?? c)).join(" · ")}</p>
      </div>
      <ol className="flex flex-col gap-1.5">
        {ordered.map((s, i) => (
          <li key={s.seq} className="flex items-center gap-2.5 bg-cream-dark rounded-lg px-2.5 py-1.5">
            <span className="w-[22px] h-[22px] rounded-full bg-orange text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0">{i + 1}</span>
            <span className="text-[13px] font-medium flex-1">{s.method === "PERCENT_OF_BASE" ? `${Number(s.percent)}% ${L(METHOD[s.method][0], METHOD[s.method][1])}` : s.method === "FILL_TARGET" ? (fundingOf(s.categoryId) === "RESERVE_TARGET" ? L("ملء الاحتياطي", "Fill reserve") : L("ملء الهدف الشهري", "Fill monthly target")) : L(METHOD[s.method][0], METHOD[s.method][1])}{s.weight ? ` (${s.weight})` : ""}{s.capAmount ? ` · ${L("سقف", "cap")} ${money(M(s.capAmount))}` : ""}</span>
            <span className="text-xs text-brown">{s.categoryId ? catName(s.categoryId) : "—"}</span>
          </li>
        ))}
      </ol>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2 flex-wrap">
        {canPrepare && <Button icon={Pencil} onClick={() => onEdit(drafts.find((d) => d.status !== "PENDING_APPROVAL") ?? null)}>{drafts.some((d) => d.status === "DRAFT" || d.status === "REJECTED") ? L("تعديل المسودة", "Edit draft") : L("إصدار جديد (مسودة)", "New version (draft)")}</Button>}
        {canPrepare && drafts.filter((d) => d.status === "DRAFT").map((d) => <Button key={d.id} kind="primary" icon={Send} busy={busy} onClick={() => submit(d)}>{L(`إرسال الإصدار ${d.versionNo} للاعتماد`, `Submit version ${d.versionNo} for approval`)}</Button>)}
        {!canAllocate && <span className="text-[11px] text-brown-light">{L("التشغيل يتطلب صلاحية التخصيص.", "Running allocations needs the allocate duty.")}</span>}
      </div>
      {drafts.some((d) => d.status === "PENDING_APPROVAL") && <Notice tone="warn">{L("إصدار جديد بانتظار الاعتماد؛ لا يسري قبل موافقة صاحب صلاحية الاعتماد.", "A new version is awaiting approval; it takes effect only after an approver accepts it.")}</Notice>}
    </Card>
  );
}

function PreviewCard({ versions, catName }: { versions: Version[]; catName: (id: string | null) => string }) {
  const { L, money } = useL();
  const { branch } = useFinance();
  const candidates = versions.filter((v) => ["ACTIVE", "DRAFT", "PENDING_APPROVAL"].includes(v.status));
  const [vidPick, setVid] = useState(""); const [amount, setAmount] = useState("10000.00"); const [tax, setTax] = useState("0.00"); const [lower, setLower] = useState("70");
  const [r, setR] = useState<{ scenario: { lines: { categoryId: string; amount: number }[]; leftUnallocated: number; base: number }; lowerCollections: { lines: { categoryId: string; amount: number }[]; leftUnallocated: number; percent: number }; validation: { errors: string[]; warnings: string[] } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const vid = vidPick || (candidates.find((v) => v.status === "ACTIVE") ?? candidates[0])?.id || "";
  useEffect(() => {
    if (!vid || parseMoney(amount) === null) return;
    const h = setTimeout(() => api<typeof r>(withBranch("/api/finance/rules/preview", branch), { method: "POST", json: { versionId: vid, amount, taxAmount: tax, lowerCollectionsPct: Number(lower) } }).then((x) => { setR(x); setErr(null); }).catch((e) => setErr(e.message)), 250);
    return () => clearTimeout(h);
  }, [vid, amount, tax, lower, branch]);
  if (candidates.length === 0) return null;
  const ids = [...new Set([...(r?.scenario.lines ?? []), ...(r?.lowerCollections.lines ?? [])].map((l) => l.categoryId))];
  const sum = (lines: { categoryId: string; amount: number }[], id: string) => lines.filter((l) => l.categoryId === id).reduce((s, l) => s + l.amount, 0);
  return (
    <Card>
      <CardTitle title={L("معاينة القواعد", "Rule preview")} sub={L("لا يُحفظ شيء. تُطبّق على حالة الفئات الحالية.", "Nothing is saved. Applied to the categories' current state.")}
        right={candidates.length > 1 && <select aria-label={L("الإصدار", "Version")} className={`${INPUT} !w-auto`} value={vid} onChange={(e) => setVid(e.target.value)}>{candidates.map((v) => <option key={v.id} value={v.id}>v{v.versionNo} · {v.status}</option>)}</select>} />
      <div className="grid grid-cols-3 gap-2">
        <Field label={L("مبلغ الإيصال", "Receipt amount")}><input className={`${INPUT} font-bold`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
        <Field label={L("ضريبة مطابقة", "Matched VAT")}><input className={`${INPUT} font-bold`} value={tax} onChange={(e) => setTax(e.target.value)} inputMode="decimal" /></Field>
        <Field label={L("سيناريو تحصيل أقل", "Lower-collections scenario")}><div className="relative"><input className={`${INPUT} font-bold pe-7`} value={lower} onChange={(e) => setLower(e.target.value)} inputMode="numeric" /><span className="absolute top-1/2 -translate-y-1/2 end-3 text-xs text-brown">%</span></div></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      {r && (
        <>
          {r.validation.errors.length > 0 && <Notice tone="bad">{r.validation.errors.join(" ")}</Notice>}
          <Table>
            <thead><tr><Th>{L("الفئة", "Category")}</Th><Th num>{L("الأساسي", "Base")}</Th><Th num>{r.lowerCollections.percent}%</Th></tr></thead>
            <tbody>
              {ids.map((id) => <tr key={id}><Td>{catName(id)}</Td><Td num>{money(sum(r.scenario.lines, id))}</Td><Td num>{money(sum(r.lowerCollections.lines, id))}</Td></tr>)}
              <tr className="bg-cream-dark font-bold"><Td className="font-bold">{L("يبقى غير مخصص", "Stays unallocated")}</Td><Td num>{money(r.scenario.leftUnallocated)}</Td><Td num>{money(r.lowerCollections.leftUnallocated)}</Td></tr>
            </tbody>
          </Table>
          {r.validation.warnings.map((w, i) => <p key={i} className="text-xs text-amber-700">{w}</p>)}
        </>
      )}
      <p className="text-xs text-brown">{L("الأهداف الشهرية المكتملة لا تُموَّل مجدداً رغم الصرف؛ الاحتياطي القابل لإعادة الملء يُعاد ملؤه.", "A funded monthly target is not refilled after spending; a replenishable reserve is.")}</p>
    </Card>
  );
}

// ─── Dialogs ─────────────────────────────────────────────────────────────────

function ManualAllocationDialog({ open, onClose, cats, onDone }: { open: boolean; onClose: () => void; cats: Cat[]; onDone: () => void }) {
  const { L, name, money } = useL();
  const { branch } = useFinance();
  const [categoryId, setCat] = useState(""); const [amount, setAmount] = useState(""); const [source, setSource] = useState<"txn" | "opening">("txn");
  const [srcId, setSrc] = useState(""); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const receipts = useApi<{ rows: { id: string; txnDate: string; amount: string; description: string | null; classification: string; reviewStatus: string; cashAccount: { code: string } }[] }>(open ? "/api/finance/transactions?take=100&status=CONFIRMED&review=REVIEWED" : null);
  const accounts = useApi<{ id: string; code: string; nameEn: string; nameAr: string | null; opening: number; isRestricted: boolean }[]>(open ? "/api/finance/accounts" : null);
  const cat = cats.find((c) => c.id === categoryId);
  async function submit() {
    setBusy(true); setErr(null);
    try { await api(withBranch("/api/finance/allocations/manual", branch), { method: "POST", json: { categoryId, amount, reason, ...(source === "txn" ? { sourceTxnId: srcId } : { sourceCashAccountId: srcId }) } }); onDone(); onClose(); setAmount(""); setReason(""); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={onClose} title={L("تخصيص يدوي", "Manual allocation")} sub={L("تخصيص داخلي لجزء من نقد موجود — ليس مصروفاً ولا تحويلاً بنكياً. يجب أن يُنسب إلى مصدره.", "An internal earmark of existing cash — not an expense and not a bank transfer. It must name its source.")}>
      <Field label={L("الفئة", "Category")}><select className={INPUT} value={categoryId} onChange={(e) => setCat(e.target.value)}><option value="">—</option>{cats.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("المصدر", "Source")}><select className={INPUT} value={source} onChange={(e) => { setSource(e.target.value as "txn"); setSrc(""); }}><option value="txn">{L("إيصال مؤكد", "Confirmed receipt")}</option><option value="opening">{L("رصيد افتتاحي لحساب", "Account opening balance")}</option></select></Field>
        <Field label={L("المبلغ", "Amount")}><input className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
      </div>
      <Field label={source === "txn" ? L("الإيصال", "Receipt") : L("الحساب", "Account")}>
        <select className={INPUT} value={srcId} onChange={(e) => setSrc(e.target.value)}>
          <option value="">—</option>
          {source === "txn" ? receipts.data?.rows.filter((t) => Number(t.amount) > 0 && t.classification !== "INTERNAL_TRANSFER").map((t) => <option key={t.id} value={t.id}>{t.txnDate.slice(0, 10)} · {t.cashAccount.code} · {t.amount} · {t.description}</option>)
            : accounts.data?.filter((a) => !a.isRestricted).map((a) => <option key={a.id} value={a.id}>{a.code} · {name(a)} · {money(a.opening)}</option>)}
        </select>
      </Field>
      <Field label={L("السبب", "Reason")}><input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {cat && <p className="text-xs text-brown">{L("المتاح حالياً في الفئة", "Currently available in the category")}: {money(cat.available)}</p>}
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} disabled={!categoryId || !srcId || !amount || !reason} onClick={submit}>{L("تخصيص", "Allocate")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

function TransferDialog({ open, onClose, cats, people, onDone }: { open: boolean; onClose: () => void; cats: Cat[]; people: Setup["people"]; onDone: () => void }) {
  const { L, name, money } = useL();
  const { branch } = useFinance();
  const [f, setF] = useState({ fromCategoryId: "", toCategoryId: "", amount: "", reason: "", assignedToId: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState(false);
  const from = cats.find((c) => c.id === f.fromCategoryId);
  async function submit() {
    setBusy(true); setErr(null);
    try { await api(withBranch("/api/finance/allocations/transfer", branch), { method: "POST", json: { ...f, assignedToId: f.assignedToId || undefined } }); setOk(true); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={() => { setOk(false); onClose(); }} title={L("تحويل بين الفئات", "Transfer between categories")} sub={L("يتطلب موافقة صاحب صلاحية اعتماد التحويلات. لا يتحرك أي مبلغ قبل الاعتماد.", "Needs approval from a holder of the transfer-approval duty. Nothing moves before approval.")}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("من", "From")}><select className={INPUT} value={f.fromCategoryId} onChange={(e) => setF({ ...f, fromCategoryId: e.target.value })}><option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{name(c)} · {money(c.available)}</option>)}</select></Field>
        <Field label={L("إلى", "To")}><select className={INPUT} value={f.toCategoryId} onChange={(e) => setF({ ...f, toCategoryId: e.target.value })}><option value="">—</option>{cats.filter((c) => c.id !== f.fromCategoryId && (!from || c.branchKey === from.branchKey)).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}</select></Field>
        <Field label={L("المبلغ", "Amount")}><input className={INPUT} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="decimal" /></Field>
        <Field label={L("المعتمِد (اختياري)", "Approver (optional)")}><select className={INPUT} value={f.assignedToId} onChange={(e) => setF({ ...f, assignedToId: e.target.value })}><option value="">{L("أي صاحب صلاحية", "Any holder of the duty")}</option>{people.filter((p) => p.duties.includes("transfer_approve")).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      </div>
      <Field label={L("السبب", "Reason")}><input className={INPUT} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      {ok && <Notice tone="ok">{L("أُرسل الطلب إلى قائمة الموافقات.", "The request was sent to the approval queue.")}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} disabled={ok || !f.fromCategoryId || !f.toCategoryId || !f.amount || !f.reason} onClick={submit}>{L("إرسال للموافقة", "Send for approval")}</Button><Button onClick={() => { setOk(false); onClose(); }}>{ok ? L("إغلاق", "Close") : L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

function PaymentRequestDialog({ open, onClose, cats, people, onDone }: { open: boolean; onClose: () => void; cats: Cat[]; people: Setup["people"]; onDone: () => void }) {
  const { L, name, money } = useL();
  const { branch } = useFinance();
  const idem = useIdempotencyKey();
  const [f, setF] = useState({ categoryId: "", obligationId: "", amount: "", dueDate: "", payee: "", purpose: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [result, setResult] = useState<string | null>(null);
  const obligations = useApi<{ rows: { id: string; description: string; remaining: number; reserved: number; dueDate: string; counterparty: string | null; allocationCategoryId: string | null }[] }>(open ? "/api/finance/obligations" : null);
  const cat = cats.find((c) => c.id === f.categoryId);
  const amt = parseMoney(f.amount);
  const overLimit = !!cat && amt !== null && cat.spendingLimit !== null && amt > cat.spendingLimit;
  const overBal = !!cat && amt !== null && amt > cat.available;
  const approver = cat?.approverEmployeeId ? people.find((p) => p.id === cat.approverEmployeeId)?.name : null;
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ reservation: { status: string } }>(withBranch("/api/finance/reservations", branch), { method: "POST", json: { ...f, obligationId: f.obligationId || undefined, dueDate: f.dueDate || undefined, idempotencyKey: idem.key } });
      setResult(r.reservation.status === "PENDING_APPROVAL" ? L("حُجز المبلغ وأُرسل للموافقة على التجاوز.", "Held and sent for override approval.") : L("حُجز المبلغ في الفئة.", "The amount is reserved in the category."));
      idem.renew(); onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const close = () => { setResult(null); setErr(null); onClose(); };
  return (
    <Dialog open={open} onClose={close} title={L("طلب دفع من فئة", "Payment request from a category")} sub={L("يحجز المبلغ من رصيد الفئة حتى تسجيل الدفع المنفّذ (لا يرسل النظام أموالاً)", "Holds the amount in the category until the payment made is recorded (the app sends no money)")}>
      <Field label={L("الفئة", "Category")}><select className={INPUT} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">—</option>{cats.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{name(c)} — {L("المتاح", "available")} {money(c.available)}</option>)}</select></Field>
      <Field label={L("الالتزام (اختياري)", "Obligation (optional)")}>
        <select className={INPUT} value={f.obligationId} onChange={(e) => { const o = obligations.data?.rows.find((x) => x.id === e.target.value); setF({ ...f, obligationId: e.target.value, ...(o ? { amount: (Math.max(0, o.remaining - o.reserved) / 100).toFixed(2), dueDate: o.dueDate, payee: f.payee || o.counterparty || "", purpose: f.purpose || o.description } : {}) }); }}>
          <option value="">—</option>
          {obligations.data?.rows.filter((o) => !cat || !o.allocationCategoryId || o.allocationCategoryId === cat.id).map((o) => <option key={o.id} value={o.id}>{o.description} · {money(o.remaining)} · {o.dueDate}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("المبلغ", "Amount")}><input className={`${INPUT} font-bold`} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="decimal" /></Field>
        <Field label={L("تاريخ الاستحقاق", "Due date")}><input type="date" className={INPUT} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
      </div>
      <Field label={L("المستفيد", "Payee")}><input className={INPUT} value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} /></Field>
      <Field label={L("الغرض", "Purpose")}><input className={INPUT} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
      {(overLimit || overBal) && (
        <Notice tone="warn">
          <p className="font-bold">{overBal && overLimit ? L(`يتجاوز المبلغ المتاح (${money(cat!.available)}) وحد الإنفاق (${money(cat!.spendingLimit)})`, `Exceeds the available ${money(cat!.available)} and the spending limit ${money(cat!.spendingLimit)}`) : overBal ? L(`يتجاوز المبلغ المتاح (${money(cat!.available)})`, `Exceeds the available ${money(cat!.available)}`) : L(`يتجاوز حد الإنفاق (${money(cat!.spendingLimit)})`, `Exceeds the spending limit ${money(cat!.spendingLimit)}`)}</p>
          <p className="text-xs">{approver ? L(`سيُحجز ويُرسل للموافقة على التجاوز إلى: ${approver}`, `It will be held and sent for override approval to: ${approver}`) : L("سيُحجز ويُرسل لأصحاب صلاحية اعتماد التجاوز.", "It will be held and sent to holders of the override-approval duty.")}</p>
        </Notice>
      )}
      {err && <Notice tone="bad">{err}</Notice>}
      {result && <Notice tone="ok">{result}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} disabled={!!result || !f.categoryId || !f.amount || !f.payee || !f.purpose} onClick={submit}>{overLimit || overBal ? L("إرسال للموافقة", "Send for approval") : L("حجز", "Reserve")}</Button><Button onClick={close}>{result ? L("إغلاق", "Close") : L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

type CategoryDialogProps = { open: boolean; onClose: () => void; cat: Cat | null; defaultBranch?: string | null; setup: Setup | null; onDone: () => void };
function CategoryDialog(props: CategoryDialogProps) {
  return props.open ? <CategoryDialogBody key={props.cat?.id ?? `new:${props.defaultBranch ?? ""}`} {...props} /> : null;
}

function CategoryDialogBody({ open, onClose, cat, defaultBranch, setup, onDone }: CategoryDialogProps) {
  const { L, name } = useL();
  const { branch } = useFinance();
  const blank = { code: "", nameEn: "", nameAr: "", branchKey: defaultBranch ?? (setup?.scope.all ? "COMPANY" : setup?.branches[0]?.id ?? "COMPANY"), priority: "100", fundingType: "OPEN", targetAmount: "", replenish: false, rollover: "CARRY_FORWARD", spendingLimit: "", approverEmployeeId: "", isTaxReserve: false, finCategoryId: "", active: true, reason: "" };
  const [f, setF] = useState(() => (cat ? { ...blank, code: cat.code, nameEn: cat.nameEn, nameAr: cat.nameAr ?? "", branchKey: cat.branchKey, priority: String(cat.priority), fundingType: cat.fundingType, targetAmount: cat.targetAmount === null ? "" : (cat.targetAmount / 100).toFixed(2), replenish: cat.replenish, rollover: cat.rollover, spendingLimit: cat.spendingLimit === null ? "" : (cat.spendingLimit / 100).toFixed(2), approverEmployeeId: cat.approverEmployeeId ?? "", isTaxReserve: cat.isTaxReserve, finCategoryId: cat.finCategoryId ?? "", active: cat.active } : blank));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function submit() {
    setBusy(true); setErr(null);
    const body = { ...f, targetAmount: f.targetAmount || null, spendingLimit: f.spendingLimit || null, approverEmployeeId: f.approverEmployeeId || null, finCategoryId: f.finCategoryId || null };
    try {
      if (cat) await api(withBranch(`/api/finance/categories/${cat.id}`, branch), { method: "PATCH", json: body });
      else await api(withBranch("/api/finance/categories", branch), { method: "POST", json: body });
      onDone(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open={open} onClose={onClose} width="max-w-[640px]" title={cat ? L(`تعديل الفئة ${cat.code}`, `Edit category ${cat.code}`) : L("فئة تخصيص جديدة", "New allocation category")}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("الرمز", "Code")}><input className={INPUT} disabled={!!cat} value={f.code} onChange={set("code")} /></Field>
        <Field label={L("الفرع", "Branch")}><select className={INPUT} disabled={!!cat} value={f.branchKey} onChange={set("branchKey")}>{setup?.scope.all && <option value="COMPANY">{L("مستوى الشركة", "Company level")}</option>}{setup?.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</select></Field>
        <Field label={L("الاسم بالعربية", "Arabic name")}><input className={INPUT} value={f.nameAr} onChange={set("nameAr")} /></Field>
        <Field label={L("الاسم بالإنجليزية", "English name")}><input className={INPUT} value={f.nameEn} onChange={set("nameEn")} /></Field>
        <Field label={L("نوع التمويل", "Funding type")}><select className={INPUT} value={f.fundingType} onChange={set("fundingType")}><option value="OPEN">{L("مفتوح", "Open")}</option><option value="MONTHLY_TARGET">{L("هدف شهري (لا يُعاد ملؤه بعد الصرف)", "Monthly target (not refilled after spending)")}</option><option value="RESERVE_TARGET">{L("احتياطي مستهدف", "Target reserve")}</option></select></Field>
        <Field label={L("مبلغ الهدف", "Target amount")}><input className={INPUT} disabled={f.fundingType === "OPEN"} value={f.targetAmount} onChange={set("targetAmount")} inputMode="decimal" /></Field>
        <Field label={L("الأولوية (الأصغر أولاً)", "Priority (lower first)")}><input className={INPUT} value={f.priority} onChange={set("priority")} inputMode="numeric" /></Field>
        <Field label={L("سياسة الترحيل", "Rollover policy")}><select className={INPUT} value={f.rollover} onChange={set("rollover")}><option value="CARRY_FORWARD">{L("ترحيل الرصيد", "Carry forward")}</option><option value="SWEEP_TO_UNALLOCATED">{L("إعادة لغير المخصص عند الإقفال", "Sweep to unallocated at close")}</option></select></Field>
        <Field label={L("حد الإنفاق للدفعة الواحدة", "Spending limit per payment")}><input className={INPUT} value={f.spendingLimit} onChange={set("spendingLimit")} inputMode="decimal" /></Field>
        <Field label={L("معتمِد التجاوز", "Override approver")}><select className={INPUT} value={f.approverEmployeeId} onChange={set("approverEmployeeId")}><option value="">{L("أي صاحب صلاحية", "Any holder of the duty")}</option>{setup?.people.filter((p) => p.duties.includes("spend_override_approve")).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label={L("بند الميزانية المرتبط", "Linked budget category")}><select className={INPUT} value={f.finCategoryId} onChange={set("finCategoryId")}><option value="">—</option>{setup?.finCategories.filter((c) => c.kind === "PAYMENT").map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}</select></Field>
      </div>
      <div className="flex gap-4 flex-wrap text-[13px]">
        <label className="flex items-center gap-2"><input type="checkbox" disabled={f.fundingType !== "RESERVE_TARGET"} checked={f.replenish} onChange={(e) => setF({ ...f, replenish: e.target.checked })} />{L("يُعاد ملء الاحتياطي بعد الصرف", "Refill the reserve after spending")}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.isTaxReserve} onChange={(e) => setF({ ...f, isTaxReserve: e.target.checked })} />{L("احتياطي ضريبي (من ضريبة المستندات فقط)", "Tax reserve (document VAT only)")}</label>
        {cat && <label className="flex items-center gap-2"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{L("نشطة", "Active")}</label>}
      </div>
      {isProfitLike(f) && <Notice tone="info" icon={Info}>{L(PROFIT_HINT.ar, PROFIT_HINT.en)}</Notice>}
      {cat && <Field label={L("سبب التعديل", "Reason for the change")}><input className={INPUT} value={f.reason} onChange={set("reason")} /></Field>}
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} onClick={submit}>{L("حفظ", "Save")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

type RulesEditorProps = { open: boolean; onClose: () => void; version: Version | null; cats: Cat[]; onDone: () => void; branch: string };
function RulesEditor(props: RulesEditorProps) {
  const actives = useApi<Version[]>(props.open ? "/api/finance/rules" : null);
  if (!props.open || (actives.loading && !actives.data)) return null;
  const src = props.version ?? actives.data?.find((v) => v.status === "ACTIVE") ?? null;
  return <RulesEditorBody key={src?.id ?? "new"} {...props} src={src} />;
}

function RulesEditorBody({ open, onClose, version, cats, onDone, branch, src }: RulesEditorProps & { src: Version | null }) {
  const { L, name } = useL();
  const [steps, setSteps] = useState<{ method: string; categoryId: string; percent: string; weight: string; capAmount: string }[]>(() => (src ? src.steps.map((s) => ({ method: s.method, categoryId: s.categoryId ?? "", percent: s.percent ? String(Number(s.percent)) : "", weight: s.weight ? String(s.weight) : "", capAmount: s.capAmount ?? "" })) : [{ method: "PERCENT_OF_BASE", categoryId: "", percent: "", weight: "", capAmount: "" }]));
  const [auto, setAuto] = useState(src?.autoExecute ?? false); const [notes, setNotes] = useState(src?.notes ?? "");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [details, setDetails] = useState<string[]>([]);
  const pctTotal = steps.filter((s) => s.method === "PERCENT_OF_BASE").reduce((a, s) => a + (Number(s.percent) || 0), 0);
  async function save() {
    setBusy(true); setErr(null); setDetails([]);
    const body = { autoExecute: auto, notes, steps: steps.map((s, i) => ({ seq: i + 1, method: s.method, categoryId: s.categoryId || null, percent: s.percent || null, weight: s.weight || null, capAmount: s.capAmount || null })) };
    try {
      if (version && (version.status === "DRAFT" || version.status === "REJECTED")) await api(withBranch(`/api/finance/rules/${version.id}`, branch), { method: "PUT", json: body });
      else await api(withBranch("/api/finance/rules", branch), { method: "POST", json: body });
      onDone(); onClose();
    } catch (e) { const ex = e as Error & { details?: { errors?: string[] } }; setErr(ex.message); setDetails(ex.details?.errors ?? []); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={onClose} width="max-w-[820px]" title={L("قواعد التخصيص — مسودة", "Allocation rules — draft")} sub={L("تُنفَّذ بترتيب ثابت: الضريبة، ثم كل النسب على الأساس نفسه، ثم الالتزامات، ثم الأهداف، ثم الباقي. لا تسري قبل الاعتماد.", "Executed in a fixed order: VAT, all percentages on the same base, obligations, targets, then the remainder. No effect until approved.")}>
      <div className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <div key={i} className="grid grid-cols-[1.4fr_1.4fr_0.7fr_0.6fr_0.8fr_auto] gap-2 items-center">
            <select aria-label={L("الطريقة", "Method")} className={INPUT} value={s.method} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))}>{PHASE.map((m) => <option key={m} value={m}>{L(METHOD[m][0], METHOD[m][1])}</option>)}</select>
            <select aria-label={L("الفئة", "Category")} className={INPUT} disabled={s.method === "LEAVE_UNALLOCATED"} value={s.categoryId} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, categoryId: e.target.value } : x)))}><option value="">—</option>{cats.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}</select>
            <input aria-label="%" className={INPUT} placeholder="%" disabled={s.method !== "PERCENT_OF_BASE"} value={s.percent} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} />
            <input aria-label={L("الوزن", "Weight")} className={INPUT} placeholder={L("وزن", "weight")} disabled={s.method !== "WEIGHTED_REMAINDER"} value={s.weight} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)))} />
            <input aria-label={L("السقف", "Cap")} className={INPUT} placeholder={L("سقف", "cap")} value={s.capAmount} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, capAmount: e.target.value } : x)))} />
            <button type="button" className="text-xs font-bold text-red-600" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>{L("حذف", "Remove")}</button>
          </div>
        ))}
        <button type="button" className="self-start text-xs font-bold text-orange" onClick={() => setSteps([...steps, { method: "PERCENT_OF_BASE", categoryId: "", percent: "", weight: "", capAmount: "" }])}>{L("+ إضافة خطوة", "+ Add step")}</button>
        <p className={`text-xs font-bold ${pctTotal > 100 ? "text-red-600" : "text-brown"}`}>{L(`مجموع النسب: ${pctTotal}% من الأساس (الحد الأقصى 100%)`, `Percentages total ${pctTotal}% of the base (max 100%)`)}</p>
      </div>
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />{L("تنفيذ تلقائي على الإيصالات المؤكدة المُراجعة (بعد الاعتماد فقط)", "Run automatically on confirmed, reviewed receipts (only after approval)")}</label>
      <Field label={L("ملاحظات", "Notes")}><input className={INPUT} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {err && <Notice tone="bad"><p>{err}</p>{details.map((d, i) => <p key={i} className="text-xs">{d}</p>)}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} onClick={save}>{L("حفظ المسودة", "Save draft")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

function LedgerDialog({ cat, onClose, onEdit }: { cat: Cat | null; onClose: () => void; onEdit?: (c: Cat) => void; lang: string }) {
  const { L, name, money } = useL();
  const d = useApi<{ rows: { id: string; entryType: string; sourceType: string; amount: string; periodMonth: string; reason: string | null; createdAt: string; sourceTxnId: string | null }[]; total: number }>(cat ? `/api/finance/categories/${cat.id}` : null);
  if (!cat) return null;
  const sign = (t: string) => (["ALLOCATION", "TRANSFER_IN", "ADJUSTMENT_IN"].includes(t) ? 1 : -1);
  const TYPE: Record<string, [string, string]> = { ALLOCATION: ["تخصيص", "Allocation"], TRANSFER_IN: ["تحويل وارد", "Transfer in"], TRANSFER_OUT: ["تحويل صادر", "Transfer out"], ADJUSTMENT_IN: ["تسوية واردة", "Adjustment in"], ADJUSTMENT_OUT: ["تسوية صادرة", "Adjustment out"], PAYMENT: ["دفعة", "Payment"] };
  return (
    <Dialog open={!!cat} onClose={onClose} width="max-w-[760px]" title={L(`سجل الفئة — ${name(cat)}`, `Category ledger — ${name(cat)}`)} sub={L("سجل إضافي فقط؛ التصحيحات قيود عكسية ولا يُعدّل التاريخ.", "Append-only; corrections are reversing entries and history is never rewritten.")}>
      {d.loading && !d.data ? <LoadingState /> : d.error ? <ErrorState error={d.error} onRetry={d.reload} /> : (
        <Table>
          <thead><tr><Th>{L("الوقت", "Time")}</Th><Th>{L("النوع", "Type")}</Th><Th>{L("الشهر", "Month")}</Th><Th>{L("المصدر / السبب", "Source / reason")}</Th><Th num>{L("المبلغ", "Amount")}</Th></tr></thead>
          <tbody>{d.data?.rows.map((e) => (
            <tr key={e.id}><Td className="text-brown whitespace-nowrap">{e.createdAt.slice(0, 16).replace("T", " ")}</Td><Td>{L(TYPE[e.entryType][0], TYPE[e.entryType][1])}</Td><Td className="text-brown">{e.periodMonth}</Td><Td className="text-xs">{e.sourceType}{e.reason ? ` · ${e.reason}` : ""}</Td><Td num className={`font-bold ${sign(e.entryType) > 0 ? "text-green-600" : ""}`}>{money(sign(e.entryType) * M(e.amount))}</Td></tr>
          ))}</tbody>
        </Table>
      )}
      <div className="flex gap-2">{onEdit && <Button icon={Pencil} onClick={() => onEdit(cat)}>{L("تعديل السياسة", "Edit policy")}</Button>}<Button icon={Eye} onClick={onClose}>{L("إغلاق", "Close")}</Button></div>
    </Dialog>
  );
}
