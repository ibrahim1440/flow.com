"use client";

import { useState, useEffect } from "react";
import { CheckCircle2, AlertTriangle, Banknote, Scale } from "lucide-react";
import {
  useLang, ProvisionalBanner, SandboxBanner, PageHeader, Alert, Card, SectionTitle,
  EmptyState, Spinner, Button, Field, TextInput, TextArea, Money, Pill, Modal, TableWrap, api,
  AccrualStatusBadge,
} from "../../sales/_components/ui";
import { formatDate } from "@/lib/utils";

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
  adjustments: string;
  paid: string;
  outstanding: string;
  accrualRowsTotal: string;
  reconciliationDifference: string;
  reconciled: boolean;
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
    <div className="space-y-6">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "مراجعة العمولات" : "Commission review"}
        subtitle={
          <span className="mt-1 block text-xs">
            {formatDate(data.periodStart)} — {formatDate(data.periodEnd)} ({ar ? "شهر الرياض" : "Riyadh month"})
          </span>
        }
        actions={
          <div className="w-40">
            <Field id="cr-month" label={ar ? "الشهر" : "Month"}>
              <TextInput id="cr-month" type="month" value={month} onChange={setMonth} />
            </Field>
          </div>
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

      <div className="grid sm:grid-cols-4 gap-4">
        <Stat label={ar ? "المستحق" : "Accrued"} value={data.totals.accrued} />
        <Stat label={ar ? "التسويات" : "Adjustments"} value={data.totals.adjustments} />
        <Stat label={ar ? "المدفوع" : "Paid"} value={data.totals.paid} />
        <Stat label={ar ? "المتبقي" : "Outstanding"} value={data.totals.outstanding} strong />
      </div>

      {data.employees.length === 0 ? (
        <Card>
          <EmptyState>{ar ? "لا توجد استحقاقات في هذا الشهر." : "No accruals in this period."}</EmptyState>
        </Card>
      ) : (
        <Card>
          <SectionTitle>{ar ? "حسب الموظف" : "By employee"}</SectionTitle>
          <TableWrap>
            <table className="w-full text-sm min-w-[820px]">
              <thead>
                <tr className="text-[11px] uppercase text-brown/60 font-bold">
                  <th className="text-start py-2">{ar ? "الموظف" : "Employee"}</th>
                  <th className="text-end py-2">{ar ? "المستحق" : "Accrued"}</th>
                  <th className="text-end py-2">{ar ? "التسويات" : "Adjust."}</th>
                  <th className="text-end py-2">{ar ? "المدفوع" : "Paid"}</th>
                  <th className="text-end py-2">{ar ? "المتبقي" : "Outstanding"}</th>
                  <th className="text-start py-2">{ar ? "التطابق" : "Reconciled"}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {data.employees.map((e) => (
                  <tr
                    key={e.employeeId}
                    className="border-t border-border align-top"
                    data-testid={`review-row-${e.employeeId}`}
                  >
                    <td className="py-3">
                      <button
                        onClick={() => setExpanded(expanded === e.employeeId ? null : e.employeeId)}
                        className="font-bold hover:text-orange text-start"
                        aria-expanded={expanded === e.employeeId}
                        data-testid={`expand-${e.employeeId}`}
                      >
                        {e.name}
                      </button>
                      <p className="text-[11px] text-brown/60">
                        {e.pendingCount > 0 && (
                          <span className="text-amber-700 font-bold">
                            {e.pendingCount} {ar ? "بانتظار الاعتماد" : "awaiting approval"}
                          </span>
                        )}
                        {e.pendingCount > 0 && e.approvedCount > 0 && " · "}
                        {e.approvedCount > 0 && (
                          <span>
                            {e.approvedCount} {ar ? "معتمدة" : "approved"}
                          </span>
                        )}
                      </p>
                    </td>
                    <td className="py-3 text-end"><Money value={e.accrued} /></td>
                    <td className="py-3 text-end"><Money value={e.adjustments} /></td>
                    <td className="py-3 text-end"><Money value={e.paid} /></td>
                    <td className="py-3 text-end font-extrabold"><Money value={e.outstanding} /></td>
                    <td className="py-3">
                      {e.reconciled ? (
                        <Pill tone="good" testId={`reconciled-${e.employeeId}`}>
                          <span className="inline-flex items-center gap-1">
                            <Scale size={10} aria-hidden /> {ar ? "متطابق" : "matches"}
                          </span>
                        </Pill>
                      ) : (
                        <Pill tone="bad" testId={`reconciled-${e.employeeId}`}>
                          {ar ? "فرق " : "off by "}
                          {e.reconciliationDifference}
                        </Pill>
                      )}
                    </td>
                    <td className="py-3">
                      <div className="flex gap-1.5 justify-end flex-wrap">
                        {data.can.approve && e.pendingCount > 0 && (
                          <Button
                            disabled={busy}
                            onClick={() => approve(e)}
                            testId={`approve-${e.employeeId}`}
                          >
                            <CheckCircle2 size={14} aria-hidden /> {ar ? "اعتماد" : "Approve"}
                          </Button>
                        )}
                        {data.can.approve && (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => setDialog({ kind: "adjust", row: e })}
                            testId={`adjust-${e.employeeId}`}
                          >
                            {ar ? "تسوية" : "Adjust"}
                          </Button>
                        )}
                        {data.can.recordPayout && Number(e.outstanding) > 0 && e.pendingCount === 0 && (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => setDialog({ kind: "payout", row: e })}
                            testId={`payout-${e.employeeId}`}
                          >
                            <Banknote size={14} aria-hidden /> {ar ? "صرف" : "Payout"}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      {expanded && (
        <Card>
          <SectionTitle>
            {ar ? "الاستحقاقات التفصيلية" : "The accruals behind the figure"} —{" "}
            {data.employees.find((e) => e.employeeId === expanded)?.name}
          </SectionTitle>
          <TableWrap>
            <table className="w-full text-sm min-w-[820px]" data-testid="accrual-detail">
              <thead>
                <tr className="text-[11px] uppercase text-brown/60 font-bold">
                  <th className="text-start py-2">{ar ? "التحصيل" : "Collection"}</th>
                  <th className="text-start py-2">{ar ? "العميل" : "Customer"}</th>
                  <th className="text-end py-2">{ar ? "الأساس" : "Base"}</th>
                  <th className="text-end py-2">{ar ? "الحصة" : "Share"}</th>
                  <th className="text-end py-2">{ar ? "النسبة الفعلية" : "Effective rate"}</th>
                  <th className="text-end py-2">{ar ? "المبلغ" : "Amount"}</th>
                  <th className="text-start py-2">{ar ? "الخطة" : "Plan"}</th>
                  <th className="text-start py-2">{ar ? "الحالة" : "Status"}</th>
                </tr>
              </thead>
              <tbody>
                {data.accruals
                  .filter((a) => a.employeeId === expanded)
                  .map((a) => (
                    <tr key={a.id} className="border-t border-border" data-testid={`accrual-${a.id}`}>
                      <td className="py-2.5 text-xs">
                        <span className="font-mono">{a.collectionEvent.externalRef}</span>
                        <br />
                        <span className="text-brown/60">{formatDate(a.collectionEvent.collectedAt)}</span>
                        {a.collectionEvent.sourceSystem === "SANDBOX" && (
                          <Pill tone="neutral">{ar ? "تجريبي" : "sandbox"}</Pill>
                        )}
                      </td>
                      <td className="py-2.5 text-xs">{a.collectionEvent.customer?.name ?? "—"}</td>
                      <td className="py-2.5 text-end"><Money value={a.qualifyingBase} /></td>
                      <td className="py-2.5 text-end tabular-nums">{a.sharePercent}%</td>
                      <td className="py-2.5 text-end tabular-nums">{a.effectiveRatePercent}%</td>
                      <td className="py-2.5 text-end"><Money value={a.amount} currency={a.currency} /></td>
                      <td className="py-2.5 text-xs">
                        <span className="font-mono">{a.planVersion.plan.code}</span> v{a.planVersion.version}
                      </td>
                      <td className="py-2.5">
                        <AccrualStatusBadge status={a.status} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="text-[11px] text-brown/60 mt-3 font-medium">
            {ar
              ? "كل صف يحمل مساهمة حدث التحصيل الخاص به — لا المجموع الجاري — فمجموع الصفوف يساوي مستحق الفترة. والنسبة الفعلية هي ما يشرح سبب اختلاف المبلغ عن الأساس × النسبة الأساسية بعد تجاوز شريحة."
              : "Each row carries its own collection event's contribution, not the running total, so the rows sum to the period's accrued figure. The effective rate is what explains why the amount is not simply base × base rate once a tier has been crossed."}
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

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${strong ? "bg-cream border-orange/30" : "bg-white border-border"}`}>
      <p className="text-[11px] uppercase font-bold text-brown/60 tracking-wide">{label}</p>
      <p className="text-xl mt-1">
        <Money value={value} />
      </p>
    </div>
  );
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
  const [amount, setAmount] = useState(kind === "payout" ? row.outstanding : "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const isAdjust = kind === "adjust";

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
            disabled={busy || !amount || (isAdjust && reason.trim().length < 3)}
            testId={`confirm-${kind}`}
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api("/api/commissions/review/actions", {
                method: "POST",
                body: { action: kind, employeeId: row.employeeId, month, amount, reason },
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

      <dl className="bg-cream/50 rounded-xl p-3 text-sm space-y-1">
        <div className="flex justify-between gap-3">
          <dt className="text-xs font-bold text-brown/70">{ar ? "المتبقي" : "Outstanding"}</dt>
          <dd><Money value={row.outstanding} /></dd>
        </div>
      </dl>

      <Field
        id="act-amount"
        label={ar ? "المبلغ (SAR)" : "Amount (SAR)"}
        required
        hint={
          isAdjust
            ? ar ? "موجب يزيد المستحق، سالب ينقصه." : "Positive increases what is owed; negative reduces it."
            : ar ? "لا يمكن صرف أكثر من المتبقي." : "A payout cannot exceed what is outstanding."
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
        <p className="text-[11px] text-brown/60 font-medium">
          {ar
            ? "هذا تسجيل بأن الصرف تم. لا يحرّك مالاً — لا يوجد تكامل مدفوعات في هذا النظام."
            : "This records that a payout was made. It does not move money — there is no payment integration in this system."}
        </p>
      )}
    </Modal>
  );
}
