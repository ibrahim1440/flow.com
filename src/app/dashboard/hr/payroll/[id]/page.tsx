"use client";
// HR-03 · Payroll run detail (Figma 1JbZgpMqmPkUVne8ms9Ozz · 451:5844; 1024: 455:2729).
// Every button is a convenience: the API re-checks the duty and the segregation rules
// (preparer ≠ approver, nobody approves their own line, payer ≠ preparer).
import { Select } from "@/components/ui/Select";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  Btn, Dialog, Empty, ErrorState, Field, Flag, KV, LoadingTable, Metrics, Notice, PageHeader, ProposalTag, RUN_STATUS,
  StatusDot, hrFetch, money, todayIso, useAction, useCan, useForm, useHr, useHrI18n, useHrMeta,
} from "@/components/hr/ui";
import { orgName } from "@/lib/i18n/hr";
import { hrText } from "@/lib/hr/messages-en";
import {
  ADJUSTMENT_CATEGORY, ALLOWANCE_CODES, JOURNAL_PURPOSE, JOURNAL_STATUS, METHOD_LABEL, SETTLEMENT_STATUS, dash, day, dayRows, fullUnpaid, itemLabel, itemNote, label, sumCodes,
  type ApproveResult, type PayException, type RunDetail, type RunLine, dayParts,
} from "../shared";
import { DayValue } from "../day-value";

type DialogKind = null | "adjust" | "return" | "cancel" | "pay" | "proof" | "bankReturn";

const excs = (l: RunLine): PayException[] => (Array.isArray(l.exceptions) ? l.exceptions : []);

// P-3 refusals, by the reason code the server returns (Q-1, Q-2).
const PAY_BLOCK: Record<string, [string, string]> = {
  SOD_PREPARER: ["لا يمكنك تسجيل صرف مسيّر رواتب أعددته بنفسك. يسجّله المشغّل المعيَّن.", "You cannot record the payment of a payroll run you prepared. The designated operator records it."],
  SOD_APPROVER: ["لا يمكنك تسجيل صرف مسيّر رواتب اعتمدته بنفسك. يسجّله المشغّل المعيَّن.", "You cannot record the payment of a payroll run you approved. The designated operator records it."],
  SOD_PAYEE: ["لا يمكنك تسجيل صرف مسيّر رواتب تتقاضى منه. يسجّله مشغّل آخر.", "You cannot record the payment of a payroll run you are paid from. Another operator records it."],
};
const CANCEL_BLOCK: Record<string, [string, string]> = {
  SOD_PREPARER: ["لا يمكنك إلغاء مسيّر رواتب معتمد أعددته بنفسك.", "You cannot cancel an approved payroll run you prepared."],
  SOD_APPROVER: ["لا يمكنك إلغاء مسيّر رواتب اعتمدته بنفسك.", "You cannot cancel a payroll run you approved."],
};

export default function PayrollRunPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { meta } = useHrMeta();
  const url = `/api/hr/payroll/runs/${id}`;
  const { data: run, error, loading, reload } = useHr<RunDetail>(url);
  const a = useAction();
  const [flash, setFlash] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  // P-2 rev3 item 2: the credit a return is recorded against.
  const [returnOf, setReturnOf] = useState<string | null>(null);
  const { L, t, lang, month } = useHrI18n();

  if (error && !run) return <div className="hr-page"><ErrorState error={error} onRetry={reload} /></div>;
  if (!run) return <div className="hr-page">{loading ? <LoadingTable /> : null}</div>;

  const lines = run.lines;
  const blockingLines = lines.filter((l) => l.blocking).length;
  const pendingLines = lines.filter((l) => !l.approvedBy);
  const approvable = pendingLines.filter((l) => !l.isMine).length;
  const approvedCount = lines.length - pendingLines.length;
  const allExceptions = lines.flatMap((l) => excs(l).filter((e) => e.code !== "POLICY_PROPOSAL").map((e) => ({ ...e, line: l })));
  const blockingCount = allExceptions.filter((e) => e.severity === "BLOCKING").length;
  // Round-4 (P3): warnings (a check is incomplete, e.g. SAME_PERSON_CHECK_INCOMPLETE) never block,
  // so they are counted apart from the open (blocking) exceptions.
  const warningCount = allExceptions.filter((e) => e.severity === "WARNING").length;
  const sel = lines.find((l) => l.id === selected) ?? null;
  const st = run.status;
  // P-2 rev3 item 6: a line whose whole period is unpaid leave shows no payable figure (blocked).
  const withheld = lines.filter((l) => fullUnpaid(l.dayDetail));
  const withheldNet = withheld.reduce((s, l) => s + Number(l.net), 0);

  const done = async (fn: () => Promise<unknown>, key: string, msg?: (r: unknown) => string) => {
    setFlash(null);
    const r = await a.run(key, fn);
    if (r !== undefined) {
      setDialog(null);
      if (msg) setFlash(msg(r));
      await reload();
    }
    return r;
  };
  const post = (path: string, json: unknown = {}) => () => hrFetch<RunDetail>(`${url}/${path}`, { json });
  // P-2 review P2-B7: escalated advances are acknowledged by the preparer when submitting.
  const escalations = run.escalations ?? [];

  const approveAll = () =>
    done(post("approve", {}), "approve", (r) => {
      const x = r as ApproveResult;
      return x.finalized
        ? L(`اعتُمد ${x.approvedNow} بنود واكتمل اعتماد المسير${x.accountingSkipped ? " (المحاسبة غير مفعّلة، لم يُرحَّل قيد)." : " ورُحّل قيد الاستحقاق."}`, `${x.approvedNow} lines approved and the run is fully approved${x.accountingSkipped ? " (accounting is off; no entry posted)." : "; the accrual entry is posted."}`)
        : L(`اعتُمد ${x.approvedNow} بنود.${x.skippedOwn ? ` بقي بندك بانتظار معتمد مستقل.` : ""} المتبقي ${x.lines.filter((l) => !l.approvedBy).length}.`, `${x.approvedNow} lines approved.${x.skippedOwn ? " Your own line awaits an independent approver." : ""} ${x.lines.filter((l) => !l.approvedBy).length} remaining.`);
    });
  const approveLine = (lineId: string) =>
    done(post("approve", { lineIds: [lineId] }), `approve:${lineId}`, (r) => ((r as ApproveResult).finalized ? L("اعتُمد البند واكتمل اعتماد المسير.", "Line approved and the run is fully approved.") : L("اعتُمد البند.", "Line approved.")));

  const actions: ReactNode[] = [];
  if (st === "DRAFT") {
    if (can("payroll_prepare")) {
      actions.push(<Btn key="rebuild" busy={a.busy === "rebuild"} onClick={() => done(post("rebuild"), "rebuild", () => L("أُعيد احتساب المسير من البيانات الحالية.", "The run was rebuilt from current data."))}>{L("إعادة الاحتساب", "Rebuild")}</Btn>);
      actions.push(<Btn key="adjust" onClick={() => setDialog("adjust")}>{L("تسوية", "Adjustment")}</Btn>);
    }
    if (can("payroll_prepare") || can("payroll_approve")) actions.push(<Btn key="cancel" variant="danger" onClick={() => setDialog("cancel")}>{L("إلغاء", "Cancel")}</Btn>);
    if (can("payroll_prepare"))
      actions.push(
        <Btn key="submit" variant="primary" busy={a.busy === "submit"} disabled={blockingLines > 0 || lines.length === 0 || (escalations.length > 0 && !ack)} title={blockingLines ? L("عالج الاستثناءات المانعة ثم أعد الاحتساب", "Resolve the blocking exceptions, then rebuild") : escalations.length && !ack ? L("أقرّ بالسلف المصعّدة أولًا", "Acknowledge the escalated advances first") : undefined} onClick={() => done(post("submit", { acknowledgeEscalations: ack ? escalations.map((e) => e.reviewItemId) : [] }), "submit", () => L("أُرسل المسير للاعتماد.", "The run was submitted for approval."))}>
          {t("submitForApproval")}
        </Btn>,
      );
  } else if (st === "REVIEW") {
    if (can("payroll_prepare") || can("payroll_approve")) actions.push(<Btn key="return" onClick={() => setDialog("return")}>{L("إرجاع للمراجعة", "Return for review")}</Btn>);
    if (run.canApprove && approvable > 0)
      actions.push(
        <Btn key="approve" variant="primary" busy={a.busy === "approve"} onClick={approveAll}>
          {L(`اعتماد ${approvable} بنود`, `Approve ${approvable} lines`)}
        </Btn>,
      );
  } else if (st === "APPROVED") {
    // Q-2: after approval only the separately authorized duty cancels, never a preparer or approver.
    if (run.canCancelApproved) actions.push(<Btn key="cancel" variant="danger" onClick={() => setDialog("cancel")}>{L("إلغاء", "Cancel")}</Btn>);
    // P-3: offered only to someone the server lets record it (an operator who did not prepare the run).
    if (run.canPay) actions.push(<Btn key="pay" variant="primary" onClick={() => setDialog("pay")}>{L("تسجيل الصرف", "Record payment")}</Btn>);
    // P-2 rev3 item 2: the bank's per-employee proof of a recorded payment.
    if (run.canProve && run.payments.some((p) => Number(p.unallocated ?? 0) > 0)) actions.push(<Btn key="proof" onClick={() => setDialog("proof")}>{L("إثبات الصرف للموظفين", "Proof per employee")}</Btn>);
  }
  actions.unshift(
    <a key="export" className="hr-btn" href={`${url}/export`} download title={L("CSV عام — ليس ملف حماية الأجور (WPS/مدد). الآيبان يظهر فقط لمن يملك صلاحية البيانات الخاصة.", "Generic CSV — not a wage-protection (WPS/Mudad) file. IBANs appear only for users with the private-data permission.")}>
      {L("تصدير CSV", "Export CSV")}
    </a>,
  );

  // Process track: مسودة · مراجعة الاستثناءات · الاعتماد · تسجيل الصرف
  const stepIdx = st === "DRAFT" ? 1 : st === "REVIEW" ? 2 : st === "APPROVED" ? 3 : st === "PAID" ? 4 : -1;
  const steps: [string, ReactNode][] = [
    // Dates are isolated LTR: a bare 2026-10-09 inside an Arabic caption renders as 09-10-2026.
    [L("مسودة", "Draft"), <>{run.preparedByName ?? "—"} · <span className="hr-num">{day(run.preparedAt)}</span></>],
    [L("مراجعة الاستثناءات", "Review exceptions"), st === "DRAFT" ? (blockingLines ? L(`${blockingLines} بنود عليها استثناء مانع`, `${blockingLines} lines with a blocking exception`) : L("لا استثناءات مانعة", "No blocking exceptions")) : run.submittedAt ? <>{L("أُرسل", "Submitted")} <span className="hr-num">{day(run.submittedAt)}</span></> : "—"],
    [L("الاعتماد", "Approval"), run.approvedAt ? <>{L("اكتمل", "Completed")} <span className="hr-num">{day(run.approvedAt)}</span></> : st === "REVIEW" ? L(`${approvedCount} من ${lines.length} بنود معتمدة`, `${approvedCount} of ${lines.length} lines approved`) : L("كل بند يعتمده شخص مستقل", "Each line is approved by an independent person")],
    [L("تسجيل الصرف", "Record payment"), run.paidAt ? <>{L("صُرف", "Paid")} <span className="hr-num">{day(run.paidAt)}</span> · {L("تسجيل فقط", "record only")}</> : L("تسجيل فقط · لا تحويل بنكي", "Record only · no bank transfer")],
  ];

  const stageLabel = st === "DRAFT" ? L("مسودة", "Draft") : st === "REVIEW" ? L(`الاعتماد ${approvedCount}/${lines.length}`, `Approval ${approvedCount}/${lines.length}`) : st === "APPROVED" ? L("بانتظار الصرف", "Awaiting payment") : st === "PAID" ? L("مصروف", "Paid") : L("ملغى", "Cancelled");

  // Column totals (the run totals carry gross/deductions/net; the split columns are summed here).
  const col = (codes: string[]) => lines.reduce((s, l) => s + sumCodes(l.items, codes), 0);

  return (
    <div className={`hr-split${sel ? " has-preview" : ""}`}>
      <div className="hr-page is-tight-mobile">
        <div className="hr-caption hr-hide-mobile"><Link href="/dashboard/hr/payroll" className="hr-muted">{L("مسيرات الرواتب", "Payroll runs")}</Link> / <span className="hr-id">#{run.runNo}</span></div>
        <PageHeader
          title={<>{L(`مسير ${month(run.periodMonth)}`, `${month(run.periodMonth)} payroll`)}{run.kind === "CORRECTION" ? <> <span className="hr-flag tone-info" style={{ verticalAlign: "middle" }}>{L("تصحيح", "Correction")}</span></> : null}</>}
          actions={actions}
        >
          <StatusDot map={RUN_STATUS} value={st} />
          <span className="hr-caption">{run.branchKey === "COMPANY" ? t("wholeCompany") : (() => { const b = meta?.branches.find((x) => x.id === run.branchKey); return b ? orgName(b, lang) : run.branchKey; })()}</span>
          <span className="hr-caption"><span className="hr-hide-mobile">{L("الفترة ", "Period ")}</span><span className="hr-num">{run.periodStart}</span> – <span className="hr-num">{run.periodEnd}</span></span>
          {/* Phone (M-03 R3): the policy line is the warning notice below, which says the same in full. */}
          <span className="hr-caption hr-hide-mobile">{L("سياسة الرواتب", "Payroll policy")} v{run.policy.version} · {L("أساس الأيام", "day basis")} {run.policy.dayBasis}</span>
          {run.policy.isProposal ? <span className="hr-hide-mobile"><ProposalTag /></span> : null}
        </PageHeader>

        {a.error && !dialog ? <Notice tone="danger">{a.error}</Notice> : null}
        {flash ? <Notice tone="success">{flash}</Notice> : null}
        {error ? <ErrorState error={error} onRetry={reload} /> : null}

        {st === "CANCELLED" ? (
          <Notice tone="warning">
            {L("أُلغي هذا المسير", "This run was cancelled")} {run.cancelledAt ? L(`في ${day(run.cancelledAt)}`, `on ${day(run.cancelledAt)}`) : ""}. {L("السبب:", "Reason:")} {run.cancelReason ?? "—"}. {L("أُعيدت أقساط السلف والإضافي والعمولات المحجوزة، وعُكس قيد الاستحقاق إن كان قد رُحّل.", "Reserved advance instalments, overtime and commissions were released, and the accrual entry was reversed if it had been posted.")}
          </Notice>
        ) : (
          <div className="hr-track hr-hide-compact" aria-label={L("مراحل المسير", "Run stages")}>
            {steps.map(([label, cap], i) => (
              <div key={label} className={i < stepIdx ? "is-done" : i === stepIdx ? "is-current" : undefined} aria-current={i === stepIdx ? "step" : undefined}>
                <span>{label}</span>
                <span className="hr-caption" style={{ fontWeight: 400 }}>{cap}</span>
              </div>
            ))}
          </div>
        )}

        <Metrics
          items={[
            // Compact (C-03): the stage replaces the process track and leads the strip.
            [L("المرحلة", "Stage"), stageLabel, "hr-only-compact"],
            [L("الموظفون", "People"), lines.length, "hr-hide-compact"],
            [L("استثناءات مفتوحة", "Open exceptions"), <span key="b" style={blockingCount ? { color: "var(--hr-danger)" } : undefined}>{blockingCount}</span>, "hr-hide-compact"],
            [L("تنبيهات", "Warnings"), <span key="w" style={warningCount ? { color: "var(--hr-warning)" } : undefined}>{warningCount}</span>, "hr-hide-compact"],
            [L("الإجمالي", "Gross"), money(run.totals.gross)],
            [L("الاستقطاعات", "Deductions"), money(run.totals.deductions)],
            [L("الصافي المستحق", "Net payable"), withheld.length ? <span key="np">{money(Number(run.totals.net) - withheldNet)}<span className="hr-caption" style={{ display: "block" }}>{L(`دون ${withheld.length} بند محجوب`, `excluding ${withheld.length} blocked line(s)`)}</span></span> : money(run.totals.net)],
            ...(st === "APPROVED" || st === "PAID" ? ([[L("المدفوع / المتبقي", "Paid / remaining"), `${money(run.totals.paid)} / ${money(run.totals.unpaid)}`]] as [string, ReactNode][]) : []),
          ]}
        />

        <Notice tone="info" plainOnMobile>
          {L("أعدّه", "Prepared by")} {run.preparedByName ?? "—"}. {L("لا يعتمد أحد مسيرًا أعدّه ولا بندًا يخصّه؛ يبقى بند المعتمد نفسه بانتظار معتمد مستقل. لا يكتمل الاعتماد ولا يُرحَّل القيد قبل اعتماد كل البنود.", "Nobody approves a run they prepared or a line that is theirs; the approver’s own line waits for an independent approver. Approval is not complete, and no entry is posted, until every line is approved.")}
        </Notice>
        {run.policy.isProposal ? (
          <Notice tone="warning">
            {L(`قيم سياسة v${run.policy.version} (أساس الأيام ${run.policy.dayBasis} ونسب الإضافي والاشتراكات) مقترحة ولم يؤكدها المالك أو المحاسب، فلا يُرسل هذا المسير للاعتماد ولا يُعتمد بموجبها.`, `The values of policy v${run.policy.version} (day basis ${run.policy.dayBasis}, overtime and contribution rates) are proposed and not confirmed by the owner or the accountant, so this run cannot be submitted or approved under them.`)}
          </Notice>
        ) : null}
        {/* P-3: whoever created, rebuilt, adjusted or submitted the run — not only its creator. */}
        {run.approveBlock ? (
          <Notice tone="warning">{L("لا يمكنك اعتماد مسيّر رواتب أعددته بنفسك. يعتمده معتمد آخر.", "You cannot approve a payroll run you prepared. Another approver must.")}</Notice>
        ) : null}
        {run.reconciliation && !run.reconciliation.ok ? (
          <div data-testid="hr-payroll-reconciliation">
            <Notice tone="danger">
              {L(`أرقام المسيّر غير متطابقة بالهللة (${run.reconciliation.mismatches.length} فرق)، فلا يُرسل ولا يُعتمد. لم يُغيَّر أي مبلغ.`, `The run's figures do not reconcile to the halala (${run.reconciliation.mismatches.length} differences), so it cannot be submitted or approved. No amount was changed.`)}
              {" "}{L("أولها:", "The first:")} {run.reconciliation.mismatches[0].label ? <span className="hr-id">{run.reconciliation.mismatches[0].label}</span> : null} <span dir="ltr" className="hr-num">{run.reconciliation.mismatches[0].check}</span> · {L("المتوقع", "expected")} <span className="hr-num">{run.reconciliation.mismatches[0].expected}</span> {L("والموجود", "and found")} <span className="hr-num">{run.reconciliation.mismatches[0].actual}</span>.
            </Notice>
          </div>
        ) : null}
        {st === "DRAFT" && escalations.length ? (
          <div data-testid="hr-payroll-escalations">
            <Notice tone="warning">
              {L("سلف تأجّل قسطها مرات متتالية وبلغت حد التصعيد؛ يقرّ المُعِدّ بها عند الإرسال ويراها المعتمد:", "Advances whose instalments were deferred consecutively up to the escalation limit; the preparer acknowledges them on submitting and the approver sees them:")}{" "}
              {escalations.map((e) => <span key={e.reviewItemId} className="hr-id">{e.advanceNo} ({e.deferralCount}) </span>)}
              <label style={{ display: "block", marginTop: 6 }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {L("أقرّ بالاطلاع على هذه السلف المصعّدة", "I acknowledge these escalated advances")}
              </label>
            </Notice>
          </div>
        ) : null}
        {st === "REVIEW" && escalations.length ? <Notice tone="warning">{L("سلف مصعّدة لتأجيل متتالٍ أقرّ بها المُعِدّ:", "Escalated advances (consecutive deferral) acknowledged by the preparer:")} {escalations.map((e) => <span key={e.reviewItemId} className="hr-id">{e.advanceNo} ({e.deferralCount}) </span>)}</Notice> : null}
        {run.payBlock ? <Notice tone="warning">{L(...(PAY_BLOCK[run.payBlock] ?? PAY_BLOCK.SOD_PREPARER))}</Notice> : null}
        {st === "APPROVED" && run.payments.length && run.proof && !run.proof.complete ? (
          <div data-testid="hr-payroll-proof">
            <Notice tone="warning">
              {L(`سُجّل صرف ${money(run.totals.paid)}، لكن ${run.proof.unsettledLines} من البنود بلا إثبات كامل من البنك${Number(run.proof.unallocated) ? ` و${money(run.proof.unallocated)} من الدفعات لم تُوزَّع على الموظفين` : ""}. لا يصبح المسير «مصروفًا» حتى يثبت البنك أن كل موظف استلم صافيه؛ إرسال ملف البنك ليس إثباتًا.`, `${money(run.totals.paid)} is recorded as paid, but ${run.proof.unsettledLines} line(s) have no complete bank proof${Number(run.proof.unallocated) ? ` and ${money(run.proof.unallocated)} of the payments is not allocated to employees` : ""}. The run is Paid only once the bank proves each employee received their net; sending a bank file is not proof.`)}
            </Notice>
          </div>
        ) : null}
        {run.cancelBlock ? <Notice tone="warning">{L(...(CANCEL_BLOCK[run.cancelBlock] ?? CANCEL_BLOCK.SOD_PREPARER))}</Notice> : null}

        {lines.length === 0 ? (
          <Empty title={L("لا بنود في هذا المسير", "No lines in this run")} body={run.kind === "CORRECTION" ? L("مسير التصحيح يضم من أُضيفت لهم تسوية فقط. أضف تسوية من زر «تسوية».", "A correction run includes only people with an adjustment. Add one with the Adjustment button.") : L("لا موظف على رأس العمل في هذا الشهر ضمن النطاق.", "No active employee in this month within the scope.")} />
        ) : (
          <div className="hr-tablewrap">
            {/* Phone (M-03 R3): the list's head — the column header row is hidden on phones. */}
            <div className="hr-mlisthead" aria-hidden="true"><span className="hr-caption">{L("البنود", "Lines")} · <span className="hr-num">{lines.length}</span></span><span className="hr-caption">{L("الأيام: المستحق من أساس الشهر", "Days: payable on the month basis")}</span></div>
            <table className="hr-table is-mrow is-dense-compact hr-run-lines" aria-label={L("بنود المسير", "Run lines")}>
              <thead>
                <tr>
                  <th>{L("الموظف", "Employee")}</th>
                  <th className="num">{L("الأيام", "Days")}</th>
                  <th className="num hr-hide-compact">{L("الأساسي", "Basic")}</th>
                  <th className="num hr-only-compact">{L("الإجمالي", "Gross")}</th>
                  <th className="num hr-hide-compact">{L("البدلات", "Allowances")}</th>
                  <th className="num hr-hide-compact">{L("إضافي معتمد", "Approved overtime")}</th>
                  <th className="num hr-hide-compact">{L("عمولة معتمدة", "Approved commission")}</th>
                  <th className="num">{L("الاستقطاعات", "Deductions")}</th>
                  <th className="num">{L("الصافي", "Net")}</th>
                  <th>{st === "APPROVED" || st === "PAID" ? L("الصرف", "Payment") : L("الاعتماد", "Approval")}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="is-clickable" aria-selected={selected === l.id} tabIndex={0} onClick={() => setSelected(l.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected(l.id))}>
                    <td data-label={L("الموظف", "Employee")} className="strong m-title">{l.employee.fullNameAr}<span className="sub hr-id hr-hide-mobile">{l.employee.employeeNo}</span><span className="hr-msub"><span className="hr-id">{l.employee.employeeNo}</span> · <DaysText l={l} run={run} /> · <LineState l={l} status={st} /></span></td>
                    <td data-label={L("الأيام", "Days")} className="num"><DaysCell l={l} run={run} /></td>
                    <td data-label={L("الأساسي", "Basic")} className="num hr-hide-compact">{money(sumCodes(l.items, ["BASIC"]))}</td>
                    <td data-label={L("الإجمالي", "Gross")} className="num hr-only-compact">{money(l.gross)}</td>
                    <td data-label={L("البدلات", "Allowances")} className="num hr-hide-compact">{money(sumCodes(l.items, ALLOWANCE_CODES))}</td>
                    <td data-label={L("إضافي معتمد", "Approved overtime")} className="num hr-hide-compact">{dash(sumCodes(l.items, ["OVERTIME"]))}</td>
                    <td data-label={L("عمولة معتمدة", "Approved commission")} className="num hr-hide-compact">{dash(sumCodes(l.items, ["COMMISSION"]))}</td>
                    <td data-label={L("الاستقطاعات", "Deductions")} className="num">{money(l.deductions)}</td>
                    <td data-label={L("الصافي", "Net")} className="num hr-net m-end is-stack">{fullUnpaid(l.dayDetail) ? <span title={L("الفترة كلها إجازة بدون راتب: لا مستحق", "The whole period is unpaid leave: nothing is payable")}>{L("محجوب", "Blocked")}</span> : money(l.net)}<span className="hr-msub hr-net-cap">{L("الصافي", "Net")}</span></td>
                    <td data-label={st === "APPROVED" || st === "PAID" ? L("الصرف", "Payment") : L("الاعتماد", "Approval")}><LineState l={l} status={st} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{L("الإجمالي", "Total")} · {lines.length}</td>
                  <td className="num" />
                  <td className="num hr-hide-compact">{money(col(["BASIC"]))}</td>
                  <td className="num hr-only-compact">{money(run.totals.gross)}</td>
                  <td className="num hr-hide-compact">{money(col(ALLOWANCE_CODES))}</td>
                  <td className="num hr-hide-compact">{money(col(["OVERTIME"]))}</td>
                  <td className="num hr-hide-compact">{money(col(["COMMISSION"]))}</td>
                  <td className="num">{money(run.totals.deductions)}</td>
                  <td className="num">{money(run.totals.net)}</td>
                  <td className="hr-caption">{approvedCount}/{lines.length} {L("معتمد", "approved")}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="hr-cols-2">
          <section className="hr-stack" aria-label={L("الاستثناءات", "Exceptions")}>
            <h2 className="hr-section">{L("الاستثناءات", "Exceptions")} <span className="hr-caption hr-num">{allExceptions.length}</span></h2>
            {allExceptions.length ? (
              <ul className="hr-stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 8 }}>
                {allExceptions.map((e, i) => (
                  <li key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <Flag tone={e.severity === "BLOCKING" ? "danger" : e.severity === "WARNING" ? "warning" : "info"}>{e.severity === "BLOCKING" ? L("مانع", "Blocking") : e.severity === "WARNING" ? L("تنبيه", "Warning") : L("للعلم", "Info")}</Flag>
                    <button type="button" className="hr-btn is-ghost is-sm" onClick={() => setSelected(e.line.id)}>{e.line.employee.fullNameAr}</button>
                    <span className="hr-body-s" dir="auto">{hrText(e.message, lang)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hr-caption" style={{ margin: 0 }}>{L("لا استثناءات.", "No exceptions.")}</p>
            )}
            {blockingCount ? <p className="hr-caption" style={{ margin: 0 }}>{L("الاستثناء المانع يمنع الإرسال للاعتماد. عالج سببه (راتب غير مسجل، فئة اشتراك ناقصة، صافٍ سالب…) ثم أعد الاحتساب.", "A blocking exception prevents submitting for approval. Fix its cause (no pay recorded, missing contribution group, negative net…) and rebuild.")}</p> : null}
          </section>
          <section className="hr-stack" aria-label={L("القيد المحاسبي", "Accounting entry")}>
            <h2 className="hr-section">{!run.journals.length && run.journalPreview ? L("القيد عند اكتمال الاعتماد (معاينة)", "Entry on full approval (preview)") : L("القيد المحاسبي", "Accounting entry")}</h2>
            {run.journals.length ? (
              <KV rows={run.journals.map((j) => [
                <span key="p">{JOURNAL_PURPOSE(j.purpose, lang)} <span className="hr-id">{String(j.entryNo)}</span></span>,
                <span key="v"><span className="hr-num">{money(j.amount)}</span> <span className="hr-caption">· <span className="hr-num">{j.date}</span> · {label(JOURNAL_STATUS, j.status, lang)}</span></span>,
              ])} />
            ) : run.accountingSkipped ? (
              <p className="hr-caption" style={{ margin: 0 }}>{L("المحاسبة غير مفعّلة أو غير مربوطة لهذا المسير، فلم يُرحَّل قيد. يُسجَّل المسير في الموارد البشرية فقط.", "Accounting is not enabled or not mapped for this run, so no entry was posted. The run is recorded in HR only.")}</p>
            ) : run.journalPreview ? (
              <>
                <table className="hr-table" aria-label={L("معاينة قيد الاستحقاق", "Accrual entry preview")}>
                  <thead><tr><th>{L("الحساب (من ربط الحسابات)", "Account (from account mapping)")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th></tr></thead>
                  <tbody>
                    {run.journalPreview.lines.map((j) => (
                      <tr key={j.key + j.side}>
                        <td>{j.account ? (lang === "en" ? j.account.nameEn || j.account.nameAr : j.account.nameAr || j.account.nameEn) : <span className="hr-muted">{j.key} · {L("غير مربوط", "not mapped")}</span>}</td>
                        <td className="num">{j.side === "D" ? money(j.amount) : ""}</td>
                        <td className="num">{j.side === "C" ? money(j.amount) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="hr-caption" style={{ margin: 0 }}>
                  {L("مدين", "Debit")} <span className="hr-num">{money(run.journalPreview.debit)}</span> = {L("دائن", "credit")} <span className="hr-num">{money(run.journalPreview.credit)}</span> · {L("معاينة فقط: يُرحَّل قيد الاستحقاق تلقائيًا عند اعتماد آخر بند، وقيد الصرف عند تسجيل كل دفعة.", "preview only: the accrual entry posts automatically when the last line is approved, and a payment entry with each recorded payment.")}
                </p>
              </>
            ) : (
              <p className="hr-caption" style={{ margin: 0 }}>{L("لم يُرحَّل قيد بعد. يُرحَّل قيد الاستحقاق تلقائيًا عند اعتماد آخر بند، وقيد الصرف عند تسجيل كل دفعة.", "No entry posted yet. The accrual entry posts automatically when the last line is approved, and a payment entry with each recorded payment.")}</p>
            )}
            {st === "APPROVED" && run.canCancelApproved ? <p className="hr-caption" style={{ margin: 0 }}>{L("إلغاء مسير معتمد قبل تسجيل أي صرف يرحّل قيدًا عكسيًا بتاريخ اليوم ويعيد الأقساط المحجوزة مجدولة.", "Cancelling an approved run before any payment posts a reversing entry dated today and returns reserved instalments to scheduled.")}</p> : null}
          </section>
        </div>

        {run.payments.length ? (
          <section className="hr-stack" aria-label={L("الدفعات المسجلة", "Recorded payments")}>
            <h2 className="hr-section">{L("الدفعات المسجلة", "Recorded payments")}</h2>
            <div className="hr-tablewrap">
              <table className="hr-table is-stack is-dense">
                <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("الطريقة", "Method")}</th><th>{L("المرجع", "Reference")}</th><th className="num">{L("إثبات للموظفين", "Proved per employee")}</th><th className="num">{L("المبلغ", "Amount")}</th></tr></thead>
                <tbody>
                  {run.payments.map((p) => (
                    <tr key={p.id}>
                      <td data-label={L("التاريخ", "Date")} className="hr-num">{p.paidOn}</td>
                      <td data-label={L("الطريقة", "Method")}>{label(METHOD_LABEL, p.method, lang)}{p.lineId ? <span className="sub hr-caption">{L("لموظف واحد", "one employee")}</span> : null}</td>
                      <td data-label={L("المرجع", "Reference")}><span className="hr-id">{p.reference}</span></td>
                      <td data-label={L("إثبات للموظفين", "Proved per employee")} className="num">{money(p.allocated ?? "0")}{Number(p.unallocated ?? 0) ? <span className="sub hr-caption" style={{ color: "var(--hr-warning)" }}>{L("بلا إثبات", "unproved")} {money(p.unallocated ?? "0")}</span> : null}</td>
                      <td data-label={L("المبلغ", "Amount")} className="num">{money(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={4}>{L("المدفوع (بعد المرتجعات) · المتبقي", "Paid (net of returns) · remaining")} {money(run.totals.unpaid)}{run.returns?.length ? <> · {L("مرتجع", "returned")} <span className="hr-num">{money(run.proof?.returned ?? "0")}</span></> : null}</td><td className="num">{money(run.totals.paid)}</td></tr></tfoot>
              </table>
            </div>
          </section>
        ) : null}
      </div>

      {sel ? (
        <>
          <div className="hr-scrim" onClick={() => setSelected(null)} />
          <LinePreview
            l={sel}
            run={run}
            credits={run.payments.flatMap((p) => (p.allocations ?? []).filter((x) => x.lineId === sel.id)).map((x) => ({ ...x, returned: !!run.returns?.some((r) => r.allocationId === x.id) }))}
            onReturn={run.canProve ? (allocationId) => { setReturnOf(allocationId); setDialog("bankReturn"); } : null}
            status={st}
            onClose={() => setSelected(null)}
            canApproveLine={st === "REVIEW" && run.canApprove && !sel.approvedBy && !sel.isMine}
            busy={a.busy === `approve:${sel.id}`}
            onApprove={() => approveLine(sel.id)}
          />
        </>
      ) : null}

      {dialog === "adjust" ? <AdjustDialog runUrl={url} lines={lines} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setFlash(L("أُضيفت التسوية وأُعيد احتساب المسير.", "Adjustment added and the run rebuilt.")); void reload(); }} /> : null}
      {dialog === "return" ? (
        <ReasonDialog title={L("إرجاع المسير للمراجعة", "Return the run for review")} min={3} busy={a.busy === "return"} error={a.error} confirm={L("إرجاع", "Return")} onClose={() => { setDialog(null); a.setError(null); }}
          note={L("يعود المسير مسودة وتُمسح اعتمادات البنود، ليُعاد احتسابه أو تسويته.", "The run returns to draft and line approvals are cleared, so it can be rebuilt or adjusted.")}
          onSubmit={(reason) => done(post("return", { reason }), "return", () => L("أُرجع المسير مسودة.", "The run was returned to draft."))} />
      ) : null}
      {dialog === "cancel" ? (
        <ReasonDialog title={L("إلغاء المسير", "Cancel run")} min={5} danger busy={a.busy === "cancel"} error={a.error} confirm={L("إلغاء المسير", "Cancel run")} onClose={() => { setDialog(null); a.setError(null); }}
          note={st === "APPROVED"
            ? L("المسير معتمد وقد رُحّل قيد استحقاقه: الإلغاء يرحّل قيدًا عكسيًا بتاريخ اليوم، ويعيد أقساط السلف المحجوزة مجدولة ويحرر الإضافي والعمولات. لا يُلغى مسير سُجّل عليه صرف.", "The run is approved and its accrual entry posted: cancelling posts a reversing entry dated today, returns reserved advance instalments to scheduled and releases overtime and commissions. A run with a recorded payment cannot be cancelled.")
            : L("يحرر الإلغاء أقساط السلف والإضافي والعمولات التي حجزها المسير. لا يمكن التراجع عن الإلغاء.", "Cancelling releases the advance instalments, overtime and commissions the run reserved. It cannot be undone.")}
          onSubmit={(reason) => done(post("cancel", { reason }), "cancel", () => L("أُلغي المسير.", "The run was cancelled."))} />
      ) : null}
      {dialog === "pay" ? <PayDialog run={run} busy={a.busy === "pay"} error={a.error} onClose={() => { setDialog(null); a.setError(null); }} onSubmit={(body) => done(post("payments", body), "pay", (r) => ((r as { completed?: boolean }).completed ? L("سُجّل الصرف واكتمل: المسير مصروف، وسُددت أقساط السلف المحجوزة.", "Payment recorded and complete: the run is paid, and reserved advance instalments are repaid.") : L("سُجّلت الدفعة. يصبح المسير «مصروفًا» عندما يثبت البنك صرف صافي كل موظف.", "Payment recorded. The run becomes Paid once the bank proves each employee's net was credited.")))} /> : null}
      {dialog === "proof" ? <ProofDialog run={run} busy={a.busy === "proof"} error={a.error} onClose={() => { setDialog(null); a.setError(null); }} onSubmit={(path, body) => done(post(path, body), "proof", (r) => ((r as { completed?: boolean }).completed ? L("سُجّل الإثبات واكتمل: كل موظف استلم صافيه، والمسير مصروف.", "Proof recorded and complete: every employee received their net; the run is paid.") : L("سُجّل الإثبات.", "Proof recorded.")))} /> : null}
      {dialog === "bankReturn" && returnOf ? <BankReturnDialog allocationId={returnOf} busy={a.busy === "bankReturn"} error={a.error} onClose={() => { setDialog(null); setReturnOf(null); a.setError(null); }} onSubmit={(body) => done(post("payments/returns", body), "bankReturn", () => L("سُجّل المبلغ المرتجع وأُعيد فتح بند الموظف.", "The returned credit is recorded and the employee's line is reopened."))} /> : null}
    </div>
  );
}

function LineState({ l, status }: { l: RunLine; status: string }) {
  const { L } = useHrI18n();
  // P-2 rev3 item 2: once approved, what the bank proved for the line.
  if ((status === "APPROVED" || status === "PAID") && l.settlement) return <StatusDot map={SETTLEMENT_STATUS} value={l.settlement.status} />;
  if (l.approvedBy) return <StatusDot map={{ A: ["معتمد", "success", "Approved"] }} value="A" />;
  if (l.blocking) return <Flag tone="danger">{L("استثناء مانع", "Blocking exception")}</Flag>;
  if (status !== "REVIEW") return <span className="hr-caption">—</span>;
  if (l.isMine) return <Flag tone="warning">{L("لمعتمد مستقل", "Needs independent approver")}</Flag>;
  return <StatusDot map={{ P: ["بانتظار", "warning", "Pending"] }} value="P" />;
}

type Credit = { id: string; amount: string; bankReference: string; payeeAccountLast4: string | null; confirmedOn: string; returned: boolean };
function LinePreview({ l, run, credits, onReturn, status, onClose, canApproveLine, busy, onApprove }: { l: RunLine; run: Period; credits: Credit[]; onReturn: ((allocationId: string) => void) | null; status: string; onClose: () => void; canApproveLine: boolean; busy: boolean; onApprove: () => void }) {
  const group = (kind: "EARNING" | "DEDUCTION" | "EMPLOYER") => l.items.filter((i) => i.kind === kind);
  const { L, lang } = useHrI18n();
  const block = (title: string, kind: "EARNING" | "DEDUCTION" | "EMPLOYER", total: string | number) => {
    const rows = group(kind);
    if (!rows.length) return null;
    return (
      <div className="hr-stack" style={{ gap: 4 }}>
        <span className="hr-label">{title}</span>
        <KV rows={[
          ...rows.map((i) => [
            <span key="k">{itemLabel(i.code, lang)}{itemNote(i, lang) ? <span className="hr-caption" style={{ display: "block" }}>{itemNote(i, lang)}</span> : null}</span>,
            <span key="v" className="hr-num">{money(i.amount)}</span>,
          ] as [ReactNode, ReactNode]),
          [<strong key="t">{L("المجموع", "Total")}</strong>, <strong key="tv" className="hr-num is-medium">{money(total)}</strong>],
        ]} />
      </div>
    );
  };
  const ex = excs(l);
  return (
    <aside className="hr-preview" aria-label={L("تفاصيل البند", "Line details")}>
      <div className="hr-preview-head">
        <span className="hr-id">{l.employee.employeeNo}</span>
        <Btn variant="ghost" size="sm" aria-label={L("إغلاق المعاينة", "Close preview")} onClick={onClose}>✕</Btn>
      </div>
      <div className="hr-preview-body">
        <div>
          <h2 className="hr-mobile-title">{l.employee.fullNameAr}</h2>
          <div className="hr-caption">{L("الأيام المستحقة", "Payable days")} <DaysText l={l} run={run} plain /></div>
        </div>
        {l.dayDetail ? (
          // P-2 rev3 item 6: one unit per row — calendar days, or pay units of the month basis.
          <KV rows={dayRows(l.dayDetail, lang).map(([k, v, tone]) => [k, <DayValue key={k} v={v} />, tone] as [string, ReactNode, "warning" | undefined])} />
        ) : null}
        <div className="hr-meta"><LineState l={l} status={status} />{l.approvedByName ? <span className="hr-caption">{L("اعتمده", "Approved by")} {l.approvedByName}</span> : null}</div>
        {block(L("المستحقات", "Earnings"), "EARNING", l.gross)}
        {block(L("الاستقطاعات", "Deductions"), "DEDUCTION", l.deductions)}
        <KV rows={[[<strong key="n">{L("الصافي", "Net")}</strong>, fullUnpaid(l.dayDetail) ? <strong key="nv">{L("محجوب — لا مستحق", "Blocked — nothing payable")}</strong> : <strong key="nv" className="hr-num is-medium">{money(l.net)}</strong>]]} />
        {l.settlement ? (
          <div className="hr-stack" style={{ gap: 4 }} data-testid="hr-line-proof">
            <span className="hr-label">{L("إثبات الصرف", "Payment proof")} <StatusDot map={SETTLEMENT_STATUS} value={l.settlement.status} /></span>
            <KV rows={[
              ...credits.map((c) => [
                <span key="r"><span className="hr-id">{c.bankReference}</span>{c.payeeAccountLast4 ? <span className="hr-caption"> · ****{c.payeeAccountLast4}</span> : null} <span className="hr-caption">· <span className="hr-num">{c.confirmedOn}</span></span>{c.returned ? <> <Flag tone="danger">{L("مرتجع", "Returned")}</Flag></> : null}</span>,
                <span key="v"><span className="hr-num">{money(c.amount)}</span>{onReturn && !c.returned ? <> <Btn size="sm" variant="ghost" onClick={() => onReturn(c.id)}>{L("تسجيل إرجاع", "Record return")}</Btn></> : null}</span>,
              ] as [ReactNode, ReactNode]),
              [L("المتبقي للموظف", "Still owed to the employee"), <strong key="o" className="hr-num is-medium">{money(l.settlement.outstanding)}</strong>],
            ]} />
          </div>
        ) : null}
        {block(L("على صاحب العمل (لا تُخصم من الموظف)", "Employer cost (not deducted from the employee)"), "EMPLOYER", l.employer)}
        {ex.length ? (
          <div className="hr-stack" style={{ gap: 6 }}>
            <span className="hr-label">{L("الاستثناءات", "Exceptions")}</span>
            {ex.map((e, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <Flag tone={e.severity === "BLOCKING" ? "danger" : e.severity === "WARNING" ? "warning" : "info"}>{e.severity === "BLOCKING" ? L("مانع", "Blocking") : e.severity === "WARNING" ? L("تنبيه", "Warning") : L("للعلم", "Info")}</Flag>
                <span className="hr-body-s" dir="auto">{hrText(e.message, lang)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {l.isMine && !l.approvedBy ? <Notice tone="warning">{L("هذا البند يخصّك؛ يعتمده معتمد مستقل.", "This line is yours; an independent approver approves it.")}</Notice> : null}
      </div>
      <div className="hr-preview-foot">
        {canApproveLine ? <Btn variant="primary" busy={busy} onClick={onApprove}>{L("اعتماد هذا البند", "Approve this line")}</Btn> : null}
        <Link className="hr-btn" href={`/dashboard/hr/payroll/payslips/${l.id}`}>{L("قسيمة الراتب", "Payslip")}</Link>
      </div>
    </aside>
  );
}

function ReasonDialog({ title, note, min, confirm, danger, busy, error, onClose, onSubmit }: {
  title: string; note: string; min: number; confirm: string; danger?: boolean; busy: boolean; error: string | null; onClose: () => void; onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= min;
  const { L } = useHrI18n();
  return (
    <Dialog open title={title} onClose={onClose} actions={<><Btn variant={danger ? "danger" : "primary"} busy={busy} disabled={!ok} onClick={() => onSubmit(reason.trim())}>{confirm}</Btn><Btn onClick={onClose}>{L("تراجع", "Discard")}</Btn></>}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <p className="hr-body-s" style={{ margin: 0 }}>{note}</p>
      <Field label={L("السبب *", "Reason *")} help={L(`${min} أحرف على الأقل. يُسجَّل في سجل التدقيق.`, `At least ${min} characters. Recorded in the audit log.`)}>
        <textarea className="hr-textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/**
 * P-2 review P2-A2: one idempotency key per opening of the dialog, so a double click or a retried
 * request records ONE payment (the server requires the key). getRandomValues works outside secure
 * contexts too, unlike randomUUID.
 */
function newPaymentKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `pay-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function PayDialog({ run, busy, error, onClose, onSubmit }: { run: RunDetail; busy: boolean; error: string | null; onClose: () => void; onSubmit: (b: Record<string, string>) => void }) {
  const f = useForm({ amount: run.totals.unpaid, paidOn: todayIso(), method: "BANK_TRANSFER", reference: "", lineId: "" });
  const [idempotencyKey] = useState(newPaymentKey);
  const ok = Number(f.v.amount) > 0 && !!f.v.paidOn && f.v.reference.trim().length > 0;
  const { L, lang } = useHrI18n();
  return (
    <Dialog open title={L("تسجيل الصرف", "Record payment")} onClose={onClose} actions={<><Btn variant="primary" busy={busy} disabled={!ok} onClick={() => onSubmit({ ...f.v, reference: f.v.reference.trim(), idempotencyKey })}>{L("تسجيل", "Record")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Notice tone="info">{L(`يُسجّل النظام الدفعة ومرجعها ويرحّل قيدها، ولا يحوّل أموالًا. يصبح المسير «مصروفًا» عندما تساوي الدفعات الصافي (${money(run.totals.net)})، وعندها فقط تُسدَّد أقساط السلف المحجوزة.`, `The system records the payment and its reference and posts its entry; it does not transfer money. The run becomes Paid when payments equal the net (${money(run.totals.net)}), and only then are reserved advance instalments repaid.`)}</Notice>
      <div className="hr-form">
        <Field label={L("المبلغ *", "Amount *")} help={L(`المتبقي ${money(run.totals.unpaid)}`, `Remaining ${money(run.totals.unpaid)}`)}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("amount")} /></Field>
        <Field label={L("تاريخ الصرف *", "Payment date *")}><input className="hr-input" type="date" {...f.bind("paidOn")} /></Field>
        <Field label={L("الطريقة", "Method")}>
          <Select className="hr-select" {...f.bind("method")}>
            {Object.keys(METHOD_LABEL).map((k) => <option key={k} value={k}>{label(METHOD_LABEL, k, lang)}</option>)}
          </Select>
        </Field>
        <Field label={L("المرجع *", "Reference *")} help={L("رقم الحوالة أو الشيك أو السند", "Transfer, cheque or voucher number")}><input className="hr-input" dir="ltr" {...f.bind("reference")} /></Field>
        <Field label={L("لموظف واحد (اختياري)", "For one employee (optional)")} help={L("دفعة لبند موظف واحد إثباتها مرجعها. الدفعة المجمّعة تحتاج إثبات البنك لكل موظف.", "A payment to one employee's line is proved by its reference. A bulk payment needs the bank's proof per employee.")}>
          <Select className="hr-select" {...f.bind("lineId")}>
            <option value="">{L("دفعة مجمّعة", "Bulk payment")}</option>
            {run.lines.filter((l) => l.settlement && Number(l.settlement.outstanding) > 0).map((l) => <option key={l.id} value={l.id}>{l.employee.employeeNo} · {l.employee.fullNameAr} · {money(l.settlement!.outstanding)}</option>)}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * P-2 rev3 item 2: the bank's per-employee proof of a recorded payment — its RESULT file (never the
 * file this system exported), or the per-employee credits typed from the bank statement.
 */
function ProofDialog({ run, busy, error, onClose, onSubmit }: { run: RunDetail; busy: boolean; error: string | null; onClose: () => void; onSubmit: (path: string, b: Record<string, unknown>) => void }) {
  const { L } = useHrI18n();
  const open = run.payments.filter((p) => Number(p.unallocated ?? 0) > 0);
  const [paymentId, setPaymentId] = useState(open[0]?.id ?? "");
  const [mode, setMode] = useState<"file" | "hand">("file");
  const [valueDate, setValueDate] = useState(todayIso());
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [rows, setRows] = useState<Record<string, { amount: string; ref: string }>>({});
  const [idempotencyKey] = useState(newPaymentKey);
  const due = run.lines.filter((l) => l.settlement && Number(l.settlement.outstanding) > 0);
  const hand = Object.entries(rows).filter(([, r]) => Number(r.amount) > 0 && r.ref.trim().length >= 3).map(([lineId, r]) => ({ lineId, amount: r.amount, bankReference: r.ref.trim() }));
  const ok = !!paymentId && !!valueDate && (mode === "file" ? !!file : hand.length > 0);
  const submit = () => (mode === "file"
    ? onSubmit("payments/bank-results", { paymentId, valueDate, fileName: file!.name, csv: file!.text })
    : onSubmit("payments/allocations", { paymentId, confirmedOn: valueDate, idempotencyKey, allocations: hand }));
  return (
    <Dialog open title={L("إثبات الصرف لكل موظف", "Proof of payment per employee")} onClose={onClose} actions={<><Btn variant="primary" busy={busy} disabled={!ok} onClick={submit}>{L("تسجيل الإثبات", "Record proof")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Notice tone="info">{L("يُقبل ملف نتائج البنك أو مراجع البنك لكل موظف فقط، لا الملف الذي صدّره النظام. يجب أن يطابق كل سطر بند الموظف وصافيه المتبقي، وإلا لا يُسجَّل شيء.", "Only the bank's result file, or the bank's reference per employee, is accepted — never the file this system exported. Every row must match the employee's line and remaining net, or nothing is recorded.")}</Notice>
      <div className="hr-form">
        <Field label={L("الدفعة *", "Payment *")}>
          <Select className="hr-select" value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
            {open.map((p) => <option key={p.id} value={p.id}>{p.reference} · {p.paidOn} · {L("بلا إثبات", "unproved")} {money(p.unallocated ?? "0")}</option>)}
          </Select>
        </Field>
        <Field label={L("تاريخ القيد في البنك *", "Bank value date *")}><input className="hr-input" type="date" value={valueDate} onChange={(e) => setValueDate(e.target.value)} /></Field>
        <Field label={L("المصدر", "Source")}>
          <Select className="hr-select" value={mode} onChange={(e) => setMode(e.target.value as "file" | "hand")}>
            <option value="file">{L("ملف نتائج البنك (CSV)", "Bank result file (CSV)")}</option>
            <option value="hand">{L("إدخال مراجع البنك يدويًا", "Enter the bank's references by hand")}</option>
          </Select>
        </Field>
        {mode === "file" ? (
          <Field label={L("الملف *", "File *")} wide help={L("الأعمدة: employeeNo, amount, bankReference, status (PAID / REJECTED / RETURNED), originalReference, reason", "Columns: employeeNo, amount, bankReference, status (PAID / REJECTED / RETURNED), originalReference, reason")}>
            <input className="hr-input" type="file" accept=".csv,text/csv" onChange={async (e) => { const fl = e.target.files?.[0]; setFile(fl ? { name: fl.name, text: await fl.text() } : null); }} />
          </Field>
        ) : (
          <div className="hr-stack" style={{ gap: 6, gridColumn: "1 / -1" }}>
            {due.map((l) => (
              <div key={l.id} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ minWidth: 160 }}><span className="hr-id">{l.employee.employeeNo}</span> · {l.employee.fullNameAr} <span className="hr-caption">({money(l.settlement!.outstanding)})</span></span>
                <input className="hr-input hr-num" inputMode="decimal" aria-label={L("المبلغ", "Amount")} placeholder={L("المبلغ", "Amount")} style={{ maxWidth: 140 }} value={rows[l.id]?.amount ?? ""} onChange={(e) => setRows((s) => ({ ...s, [l.id]: { amount: e.target.value, ref: s[l.id]?.ref ?? "" } }))} />
                <input className="hr-input" dir="ltr" aria-label={L("مرجع البنك", "Bank reference")} placeholder={L("مرجع البنك", "Bank reference")} style={{ maxWidth: 200 }} value={rows[l.id]?.ref ?? ""} onChange={(e) => setRows((s) => ({ ...s, [l.id]: { amount: s[l.id]?.amount ?? "", ref: e.target.value } }))} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** P-2 rev3 item 2: a credit the bank returned — the employee's line reopens and is paid again. */
function BankReturnDialog({ allocationId, busy, error, onClose, onSubmit }: { allocationId: string; busy: boolean; error: string | null; onClose: () => void; onSubmit: (b: Record<string, string>) => void }) {
  const { L } = useHrI18n();
  const f = useForm({ bankReference: "", returnedOn: todayIso(), reason: "" });
  const [idempotencyKey] = useState(newPaymentKey);
  const ok = f.v.bankReference.trim().length >= 3 && !!f.v.returnedOn && f.v.reason.trim().length >= 3;
  return (
    <Dialog open title={L("تسجيل مبلغ مرتجع", "Record a returned credit")} onClose={onClose} actions={<><Btn variant="danger" busy={busy} disabled={!ok} onClick={() => onSubmit({ kind: "RETURNED", allocationId, ...f.v, bankReference: f.v.bankReference.trim(), idempotencyKey })}>{L("تسجيل الإرجاع", "Record return")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Notice tone="warning">{L("يعيد الإرجاع فتح بند الموظف ويرحّل قيدًا (مدين النقدية / دائن الرواتب المستحقة). إن كان المسير مصروفًا يعود «بانتظار الصرف» حتى يُصرف للموظف مجددًا.", "A return reopens the employee's line and posts an entry (Dr cash / Cr salaries payable). A paid run goes back to Awaiting payment until the employee is paid again.")}</Notice>
      <div className="hr-form">
        <Field label={L("مرجع الإرجاع في البنك *", "Bank reference of the return *")}><input className="hr-input" dir="ltr" {...f.bind("bankReference")} /></Field>
        <Field label={L("تاريخ الإرجاع *", "Returned on *")}><input className="hr-input" type="date" {...f.bind("returnedOn")} /></Field>
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" {...f.bind("reason")} /></Field>
      </div>
    </Dialog>
  );
}

function AdjustDialog({ runUrl, lines, onClose, onDone }: { runUrl: string; lines: RunLine[]; onClose: () => void; onDone: () => void }) {
  const { meta } = useHrMeta();
  const f = useForm({ employeeId: "", kind: "EARNING", category: "", amount: "", reason: "", documentReference: "", relatedPeriod: "" });
  const a = useAction();
  const { L, lang } = useHrI18n();
  // P-2 review P1-B2: a category from the closed list is required; end of service and leave
  // encashment are not on it (they are paid by the final settlement, never through payroll).
  const cats = ADJUSTMENT_CATEGORY[f.v.kind === "DEDUCTION" ? "DEDUCTION" : "EARNING"];
  const category = cats.some((c) => c[0] === f.v.category) ? f.v.category : "";
  const memoShort = category === "OTHER_WITH_MEMO" && f.v.reason.trim().length < 10;
  const inRun = new Set(lines.map((l) => l.employee.id));
  const people = [
    ...lines.map((l) => ({ id: l.employee.id, label: `${l.employee.fullNameAr} · ${l.employee.employeeNo}` })),
    ...(meta?.people ?? []).filter((p) => !inRun.has(p.id)).map((p) => ({ id: p.id, label: `${p.fullNameAr} · ${p.employeeNo}` })),
  ];
  // P-2 rev3 item 5: a prior-period due names its document and the earlier period it is owed for.
  const dues = category === "PRIOR_PERIOD_ARREARS" || category === "COMMISSION_TRUE_UP";
  const duesOk = !dues || (f.v.documentReference.trim().length >= 3 && /^\d{4}-(0[1-9]|1[0-2])$/.test(f.v.relatedPeriod));
  const ok = !!f.v.employeeId && !!category && Number(f.v.amount) > 0 && f.v.reason.trim().length >= 3 && !memoShort && duesOk;
  const submit = () => a.run("adjust", async () => {
    const { documentReference, relatedPeriod, ...rest } = f.v;
    await hrFetch(`${runUrl}/adjustments`, { json: { ...rest, category, reason: f.v.reason.trim(), ...(dues ? { documentReference: documentReference.trim(), relatedPeriod } : {}) } });
    onDone();
  });
  return (
    <Dialog open title={L("تسوية على المسير", "Run adjustment")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "adjust"} disabled={!ok} onClick={submit}>{L("إضافة وإعادة الاحتساب", "Add and rebuild")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الموظف *", "Employee *")} wide>
          <Select className="hr-select" {...f.bind("employeeId")}>
            <option value="">—</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </Field>
        <Field label={L("النوع", "Type")}>
          <Select className="hr-select" {...f.bind("kind")}>
            <option value="EARNING">{L("إضافة (مستحق)", "Addition (earning)")}</option>
            <option value="DEDUCTION">{L("خصم", "Deduction")}</option>
          </Select>
        </Field>
        <Field label={L("الفئة *", "Category *")} help={L("مكافأة نهاية الخدمة وبدل الإجازة ليست فئة راتب: تُصرف من التسوية النهائية.", "End of service and leave encashment are not salary categories: they are paid by the final settlement.")}>
          <Select className="hr-select" value={category} onChange={(e) => f.setV((s) => ({ ...s, category: e.target.value }))}>
            <option value="">—</option>
            {cats.map(([k, ar, en]) => <option key={k} value={k}>{lang === "en" ? en : ar}</option>)}
          </Select>
        </Field>
        <Field label={L("المبلغ *", "Amount *")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("amount")} /></Field>
        {dues ? (
          <>
            <Field label={L("مرجع المستند *", "Document reference *")} help={L("المستند الذي يثبت أن المبلغ مستحق عن فترة سابقة.", "The document showing the amount is owed for an earlier period.")}><input className="hr-input" dir="ltr" {...f.bind("documentReference")} /></Field>
            <Field label={L("الفترة المستحق عنها *", "Period it is owed for *")} help={L("شهر سابق لإنهاء الخدمة، مثل 2026-08. يحتاج إقرارًا مستقلًا لمن بدأ إنهاء خدمته.", "A month before the separation, e.g. 2026-08. Needs an independent attestation for a separating person.")}><input className="hr-input hr-num" type="month" {...f.bind("relatedPeriod")} /></Field>
          </>
        ) : null}
        <Field label={L("السبب *", "Reason *")} wide help={memoShort ? L("الفئة «أخرى» تحتاج مذكرة لا تقل عن 10 أحرف.", "“Other” needs a memo of at least 10 characters.") : L("يظهر في قسيمة الموظف ويُسجَّل في سجل التدقيق.", "Shown on the employee’s payslip and recorded in the audit log.")}><textarea className="hr-textarea" {...f.bind("reason")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("التسوية على مسودة فقط، ولا يضيف أحد تسوية على راتبه. يُعاد احتساب المسير كله بعد الإضافة.", "Adjustments are added to a draft only, and nobody adds one to their own pay. The whole run is rebuilt afterwards.")}</p>
    </Dialog>
  );
}

// ── Day counts (HR-03 / C-03 / M-03 R3) ───────────────────────────────────────────

type Period = Pick<RunDetail, "periodStart" | "periodEnd">;

/** «28 من 30» plus the note under it; at compact width the note uses its short wording. */
function DaysCell({ l, run }: { l: RunLine; run: Period }) {
  const { L, lang } = useHrI18n();
  const p = dayParts(l, { start: run.periodStart, end: run.periodEnd }, lang);
  return (
    <>
      <span className="hr-num">{p.main}</span>{p.basis !== null ? <> {L("من", "of")} <span className="hr-num">{p.basis}</span></> : null}
      {p.note ? (
        <span className={`sub hr-days-note${p.tone ? " tone-warning" : ""}`}>
          <span className="hr-hide-compact"><span className="hr-iso">{p.note}</span></span>
          <span className="hr-only-compact">{p.short}</span>
        </span>
      ) : null}
    </>
  );
}

/** One line of text: the phone row's sub-line and the line drawer. */
function DaysText({ l, run, plain }: { l: RunLine; run: Period; plain?: boolean }) {
  const { L, lang } = useHrI18n();
  const p = dayParts(l, { start: run.periodStart, end: run.periodEnd }, lang);
  return (
    <>
      <span className="hr-num">{p.main}</span>{p.basis !== null ? <> {L("من", "of")} <span className="hr-num">{p.basis}</span></> : null} {L("يومًا", "days")}
      {p.note && !plain ? <> · <span className={p.tone ? "hr-days-note tone-warning" : undefined}><span className="hr-iso">{p.note}</span></span></> : null}
    </>
  );
}
