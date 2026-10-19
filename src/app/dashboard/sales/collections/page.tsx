"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Paperclip } from "lucide-react";
import {
  useLang, Spinner, Modal, Field, TextArea, Button, FocusDialog, api, formatDay, formatMoney, num, moneyText,
} from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import { splitTitle } from "@/components/d21/labels";

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
  status: "PENDING_VERIFICATION" | "APPROVED" | "REJECTED" | "REVERSED";
  amountGross: string;
  amountTax: string;
  amountNet: string;
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

function StatusDot({ status, ar }: { status: string; ar: boolean }) {
  const s = STATUS[status] ?? STATUS.PENDING_VERIFICATION;
  return (
    <span className={`st ${s.dot}`} data-testid={`collection-status-${status}`}>
      {ar ? s.ar : s.en}
    </span>
  );
}

export default function CollectionsPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();

  const [data, setData] = useState<Payload | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dialog, setDialog] = useState<{ kind: "reject" | "reverse"; row: Collection } | null>(null);
  /** The row a reviewer has opened to look at properly before deciding. */
  const [detail, setDetail] = useState<Collection | null>(null);
  const [reason, setReason] = useState("");

  useD21Phone({ title: ar ? "التحصيلات" : "Collections", sub: ar ? "الفواتير والتحصيل" : "Invoicing & collections" });

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

  async function decide(row: Collection, action: "approve" | "reject" | "reverse", why: string) {
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
    list.reduce((a, r) => a + Number(r[key]), 0).toFixed(2);
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
  const unit = ar ? "ر.س" : "SAR";

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
        {why && (
          <span className="why" data-testid={`decision-blocked-${r.id}`} data-reason={why}>
            {ar ? WHY_NOT[why].ar : WHY_NOT[why].en}
          </span>
        )}
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
        {d.reverse.allowed && (
          <button type="button" className="btn sm" disabled={busy} data-testid={`reverse-${r.id}`}
            onClick={() => { setDialog({ kind: "reverse", row: r }); setReason(""); }}>
            {ar ? "عكس التحصيل" : "Reverse collection"}
          </button>
        )}
      </div>
    );
  };

  const table = (
    <div style={{ overflowX: "auto" }}>
      <table className="t coll" data-testid="collections-table" style={{ minWidth: 1000 }}>
        <thead>
          <tr>
            <th scope="col">{ar ? "الصفقة" : "Deal"}</th>
            <th scope="col">{ar ? "المبلغ" : "Amount"}</th>
            <th scope="col">{ar ? "الأساس الصافي" : "Net basis"}</th>
            <th scope="col">{ar ? "التاريخ" : "Date"}</th>
            <th scope="col">{ar ? "الطريقة" : "Method"}</th>
            <th scope="col">{ar ? "الحالة" : "Status"}</th>
            <th scope="col">{ar ? "العمولة" : "Commission"}</th>
            <th scope="col"><span className="sr-only">{ar ? "الإجراءات" : "Actions"}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid={`collection-${r.id}`} className={detail?.id === r.id ? "sel" : undefined}>
              <td style={{ whiteSpace: "normal", minWidth: 200 }}>
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
              <td>
                <span className="l1"><bdi className="n">{formatMoney(r.amountGross)}</bdi></span>
                {r.referenceNumber && <span className="sm"><bdi className="id" style={{ fontSize: 12 }}>{r.referenceNumber}</bdi></span>}
              </td>
              <td>
                <span className="l1"><bdi className="n">{formatMoney(r.amountNet)}</bdi></span>
                <span className="sm">{ar ? "ضريبة " : "tax "}<bdi className="n">{formatMoney(Number(r.amountTax).toFixed(2))}</bdi></span>
              </td>
              <td><bdi className="n">{formatDay(r.collectedAt)}</bdi></td>
              <td>{methodText(r.paymentMethod)}</td>
              <td style={{ whiteSpace: "normal" }}>
                <StatusDot status={r.status} ar={ar} />
                {(r.decisionReason || r.reversalReason) && (
                  <span className="sm">{r.reversalReason ?? r.decisionReason}</span>
                )}
              </td>
              <td>{commissionCell(r)}</td>
              <td style={{ textAlign: "end" }}>{rowActions(r)}</td>
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
          : (ar ? "عكس تحصيل معتمَد" : "Reverse an approved collection")
      }
      onClose={() => setDialog(null)}
      testId="collection-decision-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={() => setDialog(null)}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            variant="danger"
            disabled={busy || reason.trim().length < 3}
            testId="confirm-decision"
            onClick={() => decide(dialog.row, dialog.kind, reason)}
          >
            {dialog.kind === "reject" ? (ar ? "رفض" : "Reject") : (ar ? "عكس" : "Reverse")}
          </Button>
        </>
      }
    >
      <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>
        <bdi>{dealText(dialog.row)}</bdi> · <bdi className="n">{moneyText(dialog.row.amountGross, dialog.row.currency, lang)}</bdi>
      </p>
      <p className="notice">
        {dialog.kind === "reject"
          ? (ar
              ? "لن تُنشأ أي عمولة. السبب يظهر للمندوب الذي سجّل التحصيل."
              : "No commission will be created. The reason is shown to the rep who recorded it.")
          : (ar
              ? "القيد الأصلي يبقى كما هو، وتُكتب تسوية سالبة مرتبطة به تُنقص العمولة بالمقدار نفسه."
              : "The original stays as approved; a linked negative adjustment reduces the commission by the same amount.")}
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
              <StatusDot status={detail.status} ar={ar} />
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
              <dt>{ar ? "الأساس الصافي للعمولة" : "Net basis for commission"}</dt>
              <dd className="net"><bdi className="n">{formatMoney(detail.amountNet)}</bdi></dd>
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

  if (phone) {
    return (
      <div className="pg">
        {notices}
        {segments}
        {rows.length === 0 ? empty : (
          <div data-testid="collections-table">
            {rows.map((r) => (
              <div key={r.id} className="c-mrow" data-testid={`collection-${r.id}`}>
                <b><bdi>{customerOf(r) ?? dealText(r)}</bdi></b>
                <span className="n" style={{ fontSize: 14.5 }}>{formatMoney(r.amountGross)}</span>
                <span className="r2">
                  {r.quote && <bdi className="id" style={{ fontSize: 12 }}>{r.quote.quoteNumber}</bdi>}
                  {r.quote && " · "}
                  <bdi className="n">{formatDay(r.collectedAt).slice(0, 5)}</bdi>
                </span>
                <StatusDot status={r.status} ar={ar} />
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
          <h1>{ar ? "التحصيلات" : "Collections"}</h1>
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

      <div className="c-tool">
        {segments}
        <span className="sp" />
        <span className="sort-note">{ar ? "الأحدث أولًا · حتى 200 تحصيل" : "Newest first · up to 200"}</span>
      </div>

      {rows.length === 0 ? empty : table}
      {rules}
      {decisionDialog}
      {drawer}
    </div>
  );
}
