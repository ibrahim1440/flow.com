"use client";

import { useState, useEffect } from "react";
import { Percent, Plus, Lock, UserPlus } from "lucide-react";
import {
  useLang, ProvisionalBanner, PageHeader, Alert, Card, SectionTitle, EmptyState, Spinner,
  Button, Field, TextInput, Select, TextArea, Pill, Modal, api,
  Td, ROW_ACTION, num, formatDay, formatMoney, toArabicDigits,
} from "../../sales/_components/ui";

/**
 * Commission plan administration.
 *
 * ── Why there is no "edit this version" button ──
 * A plan version is immutable once anything has accrued against it. Editing a live rule in
 * place would restate commissions people have already been told they earned, and the first
 * anyone would know is a payslip disagreeing with last month's. A change is a NEW version
 * with its own effective date; the old one keeps governing the money earned under it.
 *
 * ── Tiers are percentage POINTS on a slice ──
 * "1% plus 0.5 points on 100k–120k" pays 1,150 on a base of 110,000 — an effective
 * 1.045455% — not 1.5%. The form says so next to the field, because the difference is
 * thousands of riyals on the same numbers and it is invisible in a table of percentages.
 *
 * PROVISIONAL INTERFACE — see the banner.
 */

type Tier = { id?: string; fromAmount: string; toAmount: string | null; ratePercent: string };

/**
 * One version of a plan, laid out the way the design explains a tier: the bands as a table
 * whose last column states the rate that actually applies to that slice, a worked example,
 * and the two constraints this release enforces.
 */
function PlanVersion({
  ar, lang, plan, version: v,
}: {
  ar: boolean;
  lang: "ar" | "en";
  plan: Plan;
  version: Version;
}) {
  const frozen = v._count.accruals > 0;
  const rate = (x: string | number) => {
    const s = Number(x).toFixed(6);
    return ar ? `${toArabicDigits(s)}٪` : `${s}%`;
  };
  const amount = (x: string | number) => {
    const s = formatMoney(String(x), 0);
    return ar ? toArabicDigits(s) : s;
  };
  const base = Number(v.baseRatePercent);

  /**
   * An illustration, computed the way `commissionOnCumulativeBase` computes the real thing:
   * the base rate on everything, then each band's POINTS on the slice of base inside it.
   *
   * It exists because "1% plus 0.5 points on 100k–120k" reads to most people as 1.5% on the
   * whole base, which is a different number by thousands of riyals. The example is taken
   * from the plan's own bands so it can never describe a tier the plan does not have.
   */
  const example = (() => {
    const second = v.tiers[1];
    if (!second) return null;
    const from = Number(second.fromAmount);
    const to = second.toAmount === null ? from * 2 : Number(second.toAmount);
    const at = Math.round((from + (to - from) / 2) / 1000) * 1000;
    if (!(at > from)) return null;
    let total = (at * base) / 100;
    const parts = [`${amount(at)} × ${rate(base)} = ${amount(((at * base) / 100).toFixed(2))}`];
    for (const t of v.tiers) {
      const bFrom = Number(t.fromAmount);
      if (at <= bFrom) continue;
      const bTo = t.toAmount === null ? at : Math.min(at, Number(t.toAmount));
      const slice = bTo - bFrom;
      if (slice <= 0 || Number(t.ratePercent) === 0) continue;
      const add = (slice * Number(t.ratePercent)) / 100;
      total += add;
      parts.push(`${amount(slice)} × ${rate(t.ratePercent)} = ${amount(add.toFixed(2))}`);
    }
    const effective = ((total / at) * 100).toFixed(6);
    return { at, parts, total, effective };
  })();

  return (
    <div className="mt-3 first:mt-0" data-testid={`version-${plan.code}-${v.version}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {frozen ? (
          <span className="inline-flex items-center gap-1.5 rounded-[10px] border border-oo-status-hold bg-oo-status-hold-bg px-2 py-[3px] text-[12px] leading-[18px] text-oo-status-hold">
            <Lock size={12} aria-hidden />
            {ar ? "مجمَّدة — لها استحقاقات" : "frozen — it has accruals"}
          </span>
        ) : (
          <span className="text-[12px] leading-[18px] text-oo-text-muted">
            {num(v._count.assignments, lang)} {ar ? "إسناد" : "assigned"}
          </span>
        )}
        <p className="text-[14px] font-medium leading-[22px] text-oo-text-primary">
          {ar ? (plan.nameAr ?? plan.name) : plan.name}
          {" · "}
          {ar ? `النسخة ${num(v.version, "ar")}` : `version ${v.version}`}
          {" — "}
          {v.effectiveTo ? (ar ? "منتهية" : "ended") : (ar ? "سارية" : "in force")}
        </p>
      </div>
      <p className="mt-1 text-[12px] leading-[18px] text-oo-text-secondary">
        {ar ? "الأساس: صافي المحصّل بعد الضريبة وغير المؤهّل" : "Basis: net collected after tax and non-qualifying"}
        {" · "}
        {ar ? "النسبة الأساس" : "base rate"} {rate(base)}
        {" · "}
        {v.tierMode === "INCREMENTAL"
          ? (ar ? "الشرائح تراكمية" : "tiers are incremental")
          : (ar ? "بلا شرائح" : "no tiers")}
        {" · "}
        {ar ? "سريان من" : "from"} {formatDay(v.effectiveFrom, lang)}
        {" · "}
        {v.effectiveTo ? formatDay(v.effectiveTo, lang) : (ar ? "مفتوح" : "open")}
      </p>

      {v.tiers.length > 0 && (
        <div className="mt-2 overflow-x-auto rounded-2xl border border-oo-border-default">
          <table className="w-full min-w-[560px] border-collapse text-start">
            <thead>
              <tr className="bg-oo-bg-subtle">
                {[ar ? "من" : "From", ar ? "إلى" : "To", ar ? "نقاط تُضاف" : "Points added", ar ? "الأثر" : "Effect"].map(
                  (l) => (
                    <th
                      key={l}
                      scope="col"
                      className="px-4 py-[11px] text-start text-[12px] font-medium leading-[18px] text-oo-text-muted"
                    >
                      {l}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {v.tiers.map((t, i) => (
                <tr key={i} className="border-t border-oo-border-default">
                  <Td>{amount(t.fromAmount)}</Td>
                  <Td>{t.toAmount === null ? (ar ? "ما فوق" : "and above") : amount(t.toAmount)}</Td>
                  <Td>
                    {Number(t.ratePercent) === 0
                      ? "—"
                      : `+ ${ar ? toArabicDigits(Number(t.ratePercent).toFixed(2)) : Number(t.ratePercent).toFixed(2)}`}
                  </Td>
                  {/* The column that stops "1% + 0.5 points" being read as 1.5% on everything. */}
                  <Td>
                    {rate(base + Number(t.ratePercent))}{" "}
                    {i === 0
                      ? (ar ? "على هذا الجزء" : "on this slice")
                      : (ar ? "على هذا الجزء فقط" : "on this slice only")}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {example && (
        <p
          className="mt-2 rounded-[10px] border border-oo-status-ready bg-oo-status-ready-bg px-3 py-[9px] text-[12px] leading-[18px] text-oo-status-ready"
          data-testid={`tier-example-${plan.code}-${v.version}`}
        >
          {ar ? "مثال: أساس" : "Example: a base of"} {amount(example.at)} → {example.parts.join(" · ")} ·{" "}
          {ar ? "المجموع" : "total"} {amount(example.total.toFixed(2))} {ar ? "ر.س، بنسبة فعّالة" : "SAR, an effective"}{" "}
          {rate(example.effective)} — {ar ? "لا" : "not"} {rate(base + Number(v.tiers[1].ratePercent))}.
        </p>
      )}

      <p className="mt-2 flex items-start gap-2 rounded-[10px] border border-oo-status-rejected bg-oo-status-rejected-bg px-3 py-[9px] text-[12px] leading-[18px] text-oo-status-rejected">
        <Lock size={13} aria-hidden className="mt-0.5 shrink-0" />
        <span>
          {ar
            ? "الشرائح بأثر رجعي مرفوضة في هذا الإصدار — تُعطي مبالغ مختلفة جذرياً على الأرقام نفسها، والخطأ يظهر في قسيمة راتب. العملة الريال السعودي حصراً: لا سياسة صرف عملات."
            : "Retroactive tiers are refused in this release — they give radically different amounts on the same figures, and the mistake surfaces on a payslip. Saudi riyals only: there is no exchange-rate policy."}
        </span>
      </p>
    </div>
  );
}

type Version = {
  id: string;
  version: number;
  basis: string;
  tierMode: string;
  baseRatePercent: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  tiers: Tier[];
  _count: { accruals: number; assignments: number };
};

type Plan = {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  isActive: boolean;
  versions: Version[];
  _count: { assignments: number };
};

type Assignment = {
  id: string;
  employeeId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  live: boolean;
  employee: { id: string; name: string; role: string; active: boolean };
  plan: { id: string; code: string; name: string };
  planVersion: { id: string; version: number; baseRatePercent: string; tierMode: string; currency: string };
};

export default function CommissionPlansPage() {
  const lang = useLang();
  const ar = lang === "ar";

  const [plans, setPlans] = useState<Plan[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [employees, setEmployees] = useState<{ id: string; name: string; role: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dialog, setDialog] = useState<
    { kind: "plan" } | { kind: "version"; plan: Plan } | { kind: "assign" } | null
  >(null);

  /**
   * Reload counter.
   *
   * The fetch lives in the effect rather than in a `useCallback` the effect calls: the lint
   * rule resolves a called callback and sees setState reachable from the effect body, and
   * inlining puts the first `await` before any state write. Mutations refresh by bumping this
   * instead of holding a callable loader, so the refresh behaviour is unchanged.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, a] = await Promise.all([
        api<{ plans: Plan[] }>("/api/commissions/plans"),
        api<{ assignments: Assignment[]; employees: { id: string; name: string; role: string }[] }>(
          "/api/commissions/assignments",
        ),
      ]);
      if (cancelled) return;
      if (p.ok) setPlans(p.data.plans);
      else setError(p.data.error ?? (ar ? "تعذّر تحميل الخطط." : "Could not load the plans."));
      if (a.ok) {
        setAssignments(a.data.assignments);
        setEmployees(a.data.employees);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [ar, reloadToken]);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "خطط العمولة والإسناد" : "Commission plans and assignments"}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{ar ? "النسخة تُجمَّد عند أول استحقاق" : "A version freezes at its first accrual"}</span>
            <span aria-hidden className="text-oo-border-strong">·</span>
            <span>{ar ? "الإسناد يُنهى ولا يُحذف" : "an assignment is ended, never deleted"}</span>
            <span aria-hidden className="text-oo-border-strong">·</span>
            <span>
              {num(plans.length, lang)} {ar ? "خطة" : "plans"} ·{" "}
              {num(assignments.filter((a) => a.live).length, lang)}{" "}
              {ar ? "إسناد ساري" : "live assignments"}
            </span>
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog({ kind: "assign" })} testId="new-assignment">
              <UserPlus size={15} aria-hidden /> {ar ? "إسناد موظّف إلى خطة" : "Assign someone to a plan"}
            </Button>
            <Button onClick={() => setDialog({ kind: "plan" })} testId="new-plan">
              <Plus size={15} aria-hidden /> {ar ? "خطة جديدة" : "New plan"}
            </Button>
          </>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      {plans.length === 0 ? (
        <Card>
          <EmptyState>
            <Percent size={28} className="mx-auto mb-2 opacity-40" aria-hidden />
            {ar ? "لا توجد خطط عمولات بعد." : "No commission plans yet."}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-4">
          {plans.map((plan) => (
            <Card key={plan.id}>
              <SectionTitle
                right={
                  <Button
                    variant="ghost"
                    onClick={() => setDialog({ kind: "version", plan })}
                    testId={`new-version-${plan.code}`}
                  >
                    + {ar ? "إصدار جديد" : "New version"}
                  </Button>
                }
              >
                <span className="inline-flex items-center gap-2">
                  <span className="font-mono text-xs bg-oo-bg-subtle px-1.5 py-0.5 rounded">{plan.code}</span>
                  {ar ? (plan.nameAr ?? plan.name) : plan.name}
                  {!plan.isActive && <Pill tone="neutral">{ar ? "غير نشطة" : "inactive"}</Pill>}
                </span>
              </SectionTitle>

              {plan.description && (
                <p className="mb-3 text-[12px] leading-[18px] text-oo-text-secondary">{plan.description}</p>
              )}

              {plan.versions.map((v) => (
                <PlanVersion key={v.id} ar={ar} lang={lang} plan={plan} version={v} />
              ))}
            </Card>
          ))}
        </div>
      )}

      {/* ── Assignments ───────────────────────────────────────────── */}
      <Card>
        <SectionTitle>
          {ar ? "إسناد الموظّفين — لكل موظّف نسخة وفترة سريان" : "Assignments — each person has a version and a period"}
        </SectionTitle>
        {assignments.length === 0 ? (
          <EmptyState>{ar ? "لم يُعيَّن أحد بعد." : "Nobody is assigned yet."}</EmptyState>
        ) : (
          <div className="-mx-5 mt-3 overflow-x-auto border-y border-oo-border-default">
            <table className="w-full min-w-[720px] border-collapse text-start" data-testid="assignments-table">
              <thead>
                <tr className="bg-oo-bg-subtle">
                  {[
                    [ar ? "الموظّف" : "Employee", "min-w-[200px]"],
                    [ar ? "النسخة" : "Version", "w-[200px]"],
                    [ar ? "سريان من" : "From", "w-[150px]"],
                    [ar ? "سريان حتى" : "Until", "w-[150px]"],
                    ["", "w-[160px]"],
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
                {assignments.map((a) => (
                  <tr
                    key={a.id}
                    className="border-t border-oo-border-default"
                    data-testid={`assignment-${a.employeeId}`}
                  >
                    <Td>
                      {a.employee.name}
                      {!a.employee.active && (
                        <Pill tone="neutral">{ar ? "غير نشط" : "inactive"}</Pill>
                      )}
                    </Td>
                    <Td>
                      {a.plan.name}
                      {" · "}
                      {ar ? `ن${num(a.planVersion.version, "ar")}` : `v${a.planVersion.version}`}
                    </Td>
                    <Td>{formatDay(a.effectiveFrom, lang)}</Td>
                    <Td>{a.effectiveTo ? formatDay(a.effectiveTo, lang) : (ar ? "مفتوح" : "open")}</Td>
                    <Td>
                      {a.live ? (
                        <EndAssignmentButton
                          ar={ar}
                          assignmentId={a.id}
                          onDone={(msg) => {
                            setSuccess(msg);
                            reload();
                          }}
                          onError={setError}
                        />
                      ) : (
                        <span className={`${ROW_ACTION} cursor-not-allowed text-oo-text-muted`}>
                          {ar ? "منتهٍ" : "ended"}
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-[12px] leading-[18px] text-oo-text-muted">
          {ar
            ? "لا يستطيع أحد تعيين نفسه على خطة، مهما كانت صلاحياته — لأن صلاحية إدارة الخطط قد تكون بيد مدير مبيعات هو نفسه على خطة."
            : "Nobody can put themselves on a plan, whatever their privileges: plan administration can legitimately belong to a sales manager who is on a plan themselves."}
        </p>
      </Card>

      {dialog?.kind === "plan" && (
        <PlanDialog
          ar={ar}
          onClose={() => setDialog(null)}
          onDone={(m) => {
            setDialog(null);
            setSuccess(m);
            reload();
          }}
        />
      )}
      {dialog?.kind === "version" && (
        <PlanDialog
          ar={ar}
          plan={dialog.plan}
          onClose={() => setDialog(null)}
          onDone={(m) => {
            setDialog(null);
            setSuccess(m);
            reload();
          }}
        />
      )}
      {dialog?.kind === "assign" && (
        <AssignDialog
          ar={ar}
          plans={plans}
          employees={employees}
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

function EndAssignmentButton({
  ar, assignmentId, onDone, onError,
}: {
  ar: boolean; assignmentId: string; onDone: (m: string) => void; onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        data-testid={`end-${assignmentId}`}
        className={`${ROW_ACTION} text-oo-text-primary hover:border-oo-action-primary`}
      >
        {ar ? "إنهاء الإسناد" : "End the assignment"}
      </button>
    );
  }
  return (
    <Modal
      title={ar ? "إنهاء التعيين" : "End the assignment"}
      onClose={() => setOpen(false)}
      testId="end-assignment-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy}
            testId="confirm-end"
            onClick={async () => {
              setBusy(true);
              const res = await api("/api/commissions/assignments", {
                method: "PATCH",
                body: { assignmentId, effectiveTo: date },
              });
              setBusy(false);
              setOpen(false);
              if (res.ok) onDone(ar ? "أُنهي التعيين." : "Assignment ended.");
              else onError(res.data.error ?? "");
            }}
          >
            {ar ? "إنهاء" : "End it"}
          </Button>
        </>
      }
    >
      <Field
        id="end-date"
        label={ar ? "ينتهي في" : "Ends on"}
        hint={
          ar
            ? "ينتهي ولا يُحذف: استُحقّت عمولات تحته، وحذف السطر يترك كشف راتب لا يستطيع أحد تفسيره."
            : "Ended, not deleted: money accrued under it, and removing the row leaves a payslip nobody can explain."
        }
      >
        <TextInput id="end-date" type="date" value={date} onChange={setDate} />
      </Field>
    </Modal>
  );
}

function PlanDialog({
  ar, plan, onClose, onDone,
}: {
  ar: boolean; plan?: Plan; onClose: () => void; onDone: (m: string) => void;
}) {
  const isNewVersion = !!plan;
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [description, setDescription] = useState("");
  const [baseRatePercent, setBaseRatePercent] = useState("1");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState("");
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  return (
    <Modal
      wide
      title={
        isNewVersion
          ? ar ? `إصدار جديد من ${plan!.code}` : `New version of ${plan!.code}`
          : ar ? "خطة عمولة جديدة" : "New commission plan"
      }
      onClose={onClose}
      testId="plan-dialog"
      footer={
        <>
          <Button
            variant="ghost"
            testId="add-tier"
            onClick={() => setTiers([...tiers, { fromAmount: "0", toAmount: null, ratePercent: "0" }])}
          >
            <Plus size={14} aria-hidden /> {ar ? "شريحة" : "Tier"}
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || (!isNewVersion && (code.trim().length < 2 || name.trim().length < 2))}
            testId="save-plan"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const version = {
                baseRatePercent,
                tierMode: "INCREMENTAL",
                currency: "SAR",
                effectiveFrom,
                effectiveTo: effectiveTo || null,
                tiers: tiers.map((t) => ({
                  fromAmount: t.fromAmount,
                  toAmount: t.toAmount === null || t.toAmount === "" ? null : t.toAmount,
                  ratePercent: t.ratePercent,
                })),
              };
              const res = isNewVersion
                ? await api(`/api/commissions/plans/${plan!.id}/versions`, { method: "POST", body: version })
                : await api("/api/commissions/plans", {
                    method: "POST",
                    body: { code, name, nameAr, description, version },
                  });
              setBusy(false);
              if (res.ok) onDone(isNewVersion ? (ar ? "أُضيف الإصدار." : "Version added.") : ar ? "أُنشئت الخطة." : "Plan created.");
              else setErr(res.data.error ?? "");
            }}
          >
            {ar ? "حفظ" : "Save"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}

      {!isNewVersion && (
        <>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field id="pl-code" label={ar ? "الرمز" : "Code"} required hint="STANDARD, SENIOR…">
              <TextInput id="pl-code" value={code} onChange={setCode} />
            </Field>
            <Field id="pl-name" label={ar ? "الاسم" : "Name"} required>
              <TextInput id="pl-name" value={name} onChange={setName} />
            </Field>
          </div>
          <Field id="pl-namear" label={ar ? "الاسم بالعربية" : "Arabic name"}>
            <TextInput id="pl-namear" value={nameAr} onChange={setNameAr} />
          </Field>
          <Field id="pl-desc" label={ar ? "الوصف" : "Description"}>
            <TextArea id="pl-desc" value={description} onChange={setDescription} rows={2} />
          </Field>
        </>
      )}

      <div className="grid sm:grid-cols-3 gap-3">
        <Field
          id="pl-rate"
          label={ar ? "النسبة الأساسية %" : "Base rate %"}
          required
          hint={ar ? "تُطبَّق على كامل الأساس." : "Applied to the whole base."}
        >
          <TextInput id="pl-rate" value={baseRatePercent} onChange={setBaseRatePercent} inputMode="decimal" />
        </Field>
        <Field id="pl-from" label={ar ? "سارية من" : "Effective from"} required>
          <TextInput id="pl-from" type="date" value={effectiveFrom} onChange={setEffectiveFrom} />
        </Field>
        <Field id="pl-to" label={ar ? "حتى" : "Until"} hint={ar ? "اتركه فارغاً للمفتوح." : "Leave empty for open-ended."}>
          <TextInput id="pl-to" type="date" value={effectiveTo} onChange={setEffectiveTo} />
        </Field>
      </div>

      <div>
        <p className="text-xs font-bold text-oo-text-secondary mb-2">{ar ? "الشرائح" : "Tiers"}</p>
        {tiers.length === 0 ? (
          <p className="text-xs text-oo-text-muted font-semibold">
            {ar ? "بلا شرائح: النسبة الأساسية على كل شيء." : "No tiers: the base rate on everything."}
          </p>
        ) : (
          <div className="space-y-2">
            {tiers.map((t, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end" data-testid={`tier-${i}`}>
                <Field id={`tier-from-${i}`} label={ar ? "من" : "From"}>
                  <TextInput
                    id={`tier-from-${i}`}
                    value={t.fromAmount}
                    inputMode="decimal"
                    onChange={(v) => setTiers(tiers.map((x, j) => (j === i ? { ...x, fromAmount: v } : x)))}
                  />
                </Field>
                <Field id={`tier-to-${i}`} label={ar ? "إلى (فارغ = فأكثر)" : "To (empty = and above)"}>
                  <TextInput
                    id={`tier-to-${i}`}
                    value={t.toAmount ?? ""}
                    inputMode="decimal"
                    onChange={(v) => setTiers(tiers.map((x, j) => (j === i ? { ...x, toAmount: v || null } : x)))}
                  />
                </Field>
                <Field id={`tier-rate-${i}`} label={ar ? "+ نقاط" : "+ points"}>
                  <TextInput
                    id={`tier-rate-${i}`}
                    value={t.ratePercent}
                    inputMode="decimal"
                    onChange={(v) => setTiers(tiers.map((x, j) => (j === i ? { ...x, ratePercent: v } : x)))}
                  />
                </Field>
                <Button variant="ghost" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>×</Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-oo-text-muted mt-2 font-medium">
          {ar
            ? "الشريحة تضيف نقاطاً مئوية على الجزء الواقع داخل نطاقها فقط. مثال: 1% + 0.5 نقطة على 100,000–120,000 تدفع 1,150 على أساس 110,000 — أي 1.045455% فعلياً، لا 1.5%."
            : "A tier adds percentage POINTS to the slice of base inside its band only. 1% plus 0.5 points on 100,000–120,000 pays 1,150 on a base of 110,000 — an effective 1.045455%, not 1.5%."}
        </p>
      </div>

      {isNewVersion && (
        <p className="text-[11px] text-oo-text-muted font-medium">
          {ar
            ? "الإصدار السابق يُغلق عند تاريخ بداية هذا الإصدار، فلا توجد لحظة بإصدارين ساريين. وما استُحق تحت القديم يبقى محسوباً به."
            : "The previous version is closed at this one's start date, so there is never a moment with two live versions. What was earned under the old one stays computed by it."}
        </p>
      )}
    </Modal>
  );
}

function AssignDialog({
  ar, plans, employees, onClose, onDone,
}: {
  ar: boolean;
  plans: Plan[];
  employees: { id: string; name: string; role: string }[];
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [planVersionId, setPlanVersionId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const options = plans.flatMap((p) =>
    p.versions.map((v) => ({
      id: v.id,
      label: `${p.code} v${v.version} — ${v.baseRatePercent}%${v.tiers.length ? ` +${v.tiers.length} ${ar ? "شرائح" : "tiers"}` : ""}`,
    })),
  );

  return (
    <Modal
      title={ar ? "تعيين موظف على خطة" : "Assign someone to a plan"}
      onClose={onClose}
      testId="assign-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || !employeeId || !planVersionId}
            testId="save-assignment"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api("/api/commissions/assignments", {
                method: "POST",
                body: { employeeId, planVersionId, effectiveFrom, effectiveTo: effectiveTo || null },
              });
              setBusy(false);
              if (res.ok) onDone(ar ? "تم التعيين." : "Assigned.");
              else setErr(res.data.error ?? "");
            }}
          >
            {ar ? "تعيين" : "Assign"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}
      <Field id="as-emp" label={ar ? "الموظف" : "Employee"} required>
        <Select id="as-emp" value={employeeId} onChange={setEmployeeId}>
          <option value="">—</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </Select>
      </Field>
      <Field id="as-ver" label={ar ? "الخطة والإصدار" : "Plan and version"} required>
        <Select id="as-ver" value={planVersionId} onChange={setPlanVersionId}>
          <option value="">—</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="as-from" label={ar ? "من" : "From"} required>
          <TextInput id="as-from" type="date" value={effectiveFrom} onChange={setEffectiveFrom} />
        </Field>
        <Field id="as-to" label={ar ? "حتى" : "Until"} hint={ar ? "فارغ = مفتوح" : "empty = open"}>
          <TextInput id="as-to" type="date" value={effectiveTo} onChange={setEffectiveTo} />
        </Field>
      </div>
      <p className="text-[11px] text-oo-text-muted font-medium">
        {ar
          ? "التعيينات لا تتداخل: خطتان ساريتان لشخص واحد ليس لهما جواب محدّد."
          : "Assignments may not overlap: two live plans for one person have no defined answer."}
      </p>
    </Modal>
  );
}
