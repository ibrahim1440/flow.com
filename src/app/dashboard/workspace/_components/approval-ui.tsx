"use client";
// «بانتظار اعتمادي» — the decision pane. It shows what the decision needs per type, then POSTs the
// decision to the DEPARTMENT's own endpoint (item.decide.url): HR, Sales, Finance or Marketing re-check
// the duty, the scope, the state, four eyes and — for a discount — the figures shown here, under their
// own lock, and run their own effects. A step-up (401 REAUTH_REQUIRED) is asked by the dashboard's
// StepUpProvider and the request retried once.
import Link from "next/link";
import { useState } from "react";
import { Btn, Field, Notice, OpsPane, useL } from "@/components/ops/ui";
import { HrApiError, money } from "@/components/hr/ui";
import { ago, dayOf, monthOf } from "@/lib/workspace/format";
import { TypeChip, approvalTitle, useLang, wsFetch, type ApprovalItem } from "./kit";

type Outcome = { kind: "ok" | "stale" | "decided" | "error"; text: string };

const n = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

function Facts({ item }: { item: ApprovalItem }) {
  const L = useL();
  const lang = useLang();
  const f = item.facts as Record<string, never>;
  const rows: [string, React.ReactNode][] = [];
  if (item.type === "LEAVE") {
    rows.push([L("الموظف", "Employee"), `${n(item.subject)} · ${n(f.employeeNo)}`]);
    rows.push([L("النوع", "Type"), `${n(f.leaveType)}${f.paid === false ? L(" (بدون راتب)", " (unpaid)") : ""}`]);
    rows.push([L("المدة", "Period"), `${dayOf(`${f.startDate}T09:00:00Z`, lang)} — ${dayOf(`${f.endDate}T09:00:00Z`, lang)} · ${Number(f.days)} ${L("يوم", "day(s)")}`]);
    if (f.tracksBalance) {
      rows.push([L("الرصيد المتاح", "Available"), `${n(f.available)} ${L("يوم", "days")}`]);
      rows.push([L("بعد الاعتماد", "After approval"), <span key="a" className={Number(f.after) < 0 ? "ws-due is-overdue" : undefined}>{n(f.after)} {L("يوم", "days")}</span>]);
    }
    if (f.reason) rows.push([L("السبب", "Reason"), n(f.reason)]);
  } else if (item.type === "ADVANCE") {
    rows.push([L("الموظف", "Employee"), `${n(item.subject)} · ${n(f.employeeNo)}`]);
    rows.push([L("المبلغ", "Amount"), <span key="m" className="hr-num">{money(f.amount)} {L("ر.س", "SAR")}</span>]);
    rows.push([L("خطة الاستقطاع", "Deduction plan"), L(`${f.installmentCount} أقساط × ${f.installment} ر.س ابتداءً من ${monthOf(String(f.firstInstallmentMonth), "ar")}`, `${f.installmentCount} × ${f.installment} SAR from ${monthOf(String(f.firstInstallmentMonth), "en")}`)]);
    if (f.reason) rows.push([L("السبب", "Reason"), n(f.reason)]);
  } else if (item.type === "DISCOUNT") {
    rows.push([L("العميل", "Customer"), n(f.customer)]);
    rows.push([L("الصفقة", "Deal"), `${n(f.deal)}${f.dealOwner ? ` · ${f.dealOwner}` : ""}`]);
    rows.push([L("عرض السعر", "Quotation"), `${n(f.quoteNumber)}${Number(f.revision) > 1 ? ` · ${L("مراجعة", "rev.")} ${f.revision}` : ""}`]);
    rows.push([L("الخصم المطلوب", "Requested discount"), <b key="d" className="hr-num">{n(f.discountPercent)}%</b>]);
    rows.push([L("الحد المسموح", "Allowed without approval"), <span key="t" className="hr-num">{n(f.thresholdPercent)}%</span>]);
    rows.push([L("قبل الخصم", "Before discount"), <span key="s" className="hr-num">{money(f.subtotal)} {n(f.currency)}</span>]);
    rows.push([L("قيمة الخصم", "Discount"), <span key="x" className="hr-num">{money(f.discountTotal)} {n(f.currency)}</span>]);
    rows.push([L("الإجمالي مع الضريبة", "Total incl. VAT"), <b key="g" className="hr-num">{money(f.grandTotal)} {n(f.currency)}</b>]);
  } else if (item.type === "SAMPLE") {
    // A customer's second sample of a coffee product («للعميل من كل محصول عيّنة واحدة»).
    rows.push([L("العميل", "Customer"), n(f.customer)]);
    rows.push([L("الصفقة", "Deal"), `${n(f.deal)}${f.dealOwner ? ` · ${f.dealOwner}` : ""}`]);
    rows.push([L("المحصول", "Product"), <span key="p"><bdi>{n(f.product)}</bdi> · <span className="hr-num">{n(f.units)}</span> {L("عبوة", "unit")}</span>]);
  } else {
    if (item.subject) rows.push([L("الموضوع", "Subject"), n(item.subject)]);
    if (f.action) rows.push([L("الإجراء", "Action"), n(f.action)]);
    if (f.note) rows.push([L("ملاحظة الطلب", "Request note"), n(f.note)]);
  }
  rows.push([L("مقدم الطلب", "Requested by"), `${n(item.requester)} · ${ago(item.createdAt, lang)}`]);
  return <dl className="hr-kv ws-kv">{rows.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

/**
 * `onDecided(msg, item, refresh)`: msg is set after a decision the server confirmed (the page keeps this
 * pane open on `item` so the outcome stays readable after the list reloads without it); refresh alone
 * when the request changed or was decided elsewhere.
 */
export function DecisionPane({ item, onClose, onDecided }: { item: ApprovalItem; onClose: () => void; onDecided: (msg: string, item: ApprovalItem, refresh?: boolean) => void }) {
  const L = useL();
  const lang = useLang();
  const [mode, setMode] = useState<"view" | "reject">("view");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<Outcome | null>(null);
  const f = item.facts as Record<string, unknown>;

  const decide = async (decision: "APPROVE" | "REJECT") => {
    setBusy(decision); setOut(null);
    try {
      await wsFetch(item.decide.url, { json: { decision, note: note.trim() || undefined, ...(item.decide.expected ? { expected: item.decide.expected } : {}) } });
      const msg = decision === "APPROVE" ? L("اعتُمد الطلب ونُفّذ في القسم المختص.", "Approved and applied in its department.") : L("رُفض الطلب وأُبلغ مقدمه بالسبب.", "Rejected; the requester was told why.");
      setOut({ kind: "ok", text: msg });
      onDecided(msg, item);
    } catch (e) {
      const code = e instanceof HrApiError ? e.code : null;
      const status = e instanceof HrApiError ? e.status : 0;
      if (code === "STALE_REQUEST") setOut({ kind: "stale", text: L("تغيّر الطلب بعد فتحه — حدّثنا البيانات. راجِع الأرقام الجديدة قبل اتخاذ القرار.", "The request changed after you opened it — the figures were refreshed. Review them before deciding.") });
      else if (status === 409) setOut({ kind: "decided", text: `${L("لم يعد هذا الطلب بانتظار قرارك — اتُّخذ القرار أو تغيّرت حالته.", "This request is no longer waiting for you — it was decided or its state changed.")} (${(e as Error).message})` });
      else setOut({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      if (code === "STALE_REQUEST" || status === 409) onDecided("", item, true);
    } finally {
      setBusy(null);
    }
  };

  const done = out?.kind === "ok" || out?.kind === "decided";
  const footer = done ? <Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn> : mode === "reject" ? (
    <div className="ws-pane-actions">
      <Btn variant="danger" busy={busy === "REJECT"} disabled={!note.trim() || out?.kind === "stale"} onClick={() => void decide("REJECT")} data-testid="decision-reject-confirm">{L("رفض الطلب", "Reject request")}</Btn>
      <Btn onClick={() => setMode("view")}>{L("تراجع", "Back")}</Btn>
    </div>
  ) : (
    <div className="ws-pane-actions">
      <Btn variant="primary" busy={busy === "APPROVE"} disabled={out?.kind === "stale"} onClick={() => void decide("APPROVE")} data-testid="decision-approve">{L("اعتماد الطلب", "Approve request")}</Btn>
      <Btn onClick={() => setMode("reject")} data-testid="decision-reject">{L("رفض مع ذكر السبب", "Reject with a reason")}</Btn>
      <Link className="hr-btn is-ghost" href={item.openUrl}>{L("فتح المستند الأصلي", "Open the original")}</Link>
    </div>
  );

  return (
    <OpsPane label={L("قرار الطلب", "Decision")} title={approvalTitle(item, lang, false)} sub={<TypeChip type={item.type} />} testId="decision-pane" onClose={onClose} busy={!!busy} footer={footer} drawer="open">
      <div className="hr-stack">
        {out ? <Notice tone={out.kind === "ok" ? "success" : out.kind === "error" ? "danger" : "warning"}>{out.text}</Notice> : null}
        {item.warnings.map((w, i) => <Notice key={i} tone="warning">{lang === "ar" ? w.ar : w.en}</Notice>)}
        <Facts item={item} />
        {item.type === "LEAVE" && Array.isArray(f.overlaps) && f.overlaps.length ? (
          <section aria-label={L("التعارضات", "Overlaps")}>
            <h3 className="hr-section">{L("في إجازة خلال الفترة نفسها", "On leave in the same period")}</h3>
            <ul className="ws-overlaps">{(f.overlaps as { name: string; status: string; startDate: string; endDate: string }[]).map((o, i) => (
              <li key={i}>{o.name} · {o.startDate} — {o.endDate} · {o.status === "APPROVED" ? L("معتمدة", "approved") : L("قيد الاعتماد", "pending")}</li>
            ))}</ul>
          </section>
        ) : null}
        {item.notice ? <Notice tone="info">{lang === "ar" ? item.notice.ar : item.notice.en}</Notice> : null}
        {item.decide.stepUp ? <p className="hr-caption">{L("قد يُطلب منك تأكيد هويتك قبل تنفيذ هذا القرار.", "You may be asked to confirm your identity first.")}</p> : null}
        {mode === "reject" && !done ? (
          <Field label={L("سبب الرفض (يصل لمقدم الطلب)", "Reason (sent to the requester)")}><textarea className="hr-input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoFocus data-testid="decision-note" /></Field>
        ) : null}
      </div>
    </OpsPane>
  );
}
