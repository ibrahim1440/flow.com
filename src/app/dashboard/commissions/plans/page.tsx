"use client";

import { useState, useEffect } from "react";
import { Percent, Plus, Lock, UserPlus } from "lucide-react";
import {
  useLang, ProvisionalBanner, PageHeader, Alert, Card, SectionTitle, EmptyState, Spinner,
  Button, Field, TextInput, Select, TextArea, Pill, Modal, TableWrap, api,
} from "../../sales/_components/ui";
import { formatDate } from "@/lib/utils";

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
    <div className="space-y-6">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "خطط العمولات" : "Commission plans"}
        subtitle={
          <span className="mt-1 block">
            {plans.length} {ar ? "خطة" : "plans"} · {assignments.filter((a) => a.live).length}{" "}
            {ar ? "تعيين نشط" : "live assignments"}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog({ kind: "assign" })} testId="new-assignment">
              <UserPlus size={15} aria-hidden /> {ar ? "تعيين موظف" : "Assign someone"}
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
                  <span className="font-mono text-xs bg-cream px-1.5 py-0.5 rounded">{plan.code}</span>
                  {ar ? (plan.nameAr ?? plan.name) : plan.name}
                  {!plan.isActive && <Pill tone="neutral">{ar ? "غير نشطة" : "inactive"}</Pill>}
                </span>
              </SectionTitle>

              {plan.description && <p className="text-xs text-brown mb-3">{plan.description}</p>}

              <TableWrap>
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr className="text-[11px] uppercase text-brown/60 font-bold">
                      <th className="text-start py-2">{ar ? "الإصدار" : "Version"}</th>
                      <th className="text-end py-2">{ar ? "النسبة الأساسية" : "Base rate"}</th>
                      <th className="text-start py-2">{ar ? "الشرائح" : "Tiers"}</th>
                      <th className="text-start py-2">{ar ? "من" : "From"}</th>
                      <th className="text-start py-2">{ar ? "إلى" : "To"}</th>
                      <th className="text-start py-2">{ar ? "الحالة" : "State"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.versions.map((v) => (
                      <tr key={v.id} className="border-t border-border align-top" data-testid={`version-${plan.code}-${v.version}`}>
                        <td className="py-2.5 font-bold">v{v.version}</td>
                        <td className="py-2.5 text-end tabular-nums font-bold">{v.baseRatePercent}%</td>
                        <td className="py-2.5">
                          {v.tiers.length === 0 ? (
                            <span className="text-brown/40">—</span>
                          ) : (
                            <ul className="space-y-0.5 text-xs">
                              {v.tiers.map((t, i) => (
                                <li key={i} className="tabular-nums">
                                  {t.fromAmount} – {t.toAmount ?? (ar ? "فأكثر" : "and above")}
                                  <span className="text-orange font-bold ps-1.5">+{t.ratePercent}</span>
                                  <span className="text-brown/50 ps-0.5">
                                    {ar ? "نقطة" : "pts"}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td className="py-2.5 text-xs">{formatDate(v.effectiveFrom)}</td>
                        <td className="py-2.5 text-xs">
                          {v.effectiveTo ? formatDate(v.effectiveTo) : (ar ? "مفتوح" : "open")}
                        </td>
                        <td className="py-2.5">
                          {v._count.accruals > 0 ? (
                            <Pill tone="warn">
                              <span className="inline-flex items-center gap-1">
                                <Lock size={10} aria-hidden />
                                {ar ? `مثبّت · ${v._count.accruals} استحقاق` : `frozen · ${v._count.accruals} accruals`}
                              </span>
                            </Pill>
                          ) : (
                            <Pill tone="info">
                              {v._count.assignments} {ar ? "تعيين" : "assigned"}
                            </Pill>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          ))}
        </div>
      )}

      {/* ── Assignments ───────────────────────────────────────────── */}
      <Card>
        <SectionTitle>{ar ? "من على أي خطة" : "Who is on which plan"}</SectionTitle>
        {assignments.length === 0 ? (
          <EmptyState>{ar ? "لم يُعيَّن أحد بعد." : "Nobody is assigned yet."}</EmptyState>
        ) : (
          <TableWrap>
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-[11px] uppercase text-brown/60 font-bold">
                  <th className="text-start py-2">{ar ? "الموظف" : "Employee"}</th>
                  <th className="text-start py-2">{ar ? "الخطة" : "Plan"}</th>
                  <th className="text-end py-2">{ar ? "النسبة" : "Rate"}</th>
                  <th className="text-start py-2">{ar ? "من" : "From"}</th>
                  <th className="text-start py-2">{ar ? "إلى" : "To"}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={a.id} className="border-t border-border" data-testid={`assignment-${a.employeeId}`}>
                    <td className="py-2.5 font-bold">
                      {a.employee.name}
                      {!a.employee.active && (
                        <Pill tone="neutral">{ar ? "غير نشط" : "inactive"}</Pill>
                      )}
                    </td>
                    <td className="py-2.5">
                      <span className="font-mono text-xs">{a.plan.code}</span>
                      <span className="text-brown/60 text-xs ps-1">v{a.planVersion.version}</span>
                    </td>
                    <td className="py-2.5 text-end tabular-nums">{a.planVersion.baseRatePercent}%</td>
                    <td className="py-2.5 text-xs">{formatDate(a.effectiveFrom)}</td>
                    <td className="py-2.5 text-xs">
                      {a.effectiveTo ? formatDate(a.effectiveTo) : (ar ? "مفتوح" : "open")}
                    </td>
                    <td className="py-2.5 text-end">
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
                        <Pill tone="neutral">{ar ? "منتهٍ" : "ended"}</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="text-[11px] text-brown/60 mt-3 font-medium">
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
      <Button variant="ghost" onClick={() => setOpen(true)} testId={`end-${assignmentId}`}>
        {ar ? "إنهاء" : "End"}
      </Button>
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
        <p className="text-xs font-bold text-brown mb-2">{ar ? "الشرائح" : "Tiers"}</p>
        {tiers.length === 0 ? (
          <p className="text-xs text-brown/50 font-semibold">
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
        <p className="text-[11px] text-brown/60 mt-2 font-medium">
          {ar
            ? "الشريحة تضيف نقاطاً مئوية على الجزء الواقع داخل نطاقها فقط. مثال: 1% + 0.5 نقطة على 100,000–120,000 تدفع 1,150 على أساس 110,000 — أي 1.045455% فعلياً، لا 1.5%."
            : "A tier adds percentage POINTS to the slice of base inside its band only. 1% plus 0.5 points on 100,000–120,000 pays 1,150 on a base of 110,000 — an effective 1.045455%, not 1.5%."}
        </p>
      </div>

      {isNewVersion && (
        <p className="text-[11px] text-brown/60 font-medium">
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
      <p className="text-[11px] text-brown/60 font-medium">
        {ar
          ? "التعيينات لا تتداخل: خطتان ساريتان لشخص واحد ليس لهما جواب محدّد."
          : "Assignments may not overlap: two live plans for one person have no defined answer."}
      </p>
    </Modal>
  );
}
