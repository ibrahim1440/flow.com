"use client";

import { halalas } from "@/lib/format/money";
import { prepareReceipt } from "@/lib/files/receipt-prep";
import { useState, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { Paperclip } from "lucide-react";
import {
  useLang, Spinner, Modal, Field, TextArea, Button, FocusDialog, api, formatDay, formatMoney, num, moneyText,
} from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { fullDate } from "@/components/credit/credit-ui";
import "../_components/money.css";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import { splitTitle } from "@/components/d21/labels";
import { useUser } from "../../user-context";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { FilterCard, DateRange, Section, ListFooter, ListPageSize, useFilters, usePaging, useTerm } from "@/components/chrome";
import { useAccountantView } from "../../accounting/_ui/qoyod-pages";
import { LocationFilter, UNASSIGNED_LOCATION } from "../../accounting/_ui/locations";

/**
 * Collections — one screen, two jobs, built to GX A-01 (Figma 1459:15522, EN 1459:16043; the
 * opened collection 1460:15742; 390 1459:17412): header, three figures, the status segments,
 * the ledger, the rules, and the opened collection as a drawer at the sheet's end.
 *
 * A salesperson opens it to see what they recorded and where it got to. Finance opens it to
 * work the verification queue. It is deliberately not two routes: the records are the same
 * records, and a second URL for them is a second place for the scoping rule to be wrong.
 * Which job the screen is doing is decided by the privileges the server reports, not by a
 * query parameter the browser could change.
 *
 * Nothing here is a bank feed. A collection is a claim that money arrived; Finance either
 * agrees or does not, and only agreement creates commission. The screen says so.
 *
 * Visual port only: requests, payloads and every figure are the ones this screen already had.
 * What the frames draw and the system does not have (the bank-line match in the drawer) is not
 * built.
 */

type Accrual = { amount: string; status: string; employee: { id: string; name: string } };

type Collection = {
  id: string;
  /** «الموقع» (WP-B). */
  branchId?: string | null;
  status: "PENDING_VERIFICATION" | "APPROVED" | "REJECTED" | "REVERSED";
  amountGross: string;
  amountTax: string;
  /** null for a recorder — the server keeps the net basis for Finance (R3-L1). */
  amountNet: string | null;
  currency: string;
  paymentMethod: string;
  collectedAt: string;
  referenceNumber: string | null;
  note: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  submittedBy: { id: string; name: string } | null;
  decidedBy: { id: string; name: string } | null;
  reversedBy: { id: string; name: string } | null;
  customer: { id: string; name: string; nameAr: string | null } | null;
  opportunity: { id: string; title: string; ownerId: string } | null;
  quote: { id: string; quoteNumber: string } | null;
  _count: { evidence: number };
  evidence?: Evidence[];
  collectionEvent: { accruals: Accrual[] } | null;
  // «سند قبض» (BATCH22 WP-D): the voucher number, a return for correction and the correction made of it.
  receiptNumber?: string | null;
  decisionReasonCode?: string | null;
  correctedBy?: { id: string; status: string } | null;
};

type EligibleDeal = {
  id: string;
  title: string;
  quoteNumber: string;
  currency: string;
  unpaid: string;
  availableToSubmit: string;
  remaining: string;
};

type Evidence = {
  id: string; filename: string; mimeType: string; byteSize: number; uploadedAt: string;
};

type Ability = { allowed: boolean; reason: string };
type RowDecision = { approve: Ability; reject: Ability; reverse: Ability };

/**
 * Why an action is not offered on a row, said out loud.
 *
 * The queue used to render an empty cell for every unavailable action, so a manager
 * correctly without approval rights, a Finance user whose privileges had not been granted,
 * and a Finance user correctly refused their own submission all looked the same.
 */
const WHY_NOT: Record<string, { ar: string; en: string }> = {
  NO_PRIVILEGE: {
    ar: "لا تملك صلاحية القرار المالي على التحصيلات.",
    en: "You do not hold the finance decision privilege for collections.",
  },
  SELF_SUBMITTED: {
    ar: "أنت من سجّل هذا التحصيل، فلا يمكنك اعتماده أو رفضه. يقرّره شخص آخر في المالية.",
    en: "You recorded this collection, so you cannot decide it. Another member of Finance does.",
  },
  NOT_PENDING: { ar: "صدر القرار على هذا التحصيل بالفعل.", en: "This collection has already been decided." },
  NOT_APPROVED: { ar: "العكس لا ينطبق إلا على تحصيل معتمَد.", en: "Only an approved collection can be reversed." },
};

type Payload = {
  rows: Collection[];
  /** Deals the caller could record against right now. Empty unless they may submit. */
  eligibleDeals?: EligibleDeal[];
  scope: "all" | "own";
  /** Per row: the same person may decide one collection and be refused the next. */
  decisions?: Record<string, RowDecision>;
  /** What approving each pending row would be worth. An estimate, never a total. */
  projectedCommission?: Record<string, string>;
  can: { submit: boolean; verify: boolean; reject: boolean; reverse: boolean };
  /** Exact per-status counts over the caller's whole scope (ALL = every status), whatever the
      active segment and the 200-row page. Absent from an older payload. */
  counts?: Record<string, number>;
  /** Qoyod parity: what each listed receipt is applied to (only for an invoices viewer). */
  allocations?: Record<string, { id: string; invoiceId: string; number: string | null; amount: string; appliedDate: string }[]>;
  /** Abu Fahd (friction 7): a pending collection holding a direct sale → the order number its approval releases. */
  releases?: Record<string, number>;
  /** Per-status sums (gross / net), over the same scope. */
  totals?: Record<string, { gross: string; net: string }>;
};

/** Status → its word and the reference status dot (`.st` + tone). */
const STATUS: Record<string, { en: string; ar: string; dot: string }> = {
  PENDING_VERIFICATION: { en: "Awaiting verification", ar: "بانتظار التحقق", dot: "wa" },
  APPROVED: { en: "Approved", ar: "معتمَد", dot: "ok" },
  REJECTED: { en: "Rejected", ar: "مرفوض", dot: "er" },
  REVERSED: { en: "Reversed", ar: "معكوس", dot: "x" },
};
/** The segments, in the frame's order. The server filters; the shorter names are the frame's. */
const SEGMENTS: { value: string; ar: string; en: string }[] = [
  { value: "", ar: "الكل", en: "All" },
  { value: "PENDING_VERIFICATION", ar: "بانتظار التحقق", en: "Awaiting verification" },
  { value: "APPROVED", ar: "معتمَد", en: "Approved" },
  { value: "REJECTED", ar: "مرفوض", en: "Rejected" },
  { value: "REVERSED", ar: "معكوس", en: "Reversed" },
];

const METHODS: Record<string, { en: string; ar: string }> = {
  BANK_TRANSFER: { en: "Bank transfer", ar: "تحويل بنكي" },
  CASH: { en: "Cash", ar: "نقداً" },
  CHEQUE: { en: "Cheque", ar: "شيك" },
  POS_CARD: { en: "Card", ar: "شبكة" },
  OTHER: { en: "Other", ar: "أخرى" },
};

/** P1 ERR-10: a collection the accountant returned for correction (and not yet corrected) is «رجع لك» — in the list AND the detail. */
const isReturned = (r: { status: string; decisionReasonCode?: string | null; correctedBy?: unknown }) =>
  r.status === "REJECTED" && r.decisionReasonCode === "RETURN_FOR_CORRECTION" && !r.correctedBy;

/** Abu Fahd R4 F7: a collection the rep corrected is not «مرفوض» to them — it is «رجع لك — صُحّح», pointing at the new one. */
const isCorrected = (r: { status: string; correctedBy?: unknown }) => r.status === "REJECTED" && !!r.correctedBy;

function StatusDot({ status, ar, returned = false, corrected = false }: { status: string; ar: boolean; returned?: boolean; corrected?: boolean }) {
  const s = STATUS[status] ?? STATUS.PENDING_VERIFICATION;
  return (
    <span className={`st ${corrected ? "x" : s.dot}`} data-testid={`collection-status-${status}`} data-corrected={corrected || undefined}>
      {corrected ? (ar ? "رجع لك — صُحّح" : "Back to you — corrected") : returned ? (ar ? "رجع لك" : "Back to you") : ar ? s.ar : s.en}
    </span>
  );
}

export default function CollectionsPage() {
  // Sales invoicing A2: «الفواتير والتحصيل» is one hub (Figma ZT-10); an invoices viewer gets its tabs here too.
  const viewer = useUser();
  const invoicesTabs = !!viewer && canViewInvoices(viewer.permissions);
  // Qoyod parity: in the accountant workspace this page is «سندات العملاء» (wording and column order only).
  const qoyod = useAccountantView();
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();

  const [data, setData] = useState<Payload | null>(null);
  const [status, setStatus] = useState("");
  const [onlyNoReceipt, setOnlyNoReceipt] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // The rep's view (owner-approved Figma page 09): a local filter over their own list.
  const [repFilter, setRepFilter] = useState<"all" | "pending" | "approved" | "returned">("all");
  const [dialog, setDialog] = useState<{ kind: "reject" | "return" | "reverse"; row: Collection } | null>(null);
  /** The row a reviewer has opened to look at properly before deciding. */
  const [detail, setDetail] = useState<Collection | null>(null);
  const [reason, setReason] = useState("");

  const t = useTerm();
  // A viewer who only records reads «التحصيل» under «التحصيل والعمولات» (Figma page 09); Finance keeps its titles.
  const recorderOnly = !!data && !(data.can.verify || data.can.reject || data.can.reverse);
  useD21Phone(recorderOnly
    ? { title: ar ? "التحصيل" : "Collections", sub: ar ? "التحصيل والعمولات" : "Collections & commissions" }
    : { title: qoyod ? t("collections") : (ar ? "التحصيلات" : "Collections"), sub: ar ? "الفواتير والتحصيل" : "Invoicing & collections" });
  // Qoyod parity (accountant workspace only): a filter card (period, customer) over the rows already loaded, the dark
  // title bar and the pager. The status segments, the server's scope and every decision stay as they are.
  const cf = useFilters({ from: "", to: "", customer: "", locations: [] as string[] });
  const riyadhDay = (iso: string) => new Date(Date.parse(iso) + 3 * 3600_000).toISOString().slice(0, 10);
  const custKey = (r: Collection) => r.customer?.id ?? "";
  // D20: a bank transfer still waiting for verification with no receipt — flagged on its row, and a quick filter.
  const noReceipt = (r: Collection) => r.status === "PENDING_VERIFICATION" && r.paymentMethod === "BANK_TRANSFER" && r._count.evidence === 0;
  const noReceiptChip = (r: Collection) => (
    <span className="c-noreceipt" data-testid={`no-receipt-${r.id}`} title={ar ? "تحويل بنكي بدون إيصال — طابقه مع كشف البنك" : "Bank transfer without a receipt — match it to the bank statement"}>
      {ar ? "بدون إيصال" : "No receipt"}
    </span>
  );
  const qRows = (data?.rows ?? []).filter((r) => !onlyNoReceipt || noReceipt(r)).filter((r) => !qoyod || ((!cf.applied.from || riyadhDay(r.collectedAt) >= cf.applied.from)
    && (!cf.applied.to || riyadhDay(r.collectedAt) <= cf.applied.to) && (!cf.applied.customer || custKey(r) === cf.applied.customer)
    && (!cf.applied.locations.length || cf.applied.locations.includes(r.branchId ?? UNASSIGNED_LOCATION))));
  const { pageRows, pager } = usePaging(qRows);
  const customerOptions = Array.from(new Map((data?.rows ?? []).filter((r) => r.customer).map((r) => [r.customer!.id, ar ? (r.customer!.nameAr ?? r.customer!.name) : r.customer!.name])).entries());

  /**
   * Reload counter. The fetch lives in the effect rather than a `useCallback` it calls, so
   * the first `await` precedes any state write. A decision bumps this to refresh.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const res = await api<Payload>(`/api/sales/collections?${params}`);
      if (cancelled) return;
      if (res.ok) {
        setData(res.data);
        setError("");
      } else {
        setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [status, ar, reloadToken]);

  async function decide(row: Collection, action: "approve" | "reject" | "return" | "reverse", why: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await api<{ status: string; commission: { employeeId: string; amount: string }[] }>(
      `/api/sales/collections/${row.id}/actions`,
      { method: "POST", body: { action, reason: why } },
    );
    setBusy(false);
    setDialog(null);
    setReason("");
    if (!res.ok) {
      setError(res.data.error ?? "");
      return;
    }
    // The commission the decision actually created, said out loud. A finance screen that
    // approves something and shows no consequence is a screen nobody trusts.
    const moved = (res.data.commission ?? [])
      .map((c) => moneyText(c.amount, row.currency, lang))
      .join(" · ");
    setSuccess(
      action === "approve"
        ? ar
          ? `اعتُمد التحصيل${moved ? ` · عمولة ${moved}` : ""}.`
          : `Collection approved${moved ? ` · commission ${moved}` : ""}.`
        : action === "reject"
          ? ar ? "رُفض التحصيل. لم تُنشأ أي عمولة." : "Collection rejected. No commission was created."
        : action === "return"
          ? ar ? "رجع التحصيل للمندوب يصحّحه — يشوفه «رجع لك»." : "Returned to the rep to correct — they see it under «Back to you»."
          : ar
            ? `عُكس التحصيل${moved ? ` · تسوية ${moved}` : ""}.`
            : `Collection reversed${moved ? ` · adjustment ${moved}` : ""}.`,
    );
    reload();
  }

  if (loading) return <div className="pg"><Spinner /></div>;
  if (!data) return <div className="pg"><p className="notice er" role="alert" data-testid="alert-error">{error}</p></div>;

  const rows = data.rows;
  const eligible = data.eligibleDeals ?? [];

  /**
   * The server's verdict for this row. Never recomputed here — the client does not get to
   * decide who may approve, and a client that tried would be wrong the moment the rules
   * changed on one side only.
   *
   * The fallback keeps an older payload rendering: no verdict means offer nothing, which is
   * the safe direction.
   */
  const decisionFor = (r: Collection): RowDecision =>
    data.decisions?.[r.id] ?? {
      approve: { allowed: false, reason: "NO_PRIVILEGE" },
      reject: { allowed: false, reason: "NO_PRIVILEGE" },
      reverse: { allowed: false, reason: "NO_PRIVILEGE" },
    };

  /**
   * The one reason worth printing beside a row, or null.
   *
   * Only for rows still open to a decision — a settled row needs no explanation for why it
   * has no buttons — and only for reasons somebody can act on. NOT_PENDING and NOT_APPROVED
   * are states the status already communicates.
   */
  function blockedReason(r: Collection): string | null {
    const d = decisionFor(r);
    const relevant = r.status === "PENDING_VERIFICATION" ? [d.approve, d.reject]
      : r.status === "APPROVED" ? [d.reverse]
        : [];
    if (relevant.length === 0 || relevant.some((a) => a.allowed)) return null;
    const reason = relevant.find((a) => a.reason === "SELF_SUBMITTED")?.reason ?? relevant[0].reason;
    return WHY_NOT[reason] ? reason : null;
  }
  const pending = rows.filter((r) => r.status === "PENDING_VERIFICATION");
  const approved = rows.filter((r) => r.status === "APPROVED");
  const sum = (list: Collection[], key: "amountGross" | "amountNet") =>
    list.reduce((a, r) => a + Number(r[key] ?? 0), 0).toFixed(2);
  // The header's figures: the server's sums over the whole scope (exact, whatever segment is
  // open); the on-screen rows only for an older payload without them.
  const serverSum = (st: string, key: "gross" | "net") => data.totals ? (data.totals[st]?.[key] ?? "0.00") : null;
  const pendingGross = serverSum("PENDING_VERIFICATION", "gross") ?? sum(pending, "amountGross");
  const approvedGross = serverSum("APPROVED", "gross") ?? sum(approved, "amountGross");
  const approvedNet = serverSum("APPROVED", "net") ?? sum(approved, "amountNet");
  const pendingCount = data.counts ? (data.counts.PENDING_VERIFICATION ?? 0) : pending.length;
  const allCount = data.counts ? (data.counts.ALL ?? 0) : rows.length;

  // Finance is anyone who can act on the queue. The screen calls itself what it is for the
  // person looking at it rather than showing everyone the same title.
  const isFinance = data.can.verify || data.can.reject || data.can.reverse;

  const customerOf = (r: Collection) => (r.customer ? (ar ? (r.customer.nameAr ?? r.customer.name) : r.customer.name) : null);
  /** «بن الشرق · طلبية سبتمبر»: the customer, then what is left of the deal's name. */
  const dealText = (r: Collection) => {
    const c = customerOf(r);
    if (!r.opportunity) return c ?? "—";
    const sub = splitTitle(r.opportunity.title, c).sub;
    return c ? (sub ? `${c} · ${sub}` : c) : r.opportunity.title;
  };
  const methodText = (m: string) => (ar ? (METHODS[m]?.ar ?? m) : (METHODS[m]?.en ?? m));
  const unit = ar ? "⃁" : "SAR";

  // Per-segment counts: the server's, exact on every segment (not limited to the rows loaded).
  const counts: Record<string, number> = data.counts ?? {};

  const notices = (
    <>
      {error && (
        <p className="notice er" role="alert" data-testid="alert-error" style={{ marginBottom: 16 }}>
          {error}<button type="button" onClick={() => setError("")} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
        </p>
      )}
      {success && (
        <p className="notice ok" role="status" data-testid="alert-success" style={{ marginBottom: 16 }}>
          {success}<button type="button" onClick={() => setSuccess("")} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
        </p>
      )}
    </>
  );

  const noReceiptCount = rows.filter(noReceipt).length;
  // أبو فهد B5: the filter on, nothing left without a receipt — said plainly, with the way back.
  const noReceiptDone = onlyNoReceipt && noReceiptCount === 0 ? (
    <p className="c-noreceipt-done" role="status" data-testid="no-receipt-none">
      {ar ? "ما فيه تحويلات بدون إيصال ✓" : "No transfers without a receipt ✓"}{" "}
      <button type="button" className="btn sm g" onClick={() => setOnlyNoReceipt(false)}>{ar ? "اعرض الكل" : "Show all"}</button>
    </p>
  ) : null;
  const noReceiptToggle = noReceiptCount > 0 || onlyNoReceipt ? (
    <button type="button" className={onlyNoReceipt ? "c-noreceipt-f on" : "c-noreceipt-f"} aria-pressed={onlyNoReceipt}
      onClick={() => setOnlyNoReceipt((v) => !v)} data-testid="collection-filter-no-receipt">
      {ar ? "بدون إيصال" : "No receipt"} <span className="n">{noReceiptCount}</span>
    </button>
  ) : null;
  const segments = (
    <div role="group" aria-label={ar ? "الحالة" : "Status"} className={phone ? "segs" : "seg"} data-testid="collection-status-filter">
      {SEGMENTS.map((s) => {
        const on = status === s.value;
        const n = s.value === "" ? null : (counts[s.value] ?? 0);
        return (
          <button key={s.value || "ALL"} type="button" aria-pressed={on} className={on ? "on" : undefined}
            data-testid={`collection-tab-${s.value || "ALL"}`} onClick={() => setStatus(s.value)}>
            {ar ? s.ar : s.en}
            {n !== null && <span className="n">{n}</span>}
          </button>
        );
      })}
    </div>
  );

  /* "Nothing here" is true but useless on its own when the reason is that the person is
     looking in the wrong place. If they hold the privilege and own a deal with money still
     outstanding, the empty state says so and takes them there. If they hold it and own nothing
     eligible, it says that instead. */
  const empty = (
    <div className="c-empty">
      <b>{ar ? "لا توجد تحصيلات." : "No collections."}</b>
      <p>
        {ar
          ? "يُسجَّل التحصيل من صفحة الصفقة بعد قبول عرض السعر."
          : "One is recorded from a deal, once its quotation has been accepted."}
      </p>
      {data.can.submit && eligible.length > 0 && (
        <div data-testid="eligible-deals">
          <p style={{ marginTop: 16 }}>{ar ? "صفقات يمكنك التسجيل عليها الآن:" : "Deals you can record against right now:"}</p>
          <ul className="c-elig">
            {eligible.map((d) => (
              <li key={d.id}>
                <Link href={`/dashboard/sales/deals/${d.id}#collections`} data-testid={`eligible-deal-${d.id}`}>
                  <span style={{ fontWeight: 500 }}>{d.title}</span>
                  <span className="sm">
                    <bdi className="id">{d.quoteNumber}</bdi>
                    {" · "}
                    {/* This list answers "what can I still submit against?", so it shows
                        capacity, and says so rather than saying "outstanding". */}
                    {ar ? "المتاح لتسجيل تحصيل إضافي " : "available to submit "}
                    <bdi className="n">{moneyText(d.availableToSubmit, d.currency, lang)}</bdi>
                    {" · "}
                    {ar ? "غير المسدد " : "unpaid "}
                    <bdi className="n">{moneyText(d.unpaid, d.currency, lang)}</bdi>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.can.submit && eligible.length === 0 && (
        <p data-testid="no-eligible-deals" style={{ marginTop: 10 }}>
          {ar
            ? "لا توجد لديك صفقة بعرض سعر مقبول وعليها متبقٍّ. سجّل قبول العميل على عرض سعر أولاً."
            : "You have no deal with an accepted quotation and an outstanding balance. Record a customer's acceptance first."}
        </p>
      )}
      {!data.can.submit && (
        <p data-testid="cannot-submit" style={{ marginTop: 10 }}>
          {ar
            ? "لا تملك صلاحية تسجيل التحصيل؛ هذه الشاشة للعرض فقط بالنسبة لك."
            : "You do not have the collection-submit permission; this screen is read-only for you."}
        </p>
      )}
    </div>
  );

  const commissionCell = (r: Collection) => {
    const accruals = r.collectionEvent?.accruals ?? [];
    // Pending is shown as an estimate and is NEVER added to anything.
    if (r.status === "PENDING_VERIFICATION") {
      return (
        <span className="wa" data-testid={`commission-pending-${r.id}`}>
          {ar ? "بانتظار الاعتماد" : "pending approval"}
        </span>
      );
    }
    if (accruals.length === 0) return <span className="sm">—</span>;
    return accruals.map((a, i) => (
      <span key={i} style={{ display: "block" }}>
        <span className="l1"><bdi className="n">{formatMoney(a.amount)}</bdi></span>
        <span className="sm">{a.employee.name}</span>
      </span>
    ));
  };

  const rowActions = (r: Collection) => {
    const d = decisionFor(r);
    const why = blockedReason(r);
    return (
      <div className="acts">
        {data?.releases?.[r.id] ? <span className="wa" data-testid={`releases-order-${r.id}`}>{ar ? `يفك الطلب #${data.releases[r.id]}` : `Releases order #${data.releases[r.id]}`}</span> : null}
        {why && (
          <span className="why" data-testid={`decision-blocked-${r.id}`} data-reason={why}>
            {ar ? WHY_NOT[why].ar : WHY_NOT[why].en}
          </span>
        )}
        {phone && noReceipt(r) ? noReceiptChip(r) : null}
        {r._count.evidence > 0 && (
          <span className="clip" data-testid={`evidence-count-${r.id}`} title={ar ? "إثباتات مرفقة" : "Evidence attached"}>
            <Paperclip size={13} aria-hidden /> <bdi className="n">{r._count.evidence}</bdi>
          </span>
        )}
        <button type="button" className="btn sm g" onClick={() => setDetail(r)} data-testid={`open-${r.id}`}>
          {ar ? "فتح" : "Open"}
        </button>
        {d.approve.allowed && (
          <button type="button" className="btn sm p" disabled={busy} onClick={() => decide(r, "approve", "")} data-testid={`approve-${r.id}`}>
            {ar ? "اعتماد التحصيل" : "Approve collection"}
          </button>
        )}
        {d.reject.allowed && (
          <button type="button" className="btn sm" disabled={busy} data-testid={`reject-${r.id}`}
            onClick={() => { setDialog({ kind: "reject", row: r }); setReason(""); }}>
            {ar ? "رفض التحصيل" : "Reject collection"}
          </button>
        )}
        {/* Owner أ: «رجّعه للتصحيح» — the endpoint and rules of «سندات العملاء» (reason of 10+, audited, the rep told). */}
        {d.reject.allowed && (
          <button type="button" className="btn sm" disabled={busy} data-testid={`return-${r.id}`}
            onClick={() => { setDialog({ kind: "return", row: r }); setReason(""); }}>
            {ar ? "رجّعه للتصحيح" : "Return for correction"}
          </button>
        )}
        {d.reverse.allowed && (
          <button type="button" className="btn sm" disabled={busy} data-testid={`reverse-${r.id}`}
            onClick={() => { setDialog({ kind: "reverse", row: r }); setReason(""); }}>
            {ar ? "عكس التحصيل" : "Reverse collection"}
          </button>
        )}
      </div>
    );
  };

  // Qoyod parity (accountant workspace only): «سندات العملاء» reads العميل · التاريخ · المبلغ · طريقة الدفع · الحالة first,
  // then our own net basis and commission, then «الخيارات». Same cells, same rows; everyone else keeps the frame's order.
  // A collection has no voucher number of its own, so there is no «المرجع» column (the bank reference sits under the amount).
  // QOYOD-REF §1.8: الجهة · رقم المرجع · (الحساب → طريقة الدفع) · الوصف · التاريخ · المبلغ · المبلغ غير المخصص · الحالة ·
  // الخيارات; our commission stays before the options (Finance decides with it).
  const COLS = qoyod
    ? (["deal", "ref", "method", "note", "date", "amount", "unallocated", "status", "commission", "actions"] as const)
    : (["deal", "amount", "net", "date", "method", "status", "commission", "actions"] as const);
  type Col = "deal" | "ref" | "note" | "unallocated" | "amount" | "net" | "date" | "method" | "status" | "commission" | "actions";
  const allocs = data.allocations;
  const allocatedCents = (r: Collection) => (allocs?.[r.id] ?? []).reduce((a, x) => a + Math.round(Number(x.amount) * 100), 0);
  const unallocated = (r: Collection) => (Math.round(Number(r.amountGross) * 100) - allocatedCents(r)) / 100;
  const allocPill = (r: Collection) => {
    if (!allocs || r.status !== "APPROVED") return null;
    const a = allocatedCents(r), g = Math.round(Number(r.amountGross) * 100);
    const [txt, tone] = a <= 0 ? [ar ? "غير مستعمل" : "Unused", "wa"] : a >= g ? [ar ? "مستعمل" : "Used", "ok"] : [ar ? "مستعمل جزئياً" : "Partly used", "wa"];
    return <span className={`st ${tone}`} style={{ marginInlineStart: 6 }} data-testid={`collection-use-${r.id}`}>{txt}</span>;
  };
  const head: Record<Col, ReactNode> = {
    deal: qoyod ? (ar ? "الجهة" : "Party") : (ar ? "الصفقة" : "Deal"),
    ref: ar ? "رقم المرجع" : "Reference",
    note: ar ? "الوصف" : "Description",
    unallocated: t("colUnallocated"),
    amount: ar ? "المبلغ" : "Amount",
    net: ar ? "الأساس الصافي" : "Net basis",
    date: ar ? "التاريخ" : "Date",
    method: qoyod ? t("colMethod") : (ar ? "الطريقة" : "Method"),
    status: ar ? "الحالة" : "Status",
    commission: ar ? "العمولة" : "Commission",
    actions: qoyod ? t("colOptions") : <span className="sr-only">{ar ? "الإجراءات" : "Actions"}</span>,
  };
  const cell = (r: Collection, k: Col) => {
    switch (k) {
      case "ref": return <td key={k}>{r.referenceNumber ? <bdi className="id" style={{ fontSize: 12 }}>{r.referenceNumber}</bdi> : r.quote ? <bdi className="id" style={{ fontSize: 12 }}>{r.quote.quoteNumber}</bdi> : <span className="sm">—</span>}</td>;
      case "note": return <td key={k} style={{ whiteSpace: "normal", maxWidth: 220 }}>{r.note ? <span className="sm" style={{ display: "inline" }}>{r.note}</span> : <span className="sm">—</span>}</td>;
      case "unallocated": return <td key={k}>{allocs ? <bdi className="n">{formatMoney(unallocated(r).toFixed(2))}</bdi> : <span className="sm">—</span>}</td>;
      case "deal": return (
        <td key={k} style={{ whiteSpace: "normal", minWidth: 200 }}>
          {r.opportunity ? (
            <Link href={`/dashboard/sales/deals/${r.opportunity.id}`} style={{ display: "block" }}>
              <b className="who"><bdi>{dealText(r)}</bdi></b>
            </Link>
          ) : <b className="who">{dealText(r)}</b>}
          <span className="sm">
            {r.quote && <bdi className="id" style={{ fontSize: 12 }}>{r.quote.quoteNumber}</bdi>}
            {r.quote && r.submittedBy && " · "}
            {r.submittedBy?.name}
          </span>
        </td>
      );
      case "amount": return (
        <td key={k}>
          <span className="l1"><bdi className="n">{formatMoney(r.amountGross)}</bdi></span>
          {r.referenceNumber && <span className="sm"><bdi className="id" style={{ fontSize: 12 }}>{r.referenceNumber}</bdi></span>}
        </td>
      );
      case "net": return (
        <td key={k}>
          <span className="l1"><bdi className="n">{r.amountNet === null ? "—" : formatMoney(r.amountNet)}</bdi></span>
          <span className="sm">{ar ? "ضريبة " : "tax "}<bdi className="n">{formatMoney(Number(r.amountTax).toFixed(2))}</bdi></span>
        </td>
      );
      case "date": return <td key={k}><bdi className="n">{formatDay(r.collectedAt)}</bdi></td>;
      case "method": return <td key={k}>{methodText(r.paymentMethod)}{noReceipt(r) ? <><br />{noReceiptChip(r)}</> : null}</td>;
      case "status": return (
        <td key={k} style={{ whiteSpace: "normal" }}>
          <StatusDot status={r.status} ar={ar} returned={isReturned(r)} corrected={isCorrected(r)} />
          {qoyod ? allocPill(r) : null}
          {(r.decisionReason || r.reversalReason) && (
            <span className="sm">{r.reversalReason ?? r.decisionReason}</span>
          )}
        </td>
      );
      case "commission": return <td key={k}>{commissionCell(r)}</td>;
      case "actions": return <td key={k} style={{ textAlign: "end" }}>{rowActions(r)}</td>;
    }
  };
  const table = (
    <div style={{ overflowX: "auto" }}>
      <table className="t coll" data-testid="collections-table" data-layout={qoyod ? "qoyod" : undefined} style={{ minWidth: 1000 }}>
        <thead>
          <tr>
            {COLS.map((k) => <th key={k} scope="col">{head[k]}</th>)}
          </tr>
        </thead>
        <tbody>
          {(qoyod ? pageRows : rows.filter((r) => !onlyNoReceipt || noReceipt(r))).map((r) => (
            <tr key={r.id} data-testid={`collection-${r.id}`} className={detail?.id === r.id ? "sel" : undefined}>
              {COLS.map((k) => cell(r, k))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const rules = (
    <section className="c-rules" aria-labelledby="c-rules-h">
      <div className="bh"><h2 className="bt" id="c-rules-h">{ar ? "قواعد هذه الشاشة" : "The rules this screen enforces"}</h2></div>
      <ul>
        {(ar
          ? [
              "التحصيل المسجَّل «بانتظار التحقق» لا يُنشئ أي عمولة. التقدير المعروض تقدير فقط ولا يدخل في أي مجموع.",
              "الاعتماد المالي وحده يُنشئ استحقاق العمولة، وأساسه صافي المحصَّل بعد الضريبة.",
              "من سجّل التحصيل لا يعتمده، مهما كانت صلاحياته. لا استثناء في هذا الإصدار.",
              "العكس لا يحذف شيئاً: القيد الأصلي يبقى كما اعتُمد، وتُكتب فوقه تسوية سالبة مرتبطة به.",
              "المتبقي غير المسدد هو قيمة العرض ناقص المعتمَد. المتاح لتسجيل تحصيل إضافي هو غير المسدد ناقص ما هو بانتظار التحقق، ولا يمكن تجاوزه.",
              "تحقّق مالي يدوي — ليس تسوية بنكية ولا ربطاً محاسبياً.",
            ]
          : [
              "A collection awaiting verification creates no commission. The estimate shown is an estimate and is in no total.",
              "Finance approval alone creates the entitlement, and its basis is the net collected after tax.",
              "Whoever recorded a collection does not approve it, whatever privileges they hold. No exception in this release.",
              "A reversal deletes nothing: the original stays exactly as approved, with a linked negative adjustment on top.",
              "The unpaid balance is the quotation less what is approved. What is available to submit is the unpaid balance less what is awaiting verification, and a collection cannot exceed it.",
              "Manual finance verification — not a bank settlement and not an accounting integration.",
            ]
        ).map((rule, i) => <li key={i}>{rule}</li>)}
      </ul>
    </section>
  );

  const decisionDialog = dialog ? (
    <Modal
      title={
        dialog.kind === "reject"
          ? (ar ? "رفض التحصيل" : "Reject the collection")
          : dialog.kind === "return" ? (ar ? "رجّعه للتصحيح" : "Return for correction")
          : (ar ? "عكس تحصيل معتمَد" : "Reverse an approved collection")
      }
      onClose={() => setDialog(null)}
      testId="collection-decision-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={() => setDialog(null)}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            variant="danger"
            disabled={busy || reason.trim().length < (dialog.kind === "return" ? 10 : 3)}
            testId="confirm-decision"
            onClick={() => decide(dialog.row, dialog.kind, reason)}
          >
            {dialog.kind === "reject" ? (ar ? "رفض" : "Reject") : dialog.kind === "return" ? (ar ? "رجّعه للمندوب" : "Return to the rep") : (ar ? "عكس" : "Reverse")}
          </Button>
        </>
      }
    >
      <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>
        <bdi>{dealText(dialog.row)}</bdi> · <bdi className="n">{moneyText(dialog.row.amountGross, dialog.row.currency, lang)}</bdi>
      </p>
      {dialog.kind !== "reverse" && data?.releases?.[dialog.row.id] ? (
        <p className="notice" data-testid="reject-holds-order">{ar
          ? dialog.kind === "return"
            ? `هذا التحصيل يفك الطلب #${data.releases[dialog.row.id]} (بيع مباشر والعميل فوق الحد). إذا رجّعته للتصحيح يظل الطلب موقوف لين يصحّحه المندوب وتعتمد التصحيح.`
            : `هذا التحصيل يفك الطلب #${data.releases[dialog.row.id]} (بيع مباشر والعميل فوق الحد). إذا رفضته يظل الطلب موقوف.`
          : dialog.kind === "return"
            ? `This collection releases order #${data.releases[dialog.row.id]} (a direct sale over the credit limit). Returned for correction, the order stays held until the rep corrects it and you approve the correction.`
            : `This collection releases order #${data.releases[dialog.row.id]} (a direct sale over the credit limit). Rejecting it keeps the order held.`}</p>
      ) : null}
      <p className="notice">
        {dialog.kind === "return"
          ? (ar
              ? "يرجع للمندوب يصحّحه ويرسله من جديد — السبب يظهر له (10 أحرف على الأقل). ما تُنشأ أي عمولة."
              : "It goes back to the rep to correct and resend — they see the reason (at least 10 characters). No commission is created.")
          : dialog.kind === "reject"
          ? (ar
              ? "لن تُنشأ أي عمولة. السبب يظهر للمندوب الذي سجّل التحصيل."
              : "No commission will be created. The reason is shown to the rep who recorded it.")
          : (ar
              ? "القيد الأصلي يبقى كما هو، وتُكتب تسوية سالبة مرتبطة به تُنقص العمولة بالمقدار نفسه. عكس تحصيل فكّ طلب بيع مباشر موقوف ما يرجّع إيقاف الطلب — الطلب الجاي لهالعميل يمر على فحص حد الائتمان العادي."
              : "The original stays as approved; a linked negative adjustment reduces the commission by the same amount. Reversing a collection that released a held direct sale does not hold that order again — the customer's next order goes through the normal credit-limit check.")}
      </p>
      <Field id="decision-reason" label={ar ? "السبب" : "Reason"} hint={ar ? "مطلوب." : "Required."}>
        <TextArea id="decision-reason" value={reason} onChange={setReason} rows={3} />
      </Field>
    </Modal>
  ) : null;

  /* ── One collection, opened to be decided ──
     Everything a finance decision rests on, in one place: what arrived, how much of it is tax,
     what the commission is actually computed on, what approving would be worth, and the
     evidence itself. Approving from a table row alone is approving a figure nobody opened. */
  const drawer = detail ? (() => {
    const d = decisionFor(detail);
    const why = blockedReason(detail);
    const accruals = detail.collectionEvent?.accruals ?? [];
    return (
      <div className="c-scrim" role="presentation" onClick={() => setDetail(null)}>
        <FocusDialog onClose={() => setDetail(null)} className="c-drawer" testId="collection-detail" labelledBy="c-detail-h">
          <div className="hd">
            <div style={{ minWidth: 0 }}>
              <h2 id="c-detail-h">{ar ? "تفاصيل التحصيل" : "Collection detail"}</h2>
              <div className="sub">
                <bdi>{dealText(detail)}</bdi>
                {detail.quote && <> · <bdi className="id" style={{ fontSize: 12 }}>{detail.quote.quoteNumber}</bdi></>}
              </div>
              <StatusDot status={detail.status} ar={ar} returned={isReturned(detail)} corrected={isCorrected(detail)} />
            </div>
            <button type="button" className="ib" onClick={() => setDetail(null)} aria-label={ar ? "إغلاق" : "Close"}>
              <Ico name="close" />
            </button>
          </div>
          <div className="bd">
            <dl className="c-figs" data-testid="detail-figures">
              <dt>{ar ? "المبلغ المستلم (إجمالي)" : "Amount received (gross)"}</dt>
              <dd><bdi className="n">{formatMoney(detail.amountGross)}</bdi> {unit}</dd>
              <dt>{ar ? "منه ضريبة" : "of which tax"}</dt>
              <dd><bdi className="n">{formatMoney(detail.amountTax)}</bdi></dd>
              {detail.amountNet !== null ? <>
              <dt>{ar ? "الأساس الصافي للعمولة" : "Net basis for commission"}</dt>
              <dd className="net"><bdi className="n">{formatMoney(detail.amountNet)}</bdi></dd>
              </> : null}
              {detail.amountNet !== null ? <>
              <dt>
                {detail.status === "PENDING_VERIFICATION"
                  ? (ar ? "أثر العمولة عند الاعتماد" : "Commission effect if approved")
                  : (ar ? "أثر العمولة" : "Commission effect")}
              </dt>
              <dd data-testid="detail-commission">
                {detail.status === "PENDING_VERIFICATION" ? (
                  data.projectedCommission?.[detail.id] ? (
                    <>
                      <bdi className="n est">{formatMoney(data.projectedCommission[detail.id])}</bdi>
                      <span className="mut">{" · "}{ar ? "تقدير، لا يدخل أي مجموع قبل الاعتماد" : "estimate, in no total until approved"}</span>
                    </>
                  ) : (
                    <span className="mut">{ar ? "لا خطة عمولة سارية" : "no active commission plan"}</span>
                  )
                ) : accruals.length === 0 ? (
                  <span className="mut">—</span>
                ) : (
                  accruals.map((a, k) => (
                    <span key={k} style={{ display: "block" }}>
                      <bdi className="n">{formatMoney(a.amount)}</bdi>
                      <span className="mut"> · {a.employee.name}</span>
                    </span>
                  ))
                )}
              </dd>
              </> : null}
              <dt>{ar ? "الطريقة · المرجع" : "Method · reference"}</dt>
              <dd>
                {methodText(detail.paymentMethod)}
                {detail.referenceNumber && <> · <bdi className="id">{detail.referenceNumber}</bdi></>}
              </dd>
              <dt>{ar ? "سجّله" : "Recorded by"}</dt>
              <dd>
                {detail.submittedBy?.name ?? "—"} · <bdi className="n">{formatDay(detail.collectedAt)}</bdi>
              </dd>
            </dl>

            {(detail.decisionReason || detail.reversalReason) && (
              <p className="c-reason">{detail.reversalReason ?? detail.decisionReason}</p>
            )}
            {detail.receiptNumber ? (
              <p className="lbl" style={{ fontWeight: 400, margin: "0 0 8px" }} data-testid="detail-receipt-number">{ar ? "سند قبض" : "Receipt"} <bdi className="id">{detail.receiptNumber}</bdi>{detail.status === "REVERSED" ? (ar ? " · معكوس" : " · reversed") : ""}</p>
            ) : null}
            {detail.status === "REJECTED" && detail.decisionReasonCode === "RETURN_FOR_CORRECTION" && detail.submittedBy?.id === viewer?.id ? (
              <CorrectCollection row={detail} ar={ar} onDone={(msg) => { setDetail(null); setSuccess(msg); reload(); }} onError={setError}
                onOpenCorrection={(id) => { const next = rows.find((x) => x.id === id); if (next) setDetail(next); }} />
            ) : null}

            {qoyod && allocs ? (
              <section data-testid="detail-allocations" style={{ margin: "12px 0" }}>
                <p className="c-ev-h">{ar ? "تخصيصات السند" : "Receipt allocations"}</p>
                {(allocs[detail.id] ?? []).length === 0 ? (
                  <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>{ar ? "لم يُخصَّص هذا التحصيل لأي فاتورة بعد." : "Not applied to any invoice yet."}</p>
                ) : (
                  <table className="t" style={{ width: "100%" }}>
                    <thead><tr><th scope="col">#</th><th scope="col">{ar ? "التاريخ" : "Date"}</th><th scope="col">{ar ? "المخصص له" : "Applied to"}</th><th scope="col">{ar ? "رقم المرجع" : "Reference"}</th><th scope="col">{ar ? "المبلغ" : "Amount"}</th></tr></thead>
                    <tbody>
                      {(allocs[detail.id] ?? []).map((a, i) => (
                        <tr key={a.id}><td><bdi className="n">{i + 1}</bdi></td><td><bdi className="n">{a.appliedDate}</bdi></td><td>{ar ? "فاتورة مبيعات" : "Sales invoice"}</td>
                          <td><Link href={`/dashboard/sales/invoices/${a.invoiceId}`}><bdi className="id">{a.number ?? "—"}</bdi></Link></td><td><bdi className="n">{formatMoney(a.amount)}</bdi></td></tr>
                      ))}
                      <tr><td colSpan={4}><b>{ar ? "المجموع" : "Total"}</b></td><td><b><bdi className="n">{formatMoney((allocatedCents(detail) / 100).toFixed(2))}</bdi></b></td></tr>
                    </tbody>
                  </table>
                )}
                <p className="lbl" style={{ fontWeight: 400, margin: "6px 0 0" }}>{ar ? "المبلغ غير المخصص" : "Unallocated"}: <bdi className="n">{formatMoney(unallocated(detail).toFixed(2))}</bdi> {unit}</p>
              </section>
            ) : null}

            <p className="c-ev-h">{ar ? "الإثبات" : "Evidence"}</p>
            {(detail.evidence ?? []).length === 0 ? (
              <p className="lbl" style={{ fontWeight: 400, margin: 0 }} data-testid="detail-no-evidence">
                {ar ? "لم يُرفق أي إثبات بهذا التحصيل." : "No evidence was attached to this collection."}
              </p>
            ) : (
              <ul className="c-ev" data-testid="detail-evidence">
                {(detail.evidence ?? []).map((e) => (
                  <li key={e.id}>
                    {/* The one route that returns the bytes. It re-checks the session and the
                        same visibility rule, and answers as an attachment with no-store. */}
                    <a href={`/api/sales/collections/${detail.id}/evidence/${e.id}`} target="_blank" rel="noreferrer"
                      data-testid={`detail-evidence-${e.id}`}>
                      <Ico name="note" small />
                      <span className="t">
                        <b>{e.filename}</b>
                        <span>{e.mimeType} · <bdi className="n">{Math.max(1, Math.round(e.byteSize / 1024))}</bdi> {ar ? "كيلوبايت" : "KB"}</span>
                      </span>
                      <span className="btn sm" aria-hidden>{ar ? "فتح" : "Open"}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {why && (
              <p className="c-blocked" data-testid="detail-blocked" data-reason={why}>
                {ar ? WHY_NOT[why].ar : WHY_NOT[why].en}
              </p>
            )}
          </div>
          <div className="ft">
            {d.approve.allowed && (
              <button type="button" className="btn p" disabled={busy} data-testid="detail-approve"
                onClick={() => { const r = detail; setDetail(null); decide(r, "approve", ""); }}>
                {ar ? "اعتماد التحصيل" : "Approve collection"}
              </button>
            )}
            {d.reject.allowed && (
              <button type="button" className="btn" disabled={busy} data-testid="detail-reject"
                onClick={() => { setDialog({ kind: "reject", row: detail }); setReason(""); setDetail(null); }}>
                {ar ? "رفض التحصيل" : "Reject collection"}
              </button>
            )}
            {d.reject.allowed && (
              <button type="button" className="btn" disabled={busy} data-testid="detail-return"
                onClick={() => { setDialog({ kind: "return", row: detail }); setReason(""); setDetail(null); }}>
                {ar ? "رجّعه للتصحيح" : "Return for correction"}
              </button>
            )}
            {d.reverse.allowed && (
              <button type="button" className="btn" disabled={busy} data-testid="detail-reverse"
                onClick={() => { setDialog({ kind: "reverse", row: detail }); setReason(""); setDetail(null); }}>
                {ar ? "عكس التحصيل" : "Reverse collection"}
              </button>
            )}
            <button type="button" className="btn g end" onClick={() => setDetail(null)}>{ar ? "إغلاق" : "Close"}</button>
          </div>
        </FocusDialog>
      </div>
    );
  })() : null;

  // «التحصيل» for whoever only records (owner-approved Figma page 09, 3 Nov 2026): what is waiting for finance, what
  // was approved, what came back to fix, the customers who still owe, and the list — in plain words. Finance keeps its queue.
  if (!isFinance) {
    const returned = rows.filter((r) => r.status === "REJECTED" && r.decisionReasonCode === "RETURN_FOR_CORRECTION" && !r.correctedBy);
    const returnedSum = returned.reduce((a, r) => a + Number(r.amountGross), 0);
    // P2 UXM-21: money collected or invoiced keeps its halalas.
    const whole = (v: string | number) => halalas(v);
    const word = (r: Collection): [string, string] =>
      r.status === "PENDING_VERIFICATION" ? [ar ? "بانتظار المالية" : "Awaiting finance", "t-wa"]
        : r.status === "APPROVED" ? [ar ? "معتمد" : "Approved", "t-ok"]
          : r.status === "REVERSED" ? [ar ? "معكوس" : "Reversed", "t-in"]
            : returned.includes(r) ? [ar ? "رجع لك" : "Back to you", "t-er"]
              : isCorrected(r) ? [ar ? "رجع لك — صُحّح" : "Back to you — corrected", "t-in"] : [ar ? "مرفوض" : "Rejected", "t-er"];
    const shown = rows.filter((r) => repFilter === "all" ? true : repFilter === "pending" ? r.status === "PENDING_VERIFICATION" : repFilter === "approved" ? r.status === "APPROVED" : returned.includes(r));
    const recordHref = eligible.length === 1 ? `/dashboard/sales/deals/${eligible[0].id}#collections` : "#mny-owing";
    const dayText = (iso: string) => new Date(iso).toLocaleDateString(ar ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", { day: "numeric", month: "long", timeZone: "Asia/Riyadh" });
    return (
      <div className="pg">
        {notices}
        {invoicesTabs ? (
          <nav className="hr-tabs is-underline" aria-label={ar ? "الفواتير والتحصيل" : "Invoices & collections"} data-testid="hub-tabs" style={{ marginBottom: 12 }}>
            <Link className="hr-tab" href="/dashboard/sales/invoices">{ar ? "فواتير المبيعات" : "Sales invoices"}</Link>
            <span className="hr-tab" aria-selected="true" aria-current="page">{ar ? "التحصيل" : "Collections"}</span>
          </nav>
        ) : null}
        <div className="mny" data-testid="collections-rep">
          <div className="mny-top">
            <div>{phone ? null : <h1>{ar ? "التحصيل" : "Collections"}</h1>}<p>{ar ? "الفلوس اللي استلمتها من العملاء، ووين وصلت" : "The money you received from customers, and where it got to"}</p></div>
            {/* Abu Fahd R4 F6: with no deal due for collection the button said nothing — say why instead. */}
            {data.can.submit ? (eligible.length
              ? <Link className="btn p" href={recordHref} data-testid="record-collection" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Ico name="plus" small />{ar ? "سجّل تحصيل" : "Record a collection"}</Link>
              : <span className="lbl" style={{ fontWeight: 400 }} data-testid="record-collection-none">{ar ? "ما فيه صفقات مستحقة للتحصيل الحين" : "No deal is due for collection right now"}</span>) : null}
          </div>
          <div className="mny-row" style={{ ["--n" as string]: 3 }}>
            <div className="mny-stt t-wa" data-testid="stat-pending"><span className="h"><Ico name="clock" small />{ar ? "بانتظار المالية" : "Awaiting finance"}</span><b className="num">{whole(pendingGross)} {unit}</b></div>
            <div className="mny-stt t-ok" data-testid="stat-approved"><span className="h"><Ico name="tick" small />{ar ? "اعتمدتها المالية" : "Approved"}</span><b className="num">{whole(approvedGross)} {unit}</b></div>
            <div className="mny-stt t-er" data-testid="stat-returned"><span className="h"><Ico name="back" small />{ar ? "رجعت لك" : "Back to you"}</span><b className="num">{whole(returnedSum)} {unit}</b></div>
          </div>
          {returned.length ? (
            <section className="mny-card" aria-labelledby="mny-need-h" style={{ boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--status-danger) 25%, transparent)" }} data-testid="collections-returned">
              <div className="mny-h"><div><h2 id="mny-need-h">{ar ? "يحتاج منك" : "Needs you"}</h2><small>{ar ? "رجّعتها المالية — صحّحها وأرسلها من جديد" : "Finance sent these back — fix and resend"}</small></div></div>
              {returned.map((r) => (
                <div key={r.id} className="mny-need">
                  <Ico name="back" small />
                  <span className="mny-li-t"><b><bdi>{customerOf(r) ?? dealText(r)}</bdi> · <span className="num">{whole(r.amountGross)} {unit}</span></b>{r.decisionReason ? <small>{ar ? "السبب: " : "Reason: "}{r.decisionReason}</small> : null}</span>
                  <button type="button" className="mny-btn" style={{ color: "var(--status-danger)" }} onClick={() => setDetail(r)} data-testid={`fix-${r.id}`}>{ar ? "صحّحه" : "Fix it"}</button>
                </div>
              ))}
            </section>
          ) : null}
          <div className="mny-row side">
            <section className="mny-card" aria-labelledby="mny-mine-h" data-testid="collections-table">
              <div className="mny-h"><div><h2 id="mny-mine-h">{ar ? "تحصيلاتي" : "My collections"}</h2><small>{ar ? "الأحدث أولًا" : "Newest first"}</small></div>
                <span className="mny-chips" role="group" aria-label={ar ? "الحالة" : "Status"}>
                  {([["all", "الكل", "All"], ["pending", "بانتظار", "Waiting"], ["approved", "معتمد", "Approved"], ["returned", "رجع لك", "Back to you"]] as const).map(([k, a2, e]) => (
                    <button key={k} type="button" aria-pressed={repFilter === k} onClick={() => setRepFilter(k)}>{ar ? a2 : e}</button>
                  ))}
                </span></div>
              {shown.length ? (
                <div className="mny-list">
                  {shown.map((r) => {
                    const w = word(r);
                    return (
                      <button key={r.id} type="button" className="mny-li" onClick={() => setDetail(r)} data-testid={`collection-${r.id}`}>
                        <span className="mny-ib t-pr"><Ico name="wallet" small /></span>
                        <span className="mny-li-t"><b><bdi>{customerOf(r) ?? dealText(r)}</bdi></b><small>{dayText(r.collectedAt)} · {methodText(r.paymentMethod)}</small></span>
                        <span className="n num">{whole(r.amountGross)} {unit}</span>
                        <span className={`mny-pill ${w[1]}`}>{w[0]}</span>
                        <Ico name="chev" small style={{ transform: ar ? "scaleX(-1)" : undefined, color: "var(--text-muted)" }} />
                      </button>
                    );
                  })}
                </div>
              ) : <p className="mny-note box">{rows.length ? (ar ? "ما فيه تحصيلات بهالحالة." : "None in this state.") : (ar ? "ما سجّلت تحصيلات للحين. لما تستلم من عميل، سجّله من «عملاء عليهم مبالغ»." : "No collections yet.")}</p>}
            </section>
            <section className="mny-card" id="mny-owing" aria-labelledby="mny-owe-h" data-testid="eligible-deals">
              <div className="mny-h"><div><h2 id="mny-owe-h">{ar ? "عملاء عليهم مبالغ" : "Customers who owe"}</h2><small>{ar ? "اضغط «سجّل» لما تستلم" : "Tap «Record» when you receive"}</small></div></div>
              {eligible.length ? (
                <div className="mny-list">
                  {eligible.map((d) => (
                    <div key={d.id} className="mny-li">
                      <span className="mny-li-t"><b><bdi>{d.title}</bdi></b><small>{ar ? "عرض سعر مقبول" : "Accepted quotation"} · <bdi className="num">{d.quoteNumber}</bdi></small></span>
                      <span className="n num">{whole(d.availableToSubmit)} {unit}</span>
                      {data.can.submit ? <Link className="mny-btn" href={`/dashboard/sales/deals/${d.id}#collections`} data-testid={`eligible-deal-${d.id}`}><Ico name="plus" small />{ar ? "سجّل" : "Record"}</Link> : null}
                    </div>
                  ))}
                </div>
              ) : <p className="mny-note box" data-testid="no-eligible-deals">{ar ? "ما فيه عميل عليه مبلغ تقدر تسجّله الحين. التحصيل يكون على صفقة عرضها مقبول." : "No customer owes on an accepted quotation right now."}</p>}
            </section>
          </div>
          <p className="mny-note box"><Ico name="note" small />{ar ? "كيف يمشي التحصيل؟ تسجّله أنت ← المالية تتأكد منه ← لما تعتمده تنحسب عمولتك. لو فيه شي ناقص يرجع لك هنا في «يحتاج منك»." : "You record it → finance checks it → once approved, your commission counts. If something is missing it comes back here."}</p>
        </div>
        {decisionDialog}
        {drawer}
      </div>
    );
  }

  if (phone) {
    return (
      <div className="pg">
        {notices}
        {segments}
        {noReceiptToggle}
        {noReceiptDone}
        {rows.length === 0 ? empty : (
          <div data-testid="collections-table">
            {rows.filter((r) => !onlyNoReceipt || noReceipt(r)).map((r) => (
              <div key={r.id} className="c-mrow" data-testid={`collection-${r.id}`}>
                <b><bdi>{customerOf(r) ?? dealText(r)}</bdi></b>
                <span className="n" style={{ fontSize: 14.5 }}>{formatMoney(r.amountGross)}</span>
                <span className="r2">
                  {r.quote && <bdi className="id" style={{ fontSize: 12 }}>{r.quote.quoteNumber}</bdi>}
                  {r.quote && " · "}
                  <bdi className="n">{formatDay(r.collectedAt).slice(0, 5)}</bdi>
                </span>
                <StatusDot status={r.status} ar={ar} returned={isReturned(r)} corrected={isCorrected(r)} />
                <button type="button" className="open" onClick={() => setDetail(r)} data-testid={`open-${r.id}`}
                  aria-label={`${ar ? "فتح" : "Open"} ${dealText(r)}`} />
              </div>
            ))}
            <p className="lbl" style={{ fontWeight: 400, marginTop: 12 }}>
              {(() => {
                const of = status ? (counts[status] ?? rows.length) : allCount;
                return ar ? `يُعرض ${num(rows.length, lang)} من ${num(of, lang)} · الأحدث أولًا` : `${rows.length} of ${of} shown · newest first`;
              })()}
            </p>
          </div>
        )}
        {decisionDialog}
        {drawer}
      </div>
    );
  }

  return (
    <div className="pg">
      {notices}
      <div className="ph">
        <div>
          <h1>{qoyod ? t("collections") : (ar ? "التحصيلات" : "Collections")}</h1>
          <div className="meta">
            <span>
              {isFinance
                ? (ar ? "قائمة التحقق المالي" : "The finance verification queue")
                : (ar ? "تحصيلاتك وحالتها" : "Your collections and where they got to")}
            </span>
            <i />
            <span>{ar ? "الاعتماد وحده يُنشئ العمولة" : "Approval alone creates commission"}</span>
          </div>
        </div>
      </div>

      {invoicesTabs ? (
        <nav className="hr-tabs is-underline" aria-label={ar ? "الفواتير والتحصيل" : "Invoices & collections"} data-testid="hub-tabs" style={{ marginBottom: 12 }}>
          <Link className="hr-tab" href="/dashboard/sales/invoices">{ar ? "فواتير المبيعات" : "Sales invoices"}</Link>
          <Link className="hr-tab" href="/dashboard/sales/invoices?tab=notes">{ar ? "الإشعارات الدائنة والمدينة" : "Credit & debit notes"}</Link>
          <span className="hr-tab" aria-selected="true" aria-current="page">{qoyod ? t("collections") : (ar ? "التحصيلات" : "Collections")}</span>
          <Link className="hr-tab" href="/dashboard/sales/receivables">{ar ? "أعمار الذمم وكشوف العملاء" : "AR aging & statements"}</Link>
        </nav>
      ) : null}
      <dl className="metrics c-metrics">
        <div data-testid="stat-pending">
          <dt>{ar ? "بانتظار التحقق" : "Awaiting verification"}</dt>
          <dd className="mid"><bdi className="n">{formatMoney(pendingGross)}</bdi></dd>
          <dd className="d">
            {ar ? `${num(pendingCount, lang)} تحصيل — لم يُنشئ عمولة` : `${pendingCount} — no commission yet`}
          </dd>
        </div>
        <div data-testid="stat-approved">
          <dt>{ar ? "معتمَد" : "Approved"}</dt>
          <dd className="mid"><bdi className="n">{formatMoney(approvedGross)}</bdi></dd>
          <dd className="d">
            {ar ? "الأساس الصافي " : "Net basis "}<bdi className="n">{formatMoney(approvedNet)}</bdi>
          </dd>
        </div>
        <div data-testid="stat-count">
          <dt>{ar ? "الإجمالي المعروض" : "Shown here"}</dt>
          <dd className="mid"><bdi className="n">{num(allCount, lang)}</bdi></dd>
          <dd className="d">{data.scope === "all" ? (ar ? "كل التحصيلات" : "All collections") : (ar ? "تحصيلاتك أنت" : "Your own only")}</dd>
        </div>
      </dl>

      {noReceiptDone}
      <div className="c-tool">
        {segments}
        {noReceiptToggle}
        <span className="sp" />
        <span className="sort-note">{ar ? "الأحدث أولًا · حتى 200 تحصيل" : "Newest first · up to 200"}</span>
      </div>

      {qoyod ? (
        <FilterCard onApply={cf.apply} onReset={cf.reset} testId="collections-filter">
          <DateRange from={cf.draft.from} to={cf.draft.to} onChange={(r) => cf.setDraft({ ...cf.draft, ...r })} />
          <div className="qc-field"><span className="qc-label">{t("colCustomer")}</span>
            <select className="c-qselect" value={cf.draft.customer} onChange={(e) => cf.set("customer", e.target.value)} aria-label={t("colCustomer")} data-testid="qf-customer">
              <option value="">{ar ? "الكل" : "All"}</option>
              {customerOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select></div>
          <LocationFilter value={cf.draft.locations} onChange={(v) => cf.set("locations", v)} testId="collections-locations" />
        </FilterCard>
      ) : null}
      {rows.length === 0 ? empty : qoyod ? (
        <Section title={t("collections")} testId="collections-section">
          <ListPageSize {...pager} />
          {table}
          <ListFooter {...pager} noun={ar ? "سند" : "receipts"} emptyText={ar ? "لا توجد أي سندات" : "No receipts"} />
        </Section>
      ) : table}
      {rules}
      {decisionDialog}
      {drawer}
    </div>
  );
}


/**
 * «نسخ وتصحيح» (BATCH22 WP-D): the accountant returned this collection for correction. A NEW pending collection is made
 * from it — the amount, date and reference corrected here, its evidence copied — and the returned one stays as it is.
 */
function CorrectCollection({ row, ar, onDone, onError, onOpenCorrection }: { row: Collection; ar: boolean; onDone: (msg: string) => void; onError: (msg: string) => void; onOpenCorrection?: (id: string) => void }) {
  const [amount, setAmount] = useState(Number(row.amountGross).toFixed(2));
  const [date, setDate] = useState(new Date(Date.parse(row.collectedAt) + 3 * 3600_000).toISOString().slice(0, 10));
  const [ref, setRef] = useState(row.referenceNumber ?? "");
  const [today] = useState(() => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  // P1 ERR-10 (approved Figma 2033:57): «صحّحه» carries the receipt — checked the moment it is chosen (size up to 5 MB,
  // PDF or image, not empty), its error under the field; uploaded to the corrected collection right after it is made.
  const [receipt, setReceipt] = useState<File | null>(null);
  const [receiptErr, setReceiptErr] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [key] = useState(() => `fix-${row.id}-${Math.random().toString(36).slice(2, 10)}`);
  if (row.correctedBy) {
    return (
      <p className="lbl" style={{ fontWeight: 400 }} data-testid="detail-corrected">{ar ? "صُحّح هذا التحصيل بتحصيل جديد." : "This collection was corrected by a new one."}{" "}
        {onOpenCorrection ? <button type="button" className="btn sm g" onClick={() => onOpenCorrection(row.correctedBy!.id)} data-testid="open-correction">{ar ? "افتح التصحيح ←" : "Open the correction →"}</button> : null}
      </p>
    );
  }
  async function choose(f: File | null) {
    setReceiptErr(""); setReceipt(null);
    if (!f) return;
    setPreparing(true);
    const r = await prepareReceipt(f);
    setPreparing(false);
    if (r.ok) setReceipt(r.file); else setReceiptErr(ar ? r.ar : r.en);
  }
  async function go() {
    setBusy(true);
    const res = await api<{ collectionId: string }>(`/api/sales/collections/${row.id}/correct`, { method: "POST", body: { idempotencyKey: key, amountGross: amount, collectedAt: `${date}T12:00:00+03:00`, referenceNumber: ref || null } });
    if (!res.ok) { setBusy(false); onError(res.data.error ?? ""); return; }
    let uploadNote = "";
    if (receipt && res.data.collectionId) {
      const form = new FormData();
      form.append("file", receipt);
      const up = await fetch(`/api/sales/collections/${res.data.collectionId}/evidence`, { method: "POST", body: form }).catch(() => null);
      if (!up || !up.ok) uploadNote = ar ? " الإيصال ما انرفع — أرفقه من التحصيل الجديد." : " The receipt was not uploaded — attach it on the new collection.";
    }
    setBusy(false);
    onDone((ar ? "أُنشئ تحصيل مصحّح وأُرسل للتأكيد." : "A corrected collection was created and sent for confirmation.") + uploadNote);
  }
  return (
    <section data-testid="detail-correct" className="mny-fix">
      <p className="c-ev-h">{ar ? "أُعيد إليك للتصحيح" : "Returned to you for correction"}</p>
      <label className="mny-fix-f">{ar ? "المبلغ (⃁)" : "Amount (SAR)"}<input className="mny-fix-in" dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="correct-amount" /></label>
      {/* The app's date format («12 نوفمبر 2026»), the native picker behind it. */}
      <label className="mny-fix-f">{ar ? "تاريخ التحصيل" : "Collected on"}
        <span className="mny-fix-in mny-fix-pick" data-testid="correct-date-text"><Ico name="cal" small /><span>{fullDate(`${date}T12:00:00+03:00`, ar)}</span>
          <input className="mny-fix-sr" type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} onClick={(e) => (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.()} data-testid="correct-date" />
        </span>
      </label>
      <label className="mny-fix-f">{ar ? "المرجع (اختياري)" : "Reference (optional)"}<input className="mny-fix-in" dir="ltr" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={ar ? "رقم الحوالة أو الإيصال" : "Transfer or receipt number"} data-testid="correct-ref" /></label>
      <div className="mny-fix-f">{row.paymentMethod === "BANK_TRANSFER" ? (ar ? "إيصال التحويل" : "Transfer receipt") : (ar ? "الإيصال" : "Receipt")}
        <label className="mny-fix-in mny-fix-pick" data-testid="correct-receipt-pick"><Paperclip size={14} aria-hidden />
          <span>{receipt ? receipt.name : (ar ? "أرفق صورة الإيصال أو PDF" : "Attach the receipt (image or PDF)")}</span>
          <input className="mny-fix-sr" type="file" accept="application/pdf,image/*" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; void choose(f); }} data-testid="correct-receipt" aria-invalid={!!receiptErr} aria-describedby="correct-receipt-help" />
        </label>
      </div>
      {preparing ? <span className="mny-fix-help">{ar ? "جارٍ تجهيز الملف…" : "Preparing the file…"}</span> : null}
      {receipt && !receiptErr ? <span className="mny-fix-help" data-testid="correct-receipt-ok"><bdi>{receipt.name}</bdi> · <bdi className="n">{Math.max(1, Math.round(receipt.size / 1024))}</bdi> {ar ? "ك.ب ✓" : "KB ✓"}</span> : null}
      {receiptErr ? <span className="c-field-err" role="alert" data-testid="correct-receipt-error">{receiptErr}</span>
        : <span id="correct-receipt-help" className="mny-fix-help">{ar ? "PDF أو صورة، حتى 5 ميجا." : "PDF or an image, up to 5 MB."}</span>}
      <button type="button" className="btn p" disabled={busy || preparing || !!receiptErr} onClick={go} data-testid="correct-submit">{ar ? "أرسل التصحيح" : "Send the correction"}</button>
    </section>
  );
}
