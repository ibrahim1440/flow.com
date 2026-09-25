"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Wallet, Paperclip, Check, X, RotateCcw, Clock } from "lucide-react";
import {
  useLang, ProvisionalBanner, PageHeader, Alert, Card, EmptyState, Spinner, SectionTitle,
  StatStrip, Stat, DataTable, Tr, Td, Toolbar, FilterSelect, Modal, Field, TextArea,
  Button, Money, Num, ROW_ACTION, api, formatDay, num, moneyText,
} from "../_components/ui";

/**
 * Collections — one screen, two jobs.
 *
 * A salesperson opens it to see what they recorded and where it got to. Finance opens it to
 * work the verification queue. It is deliberately not two routes: the records are the same
 * records, and a second URL for them is a second place for the scoping rule to be wrong.
 * Which job the screen is doing is decided by the privileges the server reports, not by a
 * query parameter the browser could change.
 *
 * Nothing here is a bank feed. A collection is a claim that money arrived; Finance either
 * agrees or does not, and only agreement creates commission. The screen says so.
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
  collectionEvent: { accruals: Accrual[] } | null;
};

type EligibleDeal = {
  id: string;
  title: string;
  quoteNumber: string;
  currency: string;
  remaining: string;
};

type Payload = {
  rows: Collection[];
  /** Deals the caller could record against right now. Empty unless they may submit. */
  eligibleDeals?: EligibleDeal[];
  scope: "all" | "own";
  can: { submit: boolean; verify: boolean; reject: boolean; reverse: boolean };
};

const STATUS: Record<string, { en: string; ar: string; tone: string; Icon: React.ElementType }> = {
  PENDING_VERIFICATION: {
    en: "Awaiting verification", ar: "بانتظار التحقق",
    tone: "border-oo-status-waiting bg-oo-status-waiting-bg text-oo-status-hold", Icon: Clock,
  },
  APPROVED: {
    en: "Approved", ar: "معتمَد",
    tone: "border-oo-status-success bg-oo-status-success-bg text-oo-status-success", Icon: Check,
  },
  REJECTED: {
    en: "Rejected", ar: "مرفوض",
    tone: "border-oo-status-rejected bg-oo-status-rejected-bg text-oo-status-rejected", Icon: X,
  },
  REVERSED: {
    en: "Reversed", ar: "معكوس",
    tone: "border-oo-border-strong bg-oo-bg-subtle text-oo-text-secondary", Icon: RotateCcw,
  },
};

const METHODS: Record<string, { en: string; ar: string }> = {
  BANK_TRANSFER: { en: "Bank transfer", ar: "تحويل بنكي" },
  CASH: { en: "Cash", ar: "نقداً" },
  CHEQUE: { en: "Cheque", ar: "شيك" },
  POS_CARD: { en: "Card", ar: "شبكة" },
  OTHER: { en: "Other", ar: "أخرى" },
};

function StatusBadge({ status, ar }: { status: string; ar: boolean }) {
  const s = STATUS[status] ?? STATUS.PENDING_VERIFICATION;
  return (
    <span
      className={`inline-flex h-7 items-center gap-2 rounded-md border px-2.5 py-1 text-[12px] font-medium leading-[18px] ${s.tone}`}
      data-testid={`collection-status-${status}`}
    >
      {ar ? s.ar : s.en} <s.Icon size={16} aria-hidden />
    </span>
  );
}

export default function CollectionsPage() {
  const lang = useLang();
  const ar = lang === "ar";

  const [data, setData] = useState<Payload | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dialog, setDialog] = useState<{ kind: "reject" | "reverse"; row: Collection } | null>(null);
  const [reason, setReason] = useState("");

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

  if (loading) return <Spinner />;
  if (!data) return <Alert kind="error">{error}</Alert>;

  const rows = data.rows;
  const eligible = data.eligibleDeals ?? [];
  const pending = rows.filter((r) => r.status === "PENDING_VERIFICATION");
  const approved = rows.filter((r) => r.status === "APPROVED");
  const sum = (list: Collection[], key: "amountGross" | "amountNet") =>
    list.reduce((a, r) => a + Number(r[key]), 0).toFixed(2);

  // Finance is anyone who can act on the queue. The screen calls itself what it is for the
  // person looking at it rather than showing everyone the same title.
  const isFinance = data.can.verify || data.can.reject || data.can.reverse;

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "التحصيلات" : "Collections"}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {isFinance
                ? (ar ? "قائمة التحقق المالي" : "the finance verification queue")
                : (ar ? "تحصيلاتك وحالتها" : "your collections and where they got to")}
            </span>
            <span aria-hidden className="text-oo-border-strong">·</span>
            <span>
              {ar
                ? "تحقّق مالي يدوي — ليست تسوية بنكية ولا ربطاً محاسبياً"
                : "manual finance verification — not a bank settlement and not an accounting integration"}
            </span>
            <span aria-hidden className="text-oo-border-strong">·</span>
            <span>{ar ? "الاعتماد وحده يُنشئ العمولة" : "approval alone creates commission"}</span>
          </span>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      <StatStrip cols={3}>
        <Stat
          label={ar ? "بانتظار التحقق" : "Awaiting verification"}
          value={moneyText(sum(pending, "amountGross"), "SAR", lang)}
          note={ar ? `${num(pending.length, lang)} تحصيل — لم يُنشئ عمولة` : `${pending.length} — no commission yet`}
          testId="stat-pending"
        />
        <Stat
          label={ar ? "معتمَد" : "Approved"}
          value={moneyText(sum(approved, "amountGross"), "SAR", lang)}
          note={ar ? `الأساس الصافي ${moneyText(sum(approved, "amountNet"), "SAR", lang)}` : `net basis ${moneyText(sum(approved, "amountNet"), "SAR", lang)}`}
          tone="action"
          testId="stat-approved"
        />
        <Stat
          label={ar ? "الإجمالي المعروض" : "Shown here"}
          value={num(rows.length, lang)}
          note={data.scope === "all" ? (ar ? "كل التحصيلات" : "all collections") : (ar ? "تحصيلاتك أنت" : "your own only")}
          testId="stat-count"
        />
      </StatStrip>

      <Toolbar>
        <FilterSelect value={status} onChange={setStatus} label={ar ? "الحالة" : "Status"}>
          <option value="">{ar ? "كل الحالات" : "All statuses"}</option>
          {Object.keys(STATUS).map((s) => (
            <option key={s} value={s}>{ar ? STATUS[s].ar : STATUS[s].en}</option>
          ))}
        </FilterSelect>
      </Toolbar>

      {rows.length === 0 ? (
        <Card>
          <EmptyState>
            <Wallet size={28} className="mx-auto mb-2 opacity-40" aria-hidden />
            {ar
              ? "لا توجد تحصيلات. يُسجَّل التحصيل من صفحة الصفقة بعد قبول عرض السعر."
              : "No collections. One is recorded from a deal, once its quotation has been accepted."}
          </EmptyState>

          {/* "Nothing here" is true but useless on its own when the reason is that the
              person is looking in the wrong place. If they hold the privilege and own a
              deal with money still outstanding, the empty state says so and takes them
              there. If they hold it and own nothing eligible, it says that instead. */}
          {data.can.submit && eligible.length > 0 && (
            <div className="mx-auto mt-1 max-w-[560px]" data-testid="eligible-deals">
              <p className="mb-2 text-center text-[12px] leading-[18px] text-oo-text-secondary">
                {ar
                  ? "صفقات يمكنك التسجيل عليها الآن:"
                  : "Deals you can record against right now:"}
              </p>
              <ul className="space-y-1.5">
                {eligible.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/dashboard/sales/deals/${d.id}#collections`}
                      data-testid={`eligible-deal-${d.id}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-oo-border-default bg-oo-bg-subtle px-3.5 py-2.5 transition-colors hover:border-oo-action-primary"
                    >
                      <span className="text-[13px] font-medium leading-[20px] text-oo-action-primary">
                        {d.title}
                      </span>
                      <span className="text-[12px] leading-[18px] text-oo-text-muted">
                        <Num>{d.quoteNumber}</Num>
                        {" · "}
                        {ar ? "المتبقي " : "outstanding "}
                        <Money value={d.remaining} currency={d.currency} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.can.submit && eligible.length === 0 && (
            <p
              data-testid="no-eligible-deals"
              className="mt-1 text-center text-[12px] leading-[18px] text-oo-text-muted"
            >
              {ar
                ? "لا توجد لديك صفقة بعرض سعر مقبول وعليها متبقٍّ. سجّل قبول العميل على عرض سعر أولاً."
                : "You have no deal with an accepted quotation and an outstanding balance. Record a customer's acceptance first."}
            </p>
          )}
          {!data.can.submit && (
            <p
              data-testid="cannot-submit"
              className="mt-1 text-center text-[12px] leading-[18px] text-oo-text-muted"
            >
              {ar
                ? "لا تملك صلاحية تسجيل التحصيل؛ هذه الشاشة للعرض فقط بالنسبة لك."
                : "You do not have the collection-submit permission; this screen is read-only for you."}
            </p>
          )}
        </Card>
      ) : (
        <DataTable
          testId="collections-table"
          minWidth={1240}
          cols={[
            { label: ar ? "الصفقة" : "Deal", w: "min-w-[200px]" },
            { label: ar ? "المبلغ" : "Amount", w: "w-[170px]" },
            { label: ar ? "الأساس الصافي" : "Net basis", w: "w-[150px]" },
            { label: ar ? "التاريخ" : "Date", w: "w-[120px]" },
            { label: ar ? "الطريقة" : "Method", w: "w-[120px]" },
            { label: ar ? "الحالة" : "Status", w: "w-[170px]" },
            { label: ar ? "العمولة" : "Commission", w: "w-[150px]" },
            { label: <span className="sr-only">{ar ? "الإجراءات" : "Actions"}</span>, w: "w-[230px]" },
          ]}
        >
          {rows.map((r) => {
            const accruals = r.collectionEvent?.accruals ?? [];
            return (
              <Tr key={r.id} testId={`collection-${r.id}`}>
                <Td>
                  {r.opportunity ? (
                    <Link
                      href={`/dashboard/sales/deals/${r.opportunity.id}`}
                      className="font-medium text-oo-action-primary hover:underline"
                    >
                      {r.opportunity.title}
                    </Link>
                  ) : "—"}
                  <span className="block text-[12px] leading-[18px] text-oo-text-muted">
                    {[
                      r.customer ? (ar ? (r.customer.nameAr ?? r.customer.name) : r.customer.name) : null,
                      r.quote ? r.quote.quoteNumber : null,
                      r.submittedBy?.name,
                    ].filter(Boolean).join(" · ")}
                  </span>
                </Td>
                <Td>
                  <Money value={r.amountGross} currency={r.currency} />
                  {r.referenceNumber && (
                    <span className="block text-[12px] leading-[18px] text-oo-text-muted">
                      <Num>{r.referenceNumber}</Num>
                    </span>
                  )}
                </Td>
                <Td>
                  <Money value={r.amountNet} currency={r.currency} />
                  <span className="block text-[12px] leading-[18px] text-oo-text-muted">
                    {ar ? "ضريبة " : "tax "}
                    <Num>{Number(r.amountTax).toFixed(2)}</Num>
                  </span>
                </Td>
                <Td><Num>{formatDay(r.collectedAt)}</Num></Td>
                <Td>{ar ? (METHODS[r.paymentMethod]?.ar ?? r.paymentMethod) : (METHODS[r.paymentMethod]?.en ?? r.paymentMethod)}</Td>
                <Td>
                  <StatusBadge status={r.status} ar={ar} />
                  {(r.decisionReason || r.reversalReason) && (
                    <span className="mt-1 block text-[12px] leading-[18px] text-oo-text-muted">
                      {r.reversalReason ?? r.decisionReason}
                    </span>
                  )}
                </Td>
                <Td>
                  {/* Pending is shown as an estimate and is NEVER added to anything. */}
                  {r.status === "PENDING_VERIFICATION" ? (
                    <span className="text-[12px] leading-[18px] text-oo-text-muted" data-testid={`commission-pending-${r.id}`}>
                      {ar ? "بانتظار الاعتماد" : "pending approval"}
                    </span>
                  ) : accruals.length === 0 ? (
                    <span className="text-oo-text-muted">—</span>
                  ) : (
                    accruals.map((a, i) => (
                      <span key={i} className="block text-[12px] leading-[18px]">
                        <Money value={a.amount} currency={r.currency} />
                        <span className="text-oo-text-muted"> · {a.employee.name}</span>
                      </span>
                    ))
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r._count.evidence > 0 && (
                      <Link
                        href={`/api/sales/collections/${r.id}/evidence`}
                        className={`${ROW_ACTION} gap-1.5 text-oo-text-secondary hover:border-oo-action-primary`}
                        data-testid={`evidence-${r.id}`}
                      >
                        <Paperclip size={13} aria-hidden /> <Num>{r._count.evidence}</Num>
                      </Link>
                    )}
                    {r.status === "PENDING_VERIFICATION" && data.can.verify && (
                      <button
                        disabled={busy}
                        onClick={() => decide(r, "approve", "")}
                        data-testid={`approve-${r.id}`}
                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-oo-action-primary px-3 py-[7px] text-[12px] leading-[18px] text-white transition-colors hover:bg-oo-action-primary-hover disabled:opacity-50"
                      >
                        <Check size={14} aria-hidden /> {ar ? "اعتماد" : "Approve"}
                      </button>
                    )}
                    {r.status === "PENDING_VERIFICATION" && data.can.reject && (
                      <button
                        disabled={busy}
                        onClick={() => { setDialog({ kind: "reject", row: r }); setReason(""); }}
                        data-testid={`reject-${r.id}`}
                        className={`${ROW_ACTION} text-oo-status-rejected hover:bg-oo-status-rejected-bg`}
                      >
                        {ar ? "رفض" : "Reject"}
                      </button>
                    )}
                    {r.status === "APPROVED" && data.can.reverse && (
                      <button
                        disabled={busy}
                        onClick={() => { setDialog({ kind: "reverse", row: r }); setReason(""); }}
                        data-testid={`reverse-${r.id}`}
                        className={`${ROW_ACTION} text-oo-status-rejected hover:bg-oo-status-rejected-bg`}
                      >
                        {ar ? "عكس" : "Reverse"}
                      </button>
                    )}
                  </div>
                </Td>
              </Tr>
            );
          })}
        </DataTable>
      )}

      <Card>
        <SectionTitle>{ar ? "قواعد هذه الشاشة" : "The rules this screen enforces"}</SectionTitle>
        <ul className="space-y-1.5 text-[12px] leading-[18px] text-oo-text-secondary">
          {(ar
            ? [
                "التحصيل المسجَّل «بانتظار التحقق» لا يُنشئ أي عمولة. التقدير المعروض تقدير فقط ولا يدخل في أي مجموع.",
                "الاعتماد المالي وحده يُنشئ استحقاق العمولة، وأساسه صافي المحصَّل بعد الضريبة.",
                "من سجّل التحصيل لا يعتمده، مهما كانت صلاحياته. لا استثناء في هذا الإصدار.",
                "العكس لا يحذف شيئاً: القيد الأصلي يبقى كما اعتُمد، وتُكتب فوقه تسوية سالبة مرتبطة به.",
                "لا يمكن تسجيل تحصيل يتجاوز المتبقي على عرض السعر المقبول، محسوباً مع ما هو بانتظار التحقق.",
              ]
            : [
                "A collection awaiting verification creates no commission. The estimate shown is an estimate and is in no total.",
                "Finance approval alone creates the entitlement, and its basis is the net collected after tax.",
                "Whoever recorded a collection does not approve it, whatever privileges they hold. No exception in this release.",
                "A reversal deletes nothing: the original stays exactly as approved, with a linked negative adjustment on top.",
                "A collection cannot exceed what is outstanding on the accepted quotation, counting what is already awaiting verification.",
              ]
          ).map((rule, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="text-oo-border-strong">•</span>
              <span>{rule}</span>
            </li>
          ))}
        </ul>
      </Card>

      {dialog && (
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
          <p className="mb-3 text-[12px] leading-[18px] text-oo-text-secondary">
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
      )}
    </div>
  );
}
