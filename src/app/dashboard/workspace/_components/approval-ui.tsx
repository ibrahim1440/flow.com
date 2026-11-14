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
    rows.push([L("المبلغ", "Amount"), <span key="m" className="hr-num">{money(f.amount)} {L("⃁", "SAR")}</span>]);
    rows.push([L("خطة الاستقطاع", "Deduction plan"), L(`${f.installmentCount} أقساط × ${f.installment} ⃁ ابتداءً من ${monthOf(String(f.firstInstallmentMonth), "ar")}`, `${f.installmentCount} × ${f.installment} SAR from ${monthOf(String(f.firstInstallmentMonth), "en")}`)]);
    if (f.reason) rows.push([L("السبب", "Reason"), n(f.reason)]);
  } else if (item.type === "DISCOUNT") {
    // The riyal sign (D19) for SAR; a direct sale names its order and how it is paid instead of a deal / quotation.
    const cur = f.currency === "SAR" ? L("⃁", "SAR") : n(f.currency);
    const direct = !f.quoteNumber && f.orderNumber;
    rows.push([L("العميل", "Customer"), n(f.customer)]);
    if (f.invoiceDraft) {
      rows.push([L("المستند", "Document"), L("مسودة فاتورة — عدّلها المندوب بعد إرسالها", "Invoice draft — edited by the rep after it was sent")]);
    } else if (direct) {
      rows.push([L("البيع المباشر", "Direct sale"), `${L("طلب", "Order")} #${n(f.orderNumber)}${f.dealOwner ? ` · ${f.dealOwner}` : ""}`]);
      if (f.payment) rows.push([L("الدفع", "Payment"), <span key="pay" data-testid="approval-payment">{f.payment === "BANK_TRANSFER" ? L("تحويل بنكي (الإيصال بعد الموافقة)", "Bank transfer (receipt after the approval)") : f.payment === "CASH" ? L("نقداً", "Cash") : f.payment === "CARD" ? L("شبكة", "Card") : L("آجل", "On account")}</span>]);
    } else {
      rows.push([L("الصفقة", "Deal"), `${n(f.deal)}${f.dealOwner ? ` · ${f.dealOwner}` : ""}`]);
      rows.push([L("عرض السعر", "Quotation"), `${f.quoteNumber ? n(f.quoteNumber) : L("مسودة (بدون رقم — يأخذ رقمه عند الإصدار)", "Draft (numbered at issue)")}${Number(f.revision) > 1 ? ` · ${L("مراجعة", "rev.")} ${f.revision}` : ""}`]);
    }
    rows.push([L("الخصم المطلوب", "Requested discount"), <b key="d" className="hr-num">{n(f.discountPercent)}%</b>]);
    rows.push([L("الحد المسموح", "Allowed without approval"), <span key="t" className="hr-num">{n(f.thresholdPercent)}%</span>]);
    rows.push([L("قبل الخصم", "Before discount"), <span key="s" className="hr-num">{money(f.subtotal)} {cur}</span>]);
    rows.push([L("قيمة الخصم", "Discount"), <span key="x" className="hr-num">{money(f.discountTotal)} {cur}</span>]);
    rows.push([L("الإجمالي مع الضريبة", "Total incl. VAT"), <b key="g" className="hr-num" data-testid="approval-total">{money(f.grandTotal)} {cur}</b>]);
  } else if (item.type === "SAMPLE") {
    // A customer's second sample of a coffee product («للعميل من كل محصول عيّنة واحدة»).
    rows.push([L("العميل", "Customer"), n(lang === "ar" ? f.customerAr ?? f.customer : f.customer)]);
    rows.push([L("الصفقة", "Deal"), `${n(f.deal)}${f.dealOwner ? ` · ${f.dealOwner}` : ""}`]);
    rows.push([L("المحصول", "Product"), <span key="p"><bdi>{n(lang === "ar" ? f.productAr ?? f.product : f.product)}</bdi> · <span className="hr-num">{n(f.units)}</span> {L("عبوة", "unit")}</span>]);
    if (f.note) rows.push([L("ملاحظة المندوب", "The rep's note"), <bdi key="n">{n(f.note)}</bdi>]);
  } else if (item.type === "TAX_OVERRIDE") {
    // P0 C5: a VAT treatment change on a draft — what changes, the ZATCA reason code and the written reason.
    const cat = (c: string) => c === "Z" ? L("صفرية", "Zero-rated") : c === "E" ? L("معفاة", "Exempt") : c === "O" ? L("خارج النطاق", "Out of scope") : L("أساسية", "Standard");
    rows.push([L("العميل", "Customer"), n(f.customer)]);
    rows.push([L("المستند", "Document"), f.documentType === "QUOTE" ? L("عرض سعر (مسودة)", "Quotation (draft)") : L("فاتورة (مسودة)", "Invoice (draft)")]);
    (Array.isArray(f.lines) ? (f.lines as { key: string; taxCategory: string; taxRatePercent: string; exemptionReasonCode: string | null }[]) : []).forEach((l, i) => {
      rows.push([`${L("البند", "Line")} ${i + 1}`, <span key={`l${i}`} data-testid={`approval-tax-line-${i}`}>{cat(l.taxCategory)} · <span className="hr-num">{l.taxRatePercent}%</span>{l.exemptionReasonCode ? <> · <bdi>{l.exemptionReasonCode}</bdi></> : null}</span>]);
    });
    rows.push([L("السبب", "Reason"), <bdi key="r">{n(f.reason)}</bdi>]);
  } else if (item.type === "CREDIT_OVERRIDE") {
    // P1 ERR-02: an order over the customer's credit limit — the figures of the Figma 2033:28 sentence.
    const cur = L("⃁", "SAR");
    rows.push([L("العميل", "Customer"), n(f.customer)]);
    rows.push([L("نوع الطلب", "Order type"), n(lang === "ar" ? f.kind : f.kindEn)]);
    // Abu Fahd R3 A6: the SAME breakdown, in the same words, as the rep's over-limit panel (credit-ui.tsx) — never a
    // «used» figure the rep never saw. A paid-ahead balance reads «رصيد دائن (دفعات مقدّمة)».
    if (f.receivable != null && Number(f.receivable) < 0) rows.push([L("رصيد دائن (دفعات مقدّمة)", "Credit balance (paid ahead)"), <span key="cb" className="hr-num">− {money(String(-Number(f.receivable)))} {cur}</span>]);
    else if (f.receivable != null) rows.push([L("عليه الحين", "Owed now"), <span key="rv" className="hr-num">{money(f.receivable)} {cur}</span>]);
    if (f.approvedNotInvoiced != null) rows.push([L("طلبات معتمدة ما انفوترت", "Approved orders not yet invoiced"), <span key="ani" className="hr-num" data-testid="approval-credit-used">{money(f.approvedNotInvoiced)} {cur}</span>]);
    rows.push([L("هذا الطلب", "This order"), <b key="o" className="hr-num" data-testid="approval-credit-amount">{money(f.amount)} {cur}</b>]);
    rows.push([L("المجموع", "Total"), <span key="t" className="hr-num" data-testid="approval-credit-total">{money(f.total)} {cur}</span>]);
    rows.push([L("الحد", "Limit"), <span key="l" className="hr-num">{money(f.limit)} {cur}</span>]);
    rows.push([L("الزيادة", "Over by"), <b key="x" className="hr-num" data-testid="approval-credit-excess">{money(f.excess)} {cur}</b>]);
    // R4: what the rep asked for, read-only — the same «البند n» rows as a tax override's lines. Abu Fahd R3 A5: each line's
    // total, and a note when «هالطلب» (what is left after the approved payments) is not the lines' total.
    const cl = Array.isArray(f.lines) ? (f.lines as { name: string; nameEn: string; qty: string; unitPrice: string; discountPercent: string; lineNet?: string; lineGross?: string }[]) : [];
    cl.forEach((l, i) => {
      rows.push([`${L("البند", "Line")} ${i + 1}`, <span key={`cl${i}`} data-testid={`approval-credit-line-${i}`}><bdi>{lang === "ar" ? l.name : l.nameEn}</bdi> · {/* Abu Fahd R4 F5: the arithmetic reads left to right inside the RTL row («4 × 110.00 = 440.00»). */}<bdi dir="ltr" className="hr-num" data-testid={`approval-credit-line-math-${i}`}>{l.qty} × {money(l.unitPrice)}{l.lineNet ? <> = <b data-testid={`approval-credit-line-total-${i}`}>{money(l.lineNet)}</b></> : null}</bdi> {cur}{Number(l.discountPercent) > 0 ? <> · {L("خصم", "discount")} <bdi dir="ltr" className="hr-num">{l.discountPercent}%</bdi></> : null}</span>]);
    });
    const linesGross = cl.reduce((t, l) => t + Number(l.lineGross ?? NaN), 0);
    if (cl.length && Number.isFinite(linesGross)) {
      const differs = Math.abs(linesGross - Number(f.amount)) >= 0.01;
      rows.push([L("مجموع البنود مع الضريبة", "Lines' total with VAT"), <span key="lg" data-testid="approval-credit-lines-total"><span className="hr-num">{money(linesGross.toFixed(2))}</span> {cur}{differs ? <> · <span className="hr-help" style={{ margin: 0 }} data-testid="approval-credit-remaining-note">{L("«هذا الطلب» هو الباقي بعد الدفعات المعتمدة", "«This order» is what is left after the approved payments")}</span></> : null}</span>]);
    }
    rows.push([L("سبب المندوب", "The rep's reason"), <bdi key="r">{n(f.reason)}</bdi>]);
  } else if (item.type === "STAGE_MOVE") {
    // Pipeline v2: a rep's manual stage move waiting for the supervisor.
    rows.push([L("الصفقة", "Deal"), `${n(f.deal)}${f.dealOwner ? ` · ${f.dealOwner}` : ""}`]);
    rows.push([L("من مرحلة", "From"), n(lang === "ar" ? f.from : f.fromEn ?? f.from)]);
    rows.push([L("إلى مرحلة", "To"), <b key="to">{n(lang === "ar" ? f.to : f.toEn ?? f.to)}</b>]);
    if (f.reason) rows.push([L("السبب", "Reason"), n(f.reason)]);
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
      <Btn variant="primary" busy={busy === "APPROVE"} disabled={out?.kind === "stale" || (!!item.decide.approveNeedsReason && note.trim().length < 5)} onClick={() => void decide("APPROVE")} data-testid="decision-approve">{L("اعتماد الطلب", "Approve request")}</Btn>
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
        {/* D22 (أبو فهد B3): a second sample's approval carries the manager's note here too (kept on the request, sent to the rep). */}
        {mode === "view" && !done && item.type === "SAMPLE" ? (
          <Field label={L("ملاحظة للمندوب (اختياري)", "Note to the rep (optional)")}><textarea className="hr-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-testid="decision-approve-note" /></Field>
        ) : null}
        {mode === "view" && !done && item.decide.approveNeedsReason ? (
          <Field label={L("سبب الاعتماد (يُحفظ في السجل)", "Reason for approving (kept in the log)")}><textarea className="hr-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-testid="decision-approve-reason" /></Field>
        ) : null}
        {mode === "reject" && !done ? (
          <Field label={L("سبب الرفض (يصل لمقدم الطلب)", "Reason (sent to the requester)")}><textarea className="hr-input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoFocus data-testid="decision-note" /></Field>
        ) : null}
      </div>
    </OpsPane>
  );
}
