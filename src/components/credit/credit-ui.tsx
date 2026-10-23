"use client";

// Credit warnings, grace and the sales hold — the screens' pieces (feat/credit-hold). No Figma frame
// exists for them (file 1JbZgpMqmPkUVne8ms9Ozz checked: no credit / hold frames), so they are
// drawn with the Direction 2.1 kit the customer file already uses: the `.flag` badge, the
// `.callout` band and the HR-kit Dialog. Arabic RTL first, English beside it.
//
// Every figure and every decision comes from the server (GET /api/customers/[id]/credit and the
// account response's `creditState`); the dialogs post to /credit/grace, /credit/hold, /credit/lift,
// which re-check the permission (customers › sales_hold) and the state.
import { useEffect, useState } from "react";
import { Dialog, Field } from "@/components/hr/ui";
import { dayCount } from "@/components/d21/format";
import { localizeApiError } from "@/lib/i18n/api-errors";
import "./credit.css";

export type CreditState = {
  flags: { overLimit: boolean; overdueDays: number; clear: boolean; hasLimit: boolean; termsDays: number | null };
  warning: { overLimit: boolean; overdueDays: number; any: boolean };
  amounts: { limit: string | null; outstanding: string; over: string; overdue: string; currency: string } | null;
  grace: { id: string; days: number; until: string; reason: string | null; at: string; by: { id: string; name: string } | null } | null;
  graces: { count: number; last: { at: string; days: number; untilAt: string } | null };
  hold: { id: string; reason: string; basis: string; startsAt: string; endsAt: string | null; untilPaid: boolean; autoLiftAtEnd: boolean; autoLiftOnPayment: boolean; by: { id: string; name: string } | null } | null;
  suggestedReason: { ar: string; en: string };
  defaultHoldDays: number | null;
  proposedHoldDays: number;
  can: { hold: boolean };
};

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** «30 أكتوبر 2026» on the Riyadh calendar. */
export function fullDate(iso: string | Date, ar: boolean): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return ar ? `${Number(p.day)} ${AR_MONTHS[Number(p.month) - 1]} ${p.year}` : `${Number(p.day)} ${EN_MONTHS[Number(p.month) - 1]} ${p.year}`;
}
const money = (v: string) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
const L = (ar: boolean) => (a: string, e: string) => (ar ? a : e);

/** The red / amber badges: hold, over the limit, overdue, or the grace that replaces them. */
export function CreditBadges({ ar, s, compact = false }: {
  ar: boolean; compact?: boolean;
  s: { overLimit: boolean; overdueDays: number; graceUntil: string | null; hold: { endsAt: string | null; untilPaid: boolean } | null };
}) {
  const t = L(ar);
  const out: React.ReactNode[] = [];
  if (s.hold) out.push(<span key="h" className="flag" data-testid="badge-hold">{t("البيع موقوف", "Sales on hold")}</span>);
  if (s.overLimit) out.push(<span key="o" className="flag" data-testid="badge-over-limit">{t("متجاوز حد الائتمان", "Over credit limit")}</span>);
  if (s.overdueDays > 0) out.push(<span key="d" className="flag" data-testid="badge-overdue">{ar ? `متأخر السداد ${dayCount(s.overdueDays, "ar")}` : `Payment ${dayCount(s.overdueDays, "en")} overdue`}</span>);
  if (s.graceUntil && !s.hold) out.push(<span key="g" className="flag wa" data-testid="badge-grace">{ar ? `مهلة سماح حتى ${fullDate(s.graceUntil, true)}` : `Grace until ${fullDate(s.graceUntil, false)}`}</span>);
  if (out.length === 0) return null;
  return <span className={`cr-badges${compact ? " is-compact" : ""}`}>{out}</span>;
}
export const badgesOf = (c: CreditState) => ({ overLimit: c.warning.overLimit, overdueDays: c.warning.overdueDays, graceUntil: c.grace?.until ?? null, hold: c.hold ? { endsAt: c.hold.endsAt, untilPaid: c.hold.untilPaid } : null });

/** Who / why / until of a hold, one sentence. */
export function holdSentence(h: NonNullable<CreditState["hold"]>, ar: boolean): string {
  const until = h.untilPaid ? (ar ? "حتى السداد" : "until paid") : h.endsAt ? (ar ? `حتى ${fullDate(h.endsAt, true)}` : `until ${fullDate(h.endsAt, false)}`) : "";
  return ar
    ? `أوقفه ${h.by?.name ?? "—"} في ${fullDate(h.startsAt, true)} ${until} · السبب: ${h.reason}`
    : `Placed by ${h.by?.name ?? "—"} on ${fullDate(h.startsAt, false)} ${until} · Reason: ${h.reason}`;
}

/**
 * The customer file's band: the hold (red, «رفع الإيقاف»), else the warning (red, «إيقاف البيع»),
 * else the grace (amber). Nothing when the customer is in good standing.
 */
export function CreditCallout({ ar, c, phone, onHold, onLift }: { ar: boolean; c: CreditState; phone?: boolean; onHold: () => void; onLift: () => void }) {
  const t = L(ar);
  if (c.hold) {
    const h = c.hold;
    return (
      <div className={`callout er cr-callout${phone ? " ph" : ""}`} role="alert" data-testid="credit-hold-banner">
        <span className="flag">{t("البيع موقوف", "Sales on hold")}</span>
        <span>
          <b>{t("لا تُنشأ عروض أسعار ولا طلبات جديدة لهذا العميل.", "No new quotations or orders for this customer.")}</b>{" "}
          {holdSentence(h, ar)}.{" "}
          <span className="cr-muted">{h.autoLiftOnPayment ? t("يُرفع تلقائيًا عند السداد.", "Lifts automatically on payment.") : ""}{h.autoLiftAtEnd ? t(" يُرفع تلقائيًا في نهاية المدة.", " Lifts automatically at the end.") : ""} {t("الطلبات القائمة والتسليمات مستمرة.", "Existing orders and deliveries continue.")}</span>
        </span>
        {c.can.hold && <button type="button" className="btn sm" onClick={onLift} data-testid="credit-lift">{t("رفع الإيقاف", "Lift hold")}</button>}
      </div>
    );
  }
  if (c.warning.any) {
    const parts: string[] = [];
    if (c.warning.overLimit) parts.push(c.amounts?.limit ? (ar ? `الرصيد المستحق ${money(c.amounts.outstanding)} ر.س يتجاوز حد الائتمان ${money(c.amounts.limit)} ر.س بمبلغ ${money(c.amounts.over)} ر.س` : `The balance SAR ${money(c.amounts.outstanding)} is SAR ${money(c.amounts.over)} over the SAR ${money(c.amounts.limit)} limit`) : t("الرصيد المستحق يتجاوز حد الائتمان", "The balance is over the credit limit"));
    if (c.warning.overdueDays > 0) parts.push(ar ? `أقدم مستحق متأخر ${dayCount(c.warning.overdueDays, "ar")}${c.amounts ? ` (${money(c.amounts.overdue)} ر.س متأخرة)` : ""}` : `the oldest debt is ${dayCount(c.warning.overdueDays, "en")} overdue${c.amounts ? ` (SAR ${money(c.amounts.overdue)} overdue)` : ""}`);
    return (
      <div className={`callout er cr-callout${phone ? " ph" : ""}`} role="status" data-testid="credit-warning">
        <CreditBadges ar={ar} s={badgesOf(c)} compact />
        <span>{parts.join(ar ? "، و" : "; ")}. <span className="cr-muted">{t("تنبيه فقط؛ البيع مستمر ما لم يُوقف.", "A warning only; sales continue unless held.")}</span></span>
        {c.can.hold && <button type="button" className="btn sm" onClick={onHold} data-testid="credit-hold">{t("إيقاف البيع", "Hold sales")}</button>}
      </div>
    );
  }
  if (c.grace) {
    return (
      <div className={`callout cr-callout cr-grace${phone ? " ph" : ""}`} role="status" data-testid="credit-grace">
        <span className="flag wa">{ar ? `مهلة سماح حتى ${fullDate(c.grace.until, true)}` : `Grace until ${fullDate(c.grace.until, false)}`}</span>
        <span>{ar ? `منحها ${c.grace.by?.name ?? "—"} لمدة ${dayCount(c.grace.days, "ar")}` : `Given by ${c.grace.by?.name ?? "—"} for ${dayCount(c.grace.days, "en")}`}{c.grace.reason ? ` · ${c.grace.reason}` : ""}. <span className="cr-muted">{t("تعود التنبيهات عند انتهائها إن بقي العميل متجاوزًا أو متأخرًا.", "The warnings return when it ends if the customer is still over or overdue.")}</span></span>
        {c.can.hold && <button type="button" className="btn sm" onClick={onHold} data-testid="credit-hold">{t("إيقاف البيع", "Hold sales")}</button>}
      </div>
    );
  }
  return null;
}

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const data = r ? await r.json().catch(() => ({})) : {};
  return { ok: !!r?.ok, status: r?.status ?? 0, data: data as Record<string, unknown> };
}

function Chips({ values, value, onPick, custom, onCustom, unit, testId, extra, customUnit }: {
  values: readonly (number | "paid")[]; value: number | "paid" | "custom"; onPick: (v: number | "paid") => void; custom: string; onCustom: (v: string) => void;
  unit: (n: number) => string; testId: string; extra?: { ar: string }; customUnit: string;
}) {
  return (
    <div className="cr-chips" role="radiogroup">
      {values.map((v) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={`cr-chip${value === v ? " on" : ""}`} onClick={() => onPick(v)} data-testid={`${testId}-${v}`}>
          {v === "paid" ? extra?.ar ?? "" : unit(v)}
        </button>
      ))}
      <label className={`cr-chip cr-custom${value === "custom" ? " on" : ""}`}>
        <input inputMode="numeric" dir="ltr" value={custom} onChange={(e) => onCustom(e.target.value.replace(/[^\d٠-٩]/g, "").slice(0, 3))} placeholder="—" aria-label="custom" data-testid={`${testId}-custom`} />
        <span>{customUnit}</span>
      </label>
    </div>
  );
}
const toInt = (s: string) => Number(s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)));

/**
 * «إيقاف البيع» — one dialog, three steps:
 *   ask   «هل تود إعطاء أيام سماح قبل الإيقاف؟»  نعم → grace · لا → hold
 *   grace (repeat warning first when the customer had one) days 3/7/14/custom + reason → POST /credit/grace
 *   hold  reason (pre-filled), duration 7/14/30/«حتى السداد»/custom (default: the customer's setting),
 *         auto-lift at the end and/or on payment → POST /credit/hold
 */
export function HoldDialog({ ar, customerId, customerName, c, onClose, onDone, startAt = "ask" }: {
  ar: boolean; customerId: string; customerName: string; c: CreditState; onClose: () => void; onDone: (what: "grace" | "hold") => void; startAt?: "ask" | "grace" | "hold";
}) {
  const t = L(ar);
  const repeat = c.graces.count > 0;
  const [step, setStep] = useState<"ask" | "repeat" | "grace" | "hold">(startAt === "grace" ? (repeat ? "repeat" : "grace") : startAt);
  const [graceDays, setGraceDays] = useState<number | "custom">(7);
  const [graceCustom, setGraceCustom] = useState("");
  const [graceReason, setGraceReason] = useState("");
  const proposed = c.proposedHoldDays;
  const [dur, setDur] = useState<number | "paid" | "custom">([7, 14, 30].includes(proposed) ? proposed : "custom");
  const [durCustom, setDurCustom] = useState([7, 14, 30].includes(proposed) ? "" : String(proposed));
  const [reason, setReason] = useState(ar ? c.suggestedReason.ar : c.suggestedReason.en);
  const [liftAtEnd, setLiftAtEnd] = useState(true);
  const [liftOnPay, setLiftOnPay] = useState(!c.flags.clear);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // When the dialog opened: the end dates it previews are counted from here (render stays pure).
  const [openedAt] = useState(() => Date.now());
  const until = dur === "paid";
  const days = dur === "custom" ? toInt(durCustom) : typeof dur === "number" ? dur : null;
  const gDays = graceDays === "custom" ? toInt(graceCustom) : graceDays;

  async function giveGrace() {
    if (busy || !(gDays >= 1 && gDays <= 90)) return;
    setBusy(true); setErr("");
    const r = await post(`/api/customers/${customerId}/credit/grace`, { days: gDays, reason: graceReason.trim() || null, confirmRepeat: repeat });
    setBusy(false);
    if (r.ok) onDone("grace"); else setErr(localizeApiError(r.data, ar ? "ar" : "en") ?? t("تعذّر الحفظ.", "Could not save."));
  }
  async function placeHold() {
    if (busy || !reason.trim() || (!until && !(days && days >= 1 && days <= 365))) return;
    setBusy(true); setErr("");
    const r = await post(`/api/customers/${customerId}/credit/hold`, until
      ? { reason: reason.trim(), untilPaid: true }
      : { reason: reason.trim(), days, autoLiftAtEnd: liftAtEnd, autoLiftOnPayment: liftOnPay });
    setBusy(false);
    if (r.ok) onDone("hold"); else setErr(localizeApiError(r.data, ar ? "ar" : "en") ?? t("تعذّر الحفظ.", "Could not save."));
  }

  const err$ = err ? <p className="hr-err is-wide" role="alert" data-testid="credit-dialog-error" style={{ gridColumn: "1 / -1", margin: 0 }}>{err}</p> : null;
  const last = c.graces.last;
  const cancel = <button type="button" className="hr-btn" onClick={onClose}>{t("إلغاء", "Cancel")}</button>;

  if (step === "ask") {
    return (
      <Dialog open title={t("إيقاف البيع", "Hold sales")} sub={customerName} onClose={onClose} testId="hold-dialog"
        actions={<>
          <button type="button" className="hr-btn is-primary" onClick={() => setStep(repeat ? "repeat" : "grace")} data-testid="grace-yes">{t("نعم، أعطِ أيام سماح", "Yes, give grace days")}</button>
          <button type="button" className="hr-btn" onClick={() => setStep("hold")} data-testid="grace-no">{t("لا، أوقف البيع", "No, hold sales")}</button>
          {cancel}
        </>}>
        <div className="hr-form">
          <p className="cr-q is-wide" data-testid="grace-question">{t("هل تود إعطاء أيام سماح قبل الإيقاف؟", "Would you like to give grace days before holding?")}</p>
          <p className="hr-help is-wide" style={{ gridColumn: "1 / -1", margin: 0 }}>{t("أيام السماح تُخفي التنبيه حتى نهايتها دون إيقاف البيع، وتُسجَّل في ملف العميل.", "Grace days hide the warning until they end without holding sales, and are recorded on the customer.")}</p>
        </div>
      </Dialog>
    );
  }
  if (step === "repeat") {
    return (
      <Dialog open title={t("أيام سماح مرة أخرى؟", "Grace again?")} sub={customerName} onClose={onClose} testId="grace-repeat-dialog"
        actions={<>
          <button type="button" className="hr-btn is-primary" onClick={() => setStep("grace")} data-testid="grace-repeat-continue">{t("نعم، استمر", "Yes, continue")}</button>
          <button type="button" className="hr-btn" onClick={() => setStep("hold")} data-testid="grace-repeat-hold">{t("لا، أوقف البيع", "No, hold sales")}</button>
          {cancel}
        </>}>
        <div className="hr-form">
          <p className="callout cr-callout cr-grace is-wide" data-testid="grace-repeat-warning" style={{ gridColumn: "1 / -1", margin: 0 }}>
            {ar
              ? `هذا العميل حصل على أيام سماح من قبل (${c.graces.count} ${c.graces.count === 1 ? "مرة" : c.graces.count === 2 ? "مرتين" : "مرات"}، آخرها ${last ? fullDate(last.at, true) : "—"} لمدة ${last ? dayCount(last.days, "ar") : "—"}). هل تود الاستمرار؟`
              : `This customer has had grace days before (${c.graces.count} time${c.graces.count === 1 ? "" : "s"}, the last on ${last ? fullDate(last.at, false) : "—"} for ${last ? dayCount(last.days, "en") : "—"}). Do you want to continue?`}
          </p>
        </div>
      </Dialog>
    );
  }
  if (step === "grace") {
    const valid = gDays >= 1 && gDays <= 90;
    return (
      <Dialog open title={t("أيام سماح", "Grace days")} sub={customerName} onClose={onClose} testId="grace-dialog"
        actions={<>
          <button type="button" className="hr-btn is-primary" disabled={!valid || busy} onClick={giveGrace} data-testid="grace-save">{busy ? t("جارٍ الحفظ…", "Saving…") : t("إعطاء المهلة", "Give grace")}</button>
          <button type="button" className="hr-btn" onClick={() => setStep("ask")}>{t("رجوع", "Back")}</button>
        </>}>
        <div className="hr-form">
          {err$}
          <Field label={t("عدد أيام السماح", "Grace days")} wide help={valid ? (ar ? `تنتهي في ${fullDate(new Date(openedAt + gDays * 86_400_000), true)}. لا يُوقف البيع.` : `Ends on ${fullDate(new Date(openedAt + gDays * 86_400_000), false)}. Sales are not held.`) : t("من 1 إلى 90 يومًا.", "1 to 90 days.")}>
            <Chips values={[3, 7, 14]} value={graceDays} onPick={(v) => { setGraceDays(v as number); setGraceCustom(""); }} custom={graceCustom} onCustom={(v) => { setGraceCustom(v); setGraceDays("custom"); }} unit={(n) => dayCount(n, ar ? "ar" : "en")} testId="grace-days" customUnit={t("يوم (مخصص)", "days (custom)")} />
          </Field>
          <Field label={t("السبب (اختياري)", "Reason (optional)")} wide>
            <input className="hr-input" value={graceReason} onChange={(e) => setGraceReason(e.target.value)} maxLength={500} placeholder={t("وعد بالسداد يوم الخميس", "Promised to pay on Thursday")} data-testid="grace-reason" />
          </Field>
        </div>
      </Dialog>
    );
  }
  const validHold = !!reason.trim() && (until || (!!days && days >= 1 && days <= 365));
  return (
    <Dialog open title={t("إيقاف البيع", "Hold sales")} sub={customerName} onClose={onClose} testId="hold-form-dialog"
      actions={<>
        <button type="button" className="hr-btn is-danger" disabled={!validHold || busy} onClick={placeHold} data-testid="hold-confirm">{busy ? t("جارٍ…", "Working…") : t("تأكيد الإيقاف", "Confirm hold")}</button>
        {startAt === "ask" ? <button type="button" className="hr-btn" onClick={() => setStep("ask")}>{t("رجوع", "Back")}</button> : cancel}
      </>}>
      <div className="hr-form">
        {err$}
        <p className="hr-help is-wide" style={{ gridColumn: "1 / -1", margin: 0 }}>{t("أثناء الإيقاف يُرفض إنشاء أي عرض سعر أو طلب جديد لهذا العميل. الطلبات القائمة والتسليمات مستمرة.", "While held, no new quotation or order can be created for this customer. Existing orders and deliveries continue.")}</p>
        <Field label={t("سبب الإيقاف *", "Reason *")} wide>
          <input className="hr-input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-testid="hold-reason" />
        </Field>
        <Field label={t("المدة", "Duration")} wide help={c.defaultHoldDays ? (ar ? `الافتراضي لهذا العميل ${dayCount(c.defaultHoldDays, "ar")}.` : `This customer's default is ${dayCount(c.defaultHoldDays, "en")}.`) : t("لا مدة افتراضية للعميل؛ تُقترح 14 يومًا.", "No default for this customer; 14 days proposed.")}>
          <Chips values={[7, 14, 30, "paid"]} value={dur} onPick={(v) => { setDur(v); setDurCustom(""); if (v === "paid") setLiftOnPay(true); }} custom={durCustom} onCustom={(v) => { setDurCustom(v); setDur("custom"); }} unit={(n) => dayCount(n, ar ? "ar" : "en")} testId="hold-days" extra={{ ar: t("حتى السداد", "Until paid") }} customUnit={t("يوم (مخصص)", "days (custom)")} />
        </Field>
        <div className="is-wide cr-lifts" style={{ gridColumn: "1 / -1" }}>
          <span className="hr-label">{t("الرفع التلقائي", "Automatic lift")}</span>
          <label className="cu-check"><input type="checkbox" checked={!until && liftAtEnd} disabled={until} onChange={(e) => setLiftAtEnd(e.target.checked)} data-testid="hold-lift-end" />{until ? t("لا نهاية — حتى السداد", "No end — until paid") : (ar ? `عند انتهاء المدة${days ? ` (${fullDate(new Date(openedAt + days * 86_400_000), true)})` : ""}` : `At the end${days ? ` (${fullDate(new Date(openedAt + days * 86_400_000), false)})` : ""}`)}</label>
          <label className="cu-check"><input type="checkbox" checked={until || liftOnPay} disabled={until} onChange={(e) => setLiftOnPay(e.target.checked)} data-testid="hold-lift-pay" />{t("رفع تلقائي عند السداد (ضمن الحد ولا متأخرات)", "Lift automatically on payment (within limit, nothing overdue)")}</label>
        </div>
      </div>
    </Dialog>
  );
}

/** «رفع الإيقاف» by hand — the reason is required and logged. */
export function LiftDialog({ ar, customerId, customerName, c, onClose, onDone }: { ar: boolean; customerId: string; customerName: string; c: CreditState; onClose: () => void; onDone: () => void }) {
  const t = L(ar);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function lift() {
    if (busy || !reason.trim()) return;
    setBusy(true); setErr("");
    const r = await post(`/api/customers/${customerId}/credit/lift`, { reason: reason.trim() });
    setBusy(false);
    if (r.ok) onDone(); else setErr(localizeApiError(r.data, ar ? "ar" : "en") ?? t("تعذّر رفع الإيقاف.", "Could not lift the hold."));
  }
  return (
    <Dialog open title={t("رفع الإيقاف", "Lift the hold")} sub={customerName} onClose={onClose} testId="lift-dialog"
      actions={<>
        <button type="button" className="hr-btn is-primary" disabled={!reason.trim() || busy} onClick={lift} data-testid="lift-confirm">{busy ? t("جارٍ…", "Working…") : t("رفع الإيقاف", "Lift hold")}</button>
        <button type="button" className="hr-btn" onClick={onClose}>{t("إلغاء", "Cancel")}</button>
      </>}>
      <div className="hr-form">
        {err ? <p className="hr-err is-wide" role="alert" style={{ gridColumn: "1 / -1", margin: 0 }}>{err}</p> : null}
        {c.hold && <p className="hr-help is-wide" style={{ gridColumn: "1 / -1", margin: 0 }}>{holdSentence(c.hold, ar)}</p>}
        <Field label={t("سبب الرفع *", "Reason *")} wide>
          <input className="hr-input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={t("سُدد المستحق بالكامل", "The balance was paid in full")} data-testid="lift-reason" />
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * The warning inside a create-quotation / create-order dialog for any customer: fetches
 * GET /api/customers/[id]/credit, shows the badges and the sentence, and reports a hold to the
 * caller so it can disable submitting (the server refuses 409 CUSTOMER_SALES_HOLD regardless).
 */
export function CustomerCreditNotice({ customerId, ar, onHold, testId = "credit-notice" }: { customerId: string | null | undefined; ar: boolean; onHold?: (held: boolean) => void; testId?: string }) {
  const [c, setC] = useState<CreditState | null>(null);
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    if (!customerId) { onHold?.(false); return; }
    fetch(`/api/customers/${encodeURIComponent(customerId)}/credit`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: CreditState | null) => { if (!off) { setC(d); setKey(customerId); onHold?.(!!d?.hold); } })
      .catch(() => undefined);
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onHold is a setter; refetch per customer only
  }, [customerId]);
  if (!customerId || !c || key !== customerId) return null;
  return <CreditNoticeBody c={c} ar={ar} testId={testId} />;
}

/** The notice for a credit state already in hand (the customer file's quotation dialog). */
export function CreditNoticeBody({ c, ar, testId = "credit-notice" }: { c: CreditState; ar: boolean; testId?: string }) {
  const t = L(ar);
  if (c.hold) {
    return (
      <div className="callout er cr-callout cr-inline" role="alert" data-testid={`${testId}-hold`}>
        <span className="flag">{t("البيع موقوف", "Sales on hold")}</span>
        <span><b>{t("لا يمكن إنشاء عرض سعر أو طلب جديد لهذا العميل.", "No new quotation or order can be created for this customer.")}</b> {holdSentence(c.hold, ar)}. {c.hold.by ? (ar ? `تواصل مع ${c.hold.by.name} أو مع مدير المنشأة لرفع الإيقاف.` : `Contact ${c.hold.by.name} or the administrator to lift it.`) : t("تواصل مع مدير المنشأة لرفع الإيقاف.", "Contact the administrator to lift it.")}</span>
      </div>
    );
  }
  if (!c.warning.any) return null;
  return (
    <div className="callout er cr-callout cr-inline" role="note" data-testid={`${testId}-warning`}>
      <CreditBadges ar={ar} s={badgesOf(c)} compact />
      <span>
        {c.warning.overLimit && c.amounts?.limit ? (ar ? `الرصيد ${money(c.amounts.outstanding)} ر.س يتجاوز الحد ${money(c.amounts.limit)} ر.س بمبلغ ${money(c.amounts.over)} ر.س. ` : `Balance SAR ${money(c.amounts.outstanding)} is SAR ${money(c.amounts.over)} over the SAR ${money(c.amounts.limit)} limit. `) : ""}
        {t("تنبيه فقط؛ يمكنك المتابعة.", "A warning only; you may continue.")}
      </span>
    </div>
  );
}
