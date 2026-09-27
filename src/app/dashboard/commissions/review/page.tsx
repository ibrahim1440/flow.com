"use client";

import { useState, useEffect } from "react";
import { CheckCircle2, AlertTriangle, Banknote, Scale } from "lucide-react";
import {
  useLang, ProvisionalBanner, SandboxBanner, PageHeader, Alert, Card, SectionTitle,
  EmptyState, Spinner, Button, Field, TextInput, TextArea, Money, Pill, Modal, api,
  AccrualStatusBadge, DataTable, Tr, Td, StatStrip, Stat, FilterSelect, ROW_ACTION,
  monthOptions, formatDay, num,
} from "../../sales/_components/ui";

/**
 * Commission review and approval.
 *
 * ── Two figures, from two places, on purpose ──
 * The statement comes from the append-only ledger and is the authority on what is owed. The
 * accrual rows are the per-collection explanation. They must agree, so the difference is
 * computed and SHOWN rather than assumed: a reconciliation that is only checked when
 * somebody complains is not a control. A row that does not reconcile is marked, and it is
 * the one thing on this screen worth stopping for.
 *
 * ── Nothing here rewrites an approved figure ──
 * Approving sets a status. A correction appends an adjustment carrying a reason and an
 * actor. A payout appends a payout entry. The approved number stays exactly as approved.
 *
 * PROVISIONAL INTERFACE — see the banner.
 */

type EmployeeRow = {
  employeeId: string;
  name: string;
  accrued: string;
  /** The positive half of `accrued`. What the per-collection rows explain. */
  accrualEntries: string;
  /** Zero, or a negative figure: commission taken back after a refund or a reversal. */
  reversals: string;
  adjustments: string;
  paid: string;
  outstanding: string;
  accrualRowsTotal: string;
  /** The part of the rows above that was frozen at approval and has since been reversed. */
  frozenReversedTotal: string;
  expectedFromRows: string;
  reconciliationDifference: string;
  reconciled: boolean;
  /** The entitlement model's own answer, and whether it agrees with the ledger. */
  entitlementTotal: string;
  entitlementReconciled: boolean;
  /**
   * The six balances. `outstanding` above is earned-less-paid and counts money nobody has
   * approved yet, so it is NOT what may be paid — `balances.availableToPay` is.
   */
  balances: {
    earnedNet: string;
    unapprovedEntitlement: string;
    approvedEntitlement: string;
    adjustments: string;
    completedPayouts: string;
    signedBalance: string;
    availableToPay: string;
    recoveryBalance: string;
    unattributed: string;
    unattributedPositive: string;
    unattributedNegative: string;
    unattributedCount: number;
    nonDerivedCount: number;
    unallocatedReversal: string;
    fullyAttributed: boolean;
    /** Why nothing may be paid, if anything. Same codes the API returns. */
    payoutBlock: "ENTITLEMENT_UNRESOLVED" | "RECOVERY_OUTSTANDING" | "NOTHING_PAYABLE" | null;
  };
  pendingCount: number;
  approvedCount: number;
};

type Accrual = {
  id: string;
  employeeId: string;
  qualifyingBase: string;
  sharePercent: string;
  effectiveRatePercent: string;
  amount: string;
  currency: string;
  status: string;
  approvedAt: string | null;
  createdAt: string;
  employee: { id: string; name: string };
  collectionEvent: {
    id: string; externalRef: string; sourceSystem: string; collectedAt: string; status: string;
    amountGross: string; amountTax: string; amountNonQualifying: string;
    customer: { id: string; name: string } | null;
  };
  planVersion: {
    id: string; version: number; baseRatePercent: string; tierMode: string;
    plan: { code: string; name: string; nameAr: string | null };
  };
};

type Review = {
  periodStart: string;
  periodEnd: string;
  employees: EmployeeRow[];
  accruals: Accrual[];
  totals: { accrued: string; adjustments: string; paid: string; outstanding: string };
  can: { approve: boolean; recordPayout: boolean; managePlans: boolean };
  sandbox: boolean;
  notice: string | null;
};



function thisMonth(): string {
  const riyadh = new Date(Date.now() + 3 * 3600_000);
  return `${riyadh.getUTCFullYear()}-${String(riyadh.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function CommissionReviewPage() {
  const lang = useLang();
  const ar = lang === "ar";

  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<Review | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dialog, setDialog] = useState<{ kind: "adjust" | "payout"; row: EmployeeRow } | null>(null);

  /**
   * Reload counter.
   *
   * The fetch lives in the effect rather than in a `useCallback` the effect calls: the
   * lint rule resolves a called callback and sees setState reachable from the effect
   * body. Mutations still refresh by bumping this, so the behaviour is unchanged and the
   * fetch has one owner. `cancelled` stops a slow response landing after a newer one.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<Review>(`/api/commissions/review?month=${month}`);
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
  }, [month, ar, reloadToken]);


  async function approve(row: EmployeeRow) {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await api<{ approved: number; message?: string }>("/api/commissions/review/actions", {
      method: "POST",
      body: { action: "approve", employeeId: row.employeeId, month },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.data.error ?? "");
      return;
    }
    setSuccess(
      res.data.approved > 0
        ? ar ? `اعتُمدت ${res.data.approved} استحقاقات لـ ${row.name}.` : `Approved ${res.data.approved} accruals for ${row.name}.`
        : (res.data.message ?? ""),
    );
    reload();
  }

  if (loading) return <Spinner />;
  if (!data) return <Alert kind="error">{error}</Alert>;

  const unreconciled = data.employees.filter((e) => !e.reconciled);

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "مراجعة العمولات" : "Commission review"}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {ar
                ? "الاعتماد يشمل كل ما هو «مستحق» للموظّف في الفترة"
                : "Approving covers everything accrued for that employee in the period"}
            </span>
            <span aria-hidden className="text-oo-border-strong">·</span>
            <span>{ar ? "الصرف يشمل «معتمَد» فقط" : "a payout covers approved rows only"}</span>
          </span>
        }
        actions={
          <FilterSelect
            value={month}
            onChange={setMonth}
            label={ar ? "الشهر" : "Month"}
            width="w-[180px]"
            testId="cr-month"
          >
            {monthOptions(month, lang).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </FilterSelect>
        }
      />

      <SandboxBanner notice={data.notice} />
      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      {unreconciled.length > 0 && (
        <Alert kind="error">
          <span className="inline-flex items-center gap-1.5">
            <AlertTriangle size={15} aria-hidden />
            {ar
              ? `${unreconciled.length} سجل لا يتطابق فيه دفتر القيود مع صفوف الاستحقاق. لا تعتمد قبل فهم السبب.`
              : `${unreconciled.length} rows where the ledger and the accrual rows disagree. Do not approve before understanding why.`}
          </span>
        </Alert>
      )}

      {/* The period's totals. Not in the design's frame, which goes straight to the table —
          kept because a reviewer approving a period needs to see what the period comes to. */}
      <StatStrip>
        <Stat label={ar ? "المستحق" : "Accrued"} value={data.totals.accrued} money />
        <Stat label={ar ? "التسويات" : "Adjustments"} value={data.totals.adjustments} money />
        <Stat label={ar ? "المدفوع" : "Paid"} value={data.totals.paid} money />
        <Stat
          label={ar ? "المتبقّي (مستحق − مدفوع)" : "Outstanding (earned − paid)"}
          value={data.totals.outstanding}
          money
          tone="action"
        />
      </StatStrip>

      {data.employees.length === 0 ? (
        <Card>
          <EmptyState>{ar ? "لا توجد استحقاقات في هذا الشهر." : "No accruals in this period."}</EmptyState>
        </Card>
      ) : (
        <DataTable
          testId="review-table"
          minWidth={1180}
          cols={[
            { label: ar ? "الموظّف" : "Employee", w: "min-w-[190px]" },
            { label: ar ? "الخطة" : "Plan", w: "w-[160px]" },
            { label: ar ? "مستحق" : "Accrued", w: "w-[140px]" },
            { label: ar ? "تسويات" : "Adjustments", w: "w-[130px]" },
            { label: ar ? "مدفوع" : "Paid", w: "w-[130px]" },
            { label: ar ? "المتاح للصرف" : "Available to pay", w: "w-[160px]" },
            { label: ar ? "الإجراءات" : "Actions", w: "w-[270px]" },
          ]}
        >
          {data.employees.map((e) => {
            // The plan is not on the employee row; it is on that employee's accruals, which
            // is where the reviewer would look for it anyway.
            const pv = data.accruals.find((a) => a.employeeId === e.employeeId)?.planVersion;
            // Availability, not earnings. `outstanding` includes accruals nobody has
            // approved, so offering a payout against it invites a payment the server will
            // refuse — or worse, one that spends a balance carrying a recovery.
            //
            // `payoutBlock` is the server's own answer and covers the case a positive
            // figure hides: a period whose entitlement cannot be fully derived still shows
            // an availableToPay, and that figure is not trustworthy until it reconciles.
            const canPay =
              data.can.recordPayout &&
              e.balances.payoutBlock === null &&
              Number(e.balances.availableToPay) > 0 &&
              e.pendingCount === 0;
            return (
              <Tr key={e.employeeId} testId={`review-row-${e.employeeId}`}>
                <Td>
                  <button
                    onClick={() => setExpanded(expanded === e.employeeId ? null : e.employeeId)}
                    className="text-start font-medium hover:text-oo-action-primary"
                    aria-expanded={expanded === e.employeeId}
                    data-testid={`expand-${e.employeeId}`}
                  >
                    {e.name}
                  </button>
                  <span className="block text-[12px] leading-[18px] text-oo-text-muted">
                    {[
                      e.pendingCount > 0
                        ? `${num(e.pendingCount, lang)} ${ar ? "بانتظار الاعتماد" : "awaiting approval"}`
                        : null,
                      e.approvedCount > 0
                        ? `${num(e.approvedCount, lang)} ${ar ? "معتمدة" : "approved"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || (ar ? "لا حركات" : "no accruals")}
                  </span>
                </Td>
                <Td className="text-oo-text-secondary">
                  {pv
                    ? `${ar && pv.plan.nameAr ? pv.plan.nameAr : pv.plan.name} · ${
                        ar ? `ن${num(pv.version, "ar")}` : `v${pv.version}`
                      }`
                    : "—"}
                </Td>
                <Td>
                  <Money value={e.accrued} />
                  {/* A reversal is shown here rather than buried inside the net figure.
                      "50.00, of which 200.00 was taken back" is a different conversation
                      from "50.00", and the reviewer is the person who needs to have it. */}
                  {Number(e.reversals) !== 0 && (
                    <span
                      data-testid={`reversals-${e.employeeId}`}
                      className="block text-[12px] leading-[18px] text-oo-status-rejected"
                    >
                      {ar ? "بعد عكس " : "after reversals of "}
                      <Money value={e.reversals} />
                    </span>
                  )}
                </Td>
                <Td><Money value={e.adjustments} /></Td>
                <Td><Money value={e.paid} /></Td>
                <Td>
                  <Money value={e.balances.availableToPay} strong />
                  {/* Earned is not payable. Both are shown, because a reviewer asked to
                      authorise a payment needs the number they may actually pay, and a
                      reviewer reading a statement needs the number that was earned. */}
                  {e.balances.availableToPay !== e.outstanding && (
                    <span
                      data-testid={`earned-${e.employeeId}`}
                      className="block text-[12px] leading-[18px] text-oo-text-muted"
                    >
                      {ar ? "المستحق " : "earned "}
                      <Money value={e.outstanding} />
                      {Number(e.balances.unapprovedEntitlement) !== 0 && (
                        <>
                          {" · "}
                          {ar ? "غير معتمد " : "unapproved "}
                          <Money value={e.balances.unapprovedEntitlement} />
                        </>
                      )}
                    </span>
                  )}
                  {/* A debt is never shown as a zero. */}
                  {Number(e.balances.recoveryBalance) > 0 && (
                    <span
                      data-testid={`recovery-${e.employeeId}`}
                      // The same sentence the dialog would show, from the same function, so
                      // the chip and the refusal cannot drift apart.
                      title={blockReason("RECOVERY_OUTSTANDING", e.balances, ar) ?? undefined}
                      className="mt-1 inline-flex items-center gap-1 rounded-[10px] border border-oo-status-rejected bg-oo-status-rejected-bg px-2 py-[3px] text-[12px] leading-[18px] text-oo-status-rejected"
                    >
                      {ar ? "مستردّ مستحق " : "recovery owed "}
                      <Money value={e.balances.recoveryBalance} />
                    </span>
                  )}
                  {/* An absent button explains nothing. When entitlement cannot be
                      derived the figure above is not trustworthy, and the reviewer is
                      told that rather than left to wonder where the action went. */}
                  {e.balances.payoutBlock === "ENTITLEMENT_UNRESOLVED" && (
                    <span
                      data-testid={`unresolved-${e.employeeId}`}
                      title={blockReason(e.balances.payoutBlock, e.balances, ar) ?? undefined}
                      className="mt-1 inline-flex items-center gap-1 rounded-[10px] border border-oo-status-blocked bg-oo-status-blocked-bg px-2 py-[3px] text-[12px] leading-[18px] text-oo-status-blocked"
                    >
                      <AlertTriangle size={12} aria-hidden />
                      {ar ? "استحقاق غير مُسوّى — غير قابل للصرف" : "entitlement unresolved — not payable"}
                    </span>
                  )}
                  {/* Only the exception is worth a chip. A green "matches" on every row is
                      noise the reviewer learns to stop reading. */}
                  {!e.reconciled && (
                    <span
                      data-testid={`reconciled-${e.employeeId}`}
                      className="mt-1 inline-flex items-center gap-1 rounded-[10px] border border-oo-status-blocked bg-oo-status-blocked-bg px-2 py-[3px] text-[12px] leading-[18px] text-oo-status-blocked"
                    >
                      <Scale size={12} aria-hidden /> {ar ? "فرق " : "off by "}
                      {e.reconciliationDifference}
                    </span>
                  )}
                </Td>
                <Td>
                  {/* The design puts the one action a reviewer should take first and shows
                      the others in place, disabled — so the sequence approve → pay is
                      visible without reading the rules card. */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {data.can.approve && e.pendingCount > 0 ? (
                      <button
                        disabled={busy}
                        onClick={() => approve(e)}
                        data-testid={`approve-${e.employeeId}`}
                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-oo-action-primary px-3 py-[7px] text-[12px] leading-[18px] text-white transition-colors hover:bg-oo-action-primary-hover disabled:opacity-50"
                      >
                        <CheckCircle2 size={14} aria-hidden /> {ar ? "اعتماد المستحق" : "Approve accrued"}
                      </button>
                    ) : canPay ? (
                      <button
                        disabled={busy}
                        onClick={() => setDialog({ kind: "payout", row: e })}
                        data-testid={`payout-${e.employeeId}`}
                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-oo-action-primary px-3 py-[7px] text-[12px] leading-[18px] text-white transition-colors hover:bg-oo-action-primary-hover disabled:opacity-50"
                      >
                        <Banknote size={14} aria-hidden /> {ar ? "صرف المعتمد" : "Pay approved"}
                      </button>
                    ) : null}
                    {data.can.approve && (
                      <button
                        disabled={busy}
                        onClick={() => setDialog({ kind: "adjust", row: e })}
                        data-testid={`adjust-${e.employeeId}`}
                        className={`${ROW_ACTION} text-oo-text-primary hover:border-oo-action-primary disabled:opacity-50`}
                      >
                        {ar ? "تسوية" : "Adjust"}
                      </button>
                    )}
                    {e.pendingCount > 0 && (
                      <span
                        className={`${ROW_ACTION} cursor-not-allowed text-oo-text-muted`}
                        title={ar ? "الصرف بعد الاعتماد" : "Payout comes after approval"}
                      >
                        {ar ? "صرف" : "Payout"}
                      </span>
                    )}
                  </div>
                </Td>
              </Tr>
            );
          })}
        </DataTable>
      )}

      {/* ── The rules this screen enforces ──────────────────────────────────────── */}
      <Card>
        <SectionTitle>{ar ? "قواعد هذه الشاشة" : "The rules this screen enforces"}</SectionTitle>
        <ul className="space-y-1.5 text-[12px] leading-[18px] text-oo-text-secondary">
          {(ar
            ? [
                "«اعتماد المستحق» يعتمد كل حركة حالتها «مستحق» في هذه الفترة لهذا الموظّف — لا اعتماد جزئي لحركة واحدة.",
                "«صرف المعتمد» متاح بعد الاعتماد فقط، ويكتب قيد صرف لدفعة تمّت خارج النظام — لا يحرّك مالاً ولا يطلب تحويلاً.",
                "«تسوية» تكتب قيد تسوية موجباً أو سالباً بسبب إلزامي — ولا تعدّل حركة استحقاق قائمة.",
                "«المتاح للصرف» = المعتمد + التسويات − المصروف. «المتبقّي» يشمل غير المعتمد، فهو ليس ما يمكن صرفه.",
                "الحركات تصبح «مدفوع» عند سداد استحقاق الفترة المعتمد بالكامل فقط؛ الصرف الجزئي يبقيها «معتمد».",
                "إذا تعذّر اشتقاق استحقاق الفترة، لا يُصرف شيء فيها حتى تُسوّى — والسجلّ يبقى كما هو.",
              ]
            : [
                "“Approve accrued” approves every ACCRUED row for this employee in this period — there is no partial approval of one row.",
                "“Pay approved” is available only after approval and records a payment already completed outside this system — it moves no money and requests no transfer.",
                "“Adjust” writes a positive or negative adjustment entry with a mandatory reason — it never edits an existing accrual.",
                "Available to pay = approved + adjustments − paid. Outstanding includes unapproved earnings, so it is not what may be paid.",
                "Rows become PAID only when the period's approved entitlement is settled in full; a partial payout leaves them APPROVED.",
                "If a period's entitlement cannot be derived, nothing in it is payable until it is reconciled — and the records are left exactly as they are.",
              ]
          ).map((rule, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="text-oo-border-strong">•</span>
              <span>{rule}</span>
            </li>
          ))}
        </ul>
      </Card>


      {expanded && (
        <Card>
          <SectionTitle>
            {ar ? "الاستحقاقات التفصيلية" : "The accruals behind the figure"} —{" "}
            {data.employees.find((e) => e.employeeId === expanded)?.name}
          </SectionTitle>
          <div className="-mx-5 mt-3 overflow-x-auto border-y border-oo-border-default">
            <table className="w-full min-w-[900px] border-collapse text-start" data-testid="accrual-detail">
              <thead>
                <tr className="bg-oo-bg-subtle">
                  {[
                    [ar ? "التحصيل" : "Collection", "min-w-[190px]"],
                    [ar ? "العميل" : "Customer", "w-[160px]"],
                    [ar ? "الأساس المؤهّل" : "Qualifying base", "w-[150px]"],
                    [ar ? "الحصة" : "Share", "w-[90px]"],
                    [ar ? "النسبة المشتقّة" : "Derived rate", "w-[130px]"],
                    [ar ? "المبلغ" : "Amount", "w-[140px]"],
                    [ar ? "الخطة" : "Plan", "w-[140px]"],
                    [ar ? "الحالة" : "Status", "w-[150px]"],
                  ].map(([l, w], i) => (
                    <th
                      key={i}
                      scope="col"
                      className={`${w} px-4 py-[11px] text-start text-[12px] font-medium leading-[18px] text-oo-text-muted`}
                    >
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.accruals
                  .filter((a) => a.employeeId === expanded)
                  .map((a) => (
                    <tr key={a.id} className="border-t border-oo-border-default" data-testid={`accrual-${a.id}`}>
                      <Td>
                        <span className="block font-mono text-[12px] leading-[18px]">
                          {a.collectionEvent.externalRef}
                        </span>
                        <span className="text-[12px] leading-[18px] text-oo-text-muted">
                          {formatDay(a.collectionEvent.collectedAt, lang)}
                        </span>
                        {a.collectionEvent.sourceSystem === "SANDBOX" && (
                          <Pill tone="neutral">{ar ? "تجريبي" : "sandbox"}</Pill>
                        )}
                      </Td>
                      <Td>{a.collectionEvent.customer?.name ?? "—"}</Td>
                      <Td><Money value={a.qualifyingBase} /></Td>
                      <Td>{ar ? `${num(Number(a.sharePercent), "ar")}%` : `${a.sharePercent}%`}</Td>
                      <Td>{ar ? `${num(Number(a.effectiveRatePercent), "ar")}%` : `${a.effectiveRatePercent}%`}</Td>
                      <Td><Money value={a.amount} currency={a.currency} /></Td>
                      <Td>
                        <span className="font-mono text-[12px] leading-[18px]">{a.planVersion.plan.code}</span>
                        {" "}
                        {ar ? `ن${num(a.planVersion.version, "ar")}` : `v${a.planVersion.version}`}
                      </Td>
                      <Td>
                        <AccrualStatusBadge status={a.status} />
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12px] leading-[18px] text-oo-text-muted">
            {ar
              ? "كل صف يحمل مساهمة حدث التحصيل الخاص به — لا المجموع الجاري — فمجموع الصفوف يساوي مستحق الفترة. والنسبة المشتقّة هي المبلغ ÷ الأساس، تُحسب بعد تقريب المبلغ إلى 0.01 ر.س — تشرح الشريحة وتشرح التقريب، لكنها ليست النسبة التعاقدية للخطة. النسبة التعاقدية تُقرأ من إصدار الخطة بجانب الصف."
              : "Each row carries its own collection event's contribution, not the running total, so the rows sum to the period's accrued figure. The DERIVED rate is amount ÷ base, computed after the amount is rounded to 0.01 SAR — it explains a tier, and it explains the rounding, but it is not the plan's contractual rate. Read the contractual rate from the plan version beside the row."}
          </p>
        </Card>
      )}

      {dialog && (
        <ActionDialog
          ar={ar}
          kind={dialog.kind}
          row={dialog.row}
          month={month}
          onClose={() => setDialog(null)}
          onDone={(m) => {
            setDialog(null);
            setSuccess(m);
            reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * A fresh idempotency key for one intended payment.
 *
 * `crypto.randomUUID` needs a secure context and is missing in a few older mobile
 * browsers, so there is a fallback — a payout must not become unrecordable because the
 * browser lacks a UUID generator. The fallback is only ever compared for equality against
 * itself, never used as a secret, so `Math.random` is adequate here.
 */
function newPayoutKey(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return `payout-${c.randomUUID()}`;
  return `payout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * A short, stable discriminator for a payout's payload.
 *
 * Not a security primitive and not a checksum the server trusts — the server compares the
 * stored amount and reason itself. This only has to change when the payload changes and
 * stay identical when it does not, so that a retry of the same payment reproduces the same
 * key. A digest rather than the raw payload because the key is capped at 200 characters
 * and a reason is free text.
 */
function digest(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Why a payout is unavailable, in words, from the server's own code.
 *
 * One function for the row chip and the dialog both, because the two showing different
 * reasons for the same state is exactly the confusion this screen is meant to remove.
 * `NOTHING_PAYABLE` returns null: an empty balance is the ordinary case and needs no
 * explanation beyond the figure already on the row.
 */
function blockReason(
  code: EmployeeRow["balances"]["payoutBlock"],
  b: EmployeeRow["balances"],
  ar: boolean,
): string | null {
  if (code === "RECOVERY_OUTSTANDING") {
    return ar
      ? `صُرف ${b.recoveryBalance} أكثر من الاستحقاق الحالي ويجب استرداده. لا يُصرف شيء قبل تسويته.`
      : `${b.recoveryBalance} has been paid beyond the current entitlement and is owed back. ` +
          "Nothing is payable until the recovery is resolved.";
  }
  if (code === "ENTITLEMENT_UNRESOLVED") {
    const bits = ar
      ? [
          b.unattributedCount > 0
            ? `${b.unattributedCount} حركة لا تعود إلى أي استحقاق (+${b.unattributedPositive} و−${b.unattributedNegative})`
            : null,
          b.nonDerivedCount > 0 ? `${b.nonDerivedCount} استحقاق لا يمكن اشتقاق قيمته` : null,
          Number(b.unallocatedReversal) > 0 ? `${b.unallocatedReversal} من العكس غير موزَّع` : null,
        ]
      : [
          b.unattributedCount > 0
            ? `${b.unattributedCount} movement${b.unattributedCount === 1 ? "" : "s"} belong to no accrual ` +
              `(+${b.unattributedPositive} and −${b.unattributedNegative})`
            : null,
          b.nonDerivedCount > 0
            ? `${b.nonDerivedCount} accrual${b.nonDerivedCount === 1 ? "" : "s"} carry no derivable entitlement`
            : null,
          Number(b.unallocatedReversal) > 0
            ? `${b.unallocatedReversal} of reversal is unallocated`
            : null,
        ];
    const detail = bits.filter(Boolean).join(ar ? "؛ " : "; ");
    return ar
      ? `تعذّر اشتقاق الاستحقاق لهذه الفترة، فلا شيء فيها قابل للصرف: ${detail}. تجب التسوية أولاً.`
      : `This period's entitlement cannot be fully derived, so nothing in it is payable: ${detail}. ` +
          "Reconcile the period first — the records are preserved exactly as they are.";
  }
  return null;
}

function ActionDialog({
  ar, kind, row, month, onClose, onDone,
}: {
  ar: boolean;
  kind: "adjust" | "payout";
  row: EmployeeRow;
  month: string;
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  // The payable figure, not the earned one. This used to open on `row.outstanding`, which
  // counts accruals nobody has approved and ignores a recovery entirely — so the dialog
  // pre-filled an amount the server was about to refuse, and labelled it "Outstanding".
  const [amount, setAmount] = useState(kind === "payout" ? row.balances.availableToPay : "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const isAdjust = kind === "adjust";
  const blocked = isAdjust ? null : blockReason(row.balances.payoutBlock, row.balances, ar);

  /**
   * One key per intended payment.
   *
   * Regenerated when the payload changes, because a different amount or reason is a
   * different payment and must not inherit the previous key. Held steady while the payload
   * is unchanged, so pressing the button again after a timeout retries the SAME payment and
   * the server recognises it rather than paying twice — which is the case a partial payment
   * leaves wide open, since enough balance remains for the duplicate to succeed.
   *
   * Derived, not stored. One nonce is minted when the dialog opens and never changes; the
   * key is that nonce plus a digest of the payload. Retrying the identical payload
   * reproduces the identical key with nothing to keep in sync, and editing the amount
   * changes it in the same render — an effect or a ref would mint the new key one render
   * LATE, so a fast submit would send the previous payment's key with a new amount. The
   * server refuses that, correctly, but the reviewer would be reading a refusal caused by
   * the screen rather than by the books.
   */
  const [payoutNonce] = useState(newPayoutKey);
  const payoutKey = `${payoutNonce}-${digest(`${amount}|${reason}`)}`;

  return (
    <Modal
      title={
        isAdjust
          ? ar ? `تسوية على ${row.name}` : `Adjust ${row.name}`
          : ar ? `تسجيل صرف لـ ${row.name}` : `Record a payout to ${row.name}`
      }
      onClose={onClose}
      testId={`${kind}-dialog`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || !amount || !!blocked || (isAdjust && reason.trim().length < 3)}
            testId={`confirm-${kind}`}
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api("/api/commissions/review/actions", {
                method: "POST",
                body: {
                  action: kind,
                  employeeId: row.employeeId,
                  month,
                  amount,
                  reason,
                  ...(isAdjust ? {} : { idempotencyKey: payoutKey }),
                },
              });
              setBusy(false);
              if (res.ok) {
                onDone(isAdjust ? (ar ? "سُجّلت التسوية." : "Adjustment recorded.") : ar ? "سُجّل الصرف." : "Payout recorded.");
              } else {
                setErr(res.data.error ?? "");
              }
            }}
          >
            {isAdjust ? (ar ? "تسجيل التسوية" : "Record adjustment") : ar ? "تسجيل الصرف" : "Record payout"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}
      {blocked && (
        <div data-testid="payout-blocked">
          <Alert kind="error">{blocked}</Alert>
        </div>
      )}

      <dl className="bg-oo-bg-subtle rounded-xl p-3 text-sm space-y-1">
        {isAdjust ? (
          <div className="flex justify-between gap-3">
            <dt className="text-xs font-bold text-oo-text-secondary">{ar ? "المتبقي" : "Outstanding"}</dt>
            <dd><Money value={row.outstanding} /></dd>
          </div>
        ) : (
          <>
            {/* The payable figure first and in bold: it is the only one this dialog acts on. */}
            <div className="flex justify-between gap-3">
              <dt className="text-xs font-bold text-oo-text-secondary">
                {ar ? "المتاح للصرف" : "Available to pay"}
              </dt>
              <dd data-testid="dialog-available">
                <Money value={row.balances.availableToPay} strong />
              </dd>
            </div>
            {/* Earned, beside it and clearly not the same thing. */}
            <div className="flex justify-between gap-3">
              <dt className="text-xs text-oo-text-muted">{ar ? "المستحق" : "Earned"}</dt>
              <dd className="text-oo-text-muted"><Money value={row.outstanding} /></dd>
            </div>
            {Number(row.balances.unapprovedEntitlement) !== 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-xs text-oo-text-muted">
                  {ar ? "غير معتمد (غير قابل للصرف)" : "Unapproved (not payable)"}
                </dt>
                <dd className="text-oo-text-muted">
                  <Money value={row.balances.unapprovedEntitlement} />
                </dd>
              </div>
            )}
            {/* A debt is shown as a debt, never flattened into a zero. */}
            {Number(row.balances.recoveryBalance) > 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-xs font-bold text-oo-status-rejected">
                  {ar ? "مستردّ مستحق" : "Recovery owed"}
                </dt>
                <dd data-testid="dialog-recovery" className="text-oo-status-rejected">
                  <Money value={row.balances.recoveryBalance} />
                </dd>
              </div>
            )}
          </>
        )}
      </dl>

      <Field
        id="act-amount"
        label={ar ? "المبلغ (SAR)" : "Amount (SAR)"}
        required
        hint={
          isAdjust
            ? ar ? "موجب يزيد المستحق، سالب ينقصه." : "Positive increases what is owed; negative reduces it."
            : ar
              ? "لا يمكن صرف أكثر من المتاح للصرف — وهو المعتمد فقط، بعد خصم ما صُرف."
              : "A payout cannot exceed what is available to pay — approved entitlement only, less what has already been paid."
        }
      >
        <TextInput id="act-amount" value={amount} onChange={setAmount} inputMode="decimal" />
      </Field>

      <Field
        id="act-reason"
        label={ar ? "السبب" : "Reason"}
        required={isAdjust}
        hint={
          isAdjust
            ? ar
              ? "مطلوب. التسوية إضافة إلى الدفتر تحمل من قام بها ولماذا — لا تعديل على رقم معتمد."
              : "Required. An adjustment appends an entry carrying who made it and why — it never edits an approved figure."
            : undefined
        }
      >
        <TextArea id="act-reason" value={reason} onChange={setReason} rows={3} />
      </Field>

      {!isAdjust && (
        <p className="text-[11px] text-oo-text-muted font-medium">
          {ar
            ? "هذا تسجيل بأن الصرف تم. لا يحرّك مالاً — لا يوجد تكامل مدفوعات في هذا النظام."
            : "This records that a payout was made. It does not move money — there is no payment integration in this system."}
        </p>
      )}
    </Modal>
  );
}
