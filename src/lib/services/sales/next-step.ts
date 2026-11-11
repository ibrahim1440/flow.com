// «المطلوب منك الآن» — pipeline v2's next-step engine (PIPELINE-V2-DESIGN §2.2, §2.5; docs/sales/PIPELINE_STAGES.md).
//
// The approved pipeline: فرصة مؤهلة (تحليل الاحتياج is a step inside it) → تجربة وتقييم العينات (skippable in one
// click) → عرض السعر والتفاوض → مغلقة (رابحة / خاسرة, the deal's OUTCOME). For one deal this answers, from the deal
// as the server holds it:
//   - which of the four steps it is in (`phase`), and the quotation's sub-status inside the quotation stage;
//   - what is required of the person now (≤ 3 short lines);
//   - ONE primary action, and at most TWO quiet secondary ones (a beginner sees one button);
//   - the one follow-up the deal is waiting on (sample feedback, the customer's reply to a quotation, or a promise).
//
// Pure: no database, no clock of its own (`now` is passed). The deal GET computes it on the server and the deal page
// renders it; my-day computes the same thing from its own query, so the two can never disagree. Which of these the
// person may actually do (privileges) is the page's call — except where the label itself depends on it (a discount
// only an approver can approve), which is why the viewer's two approvals are an input.
import { qualificationMissing, QUALIFICATION_FIELD_LABELS } from "./needs";
import { effectivePurpose, type StagePurpose } from "./stages";
const DAY = 86_400_000;

/**
 * Days after a sample is sent within which the customer's view is expected. ONE clock (pipeline v2 §2.6, fixes D1):
 * the sample follow-up activity's due date, my-day's SAMPLE call reason and the deal page all use it.
 */
export const SAMPLE_FEEDBACK_DAYS = 5;

/** Days an issued quotation waits for the customer's answer before it asks for a follow-up. */
export const QUOTE_FOLLOW_UP_DAYS = 3;

/**
 * When an issued quotation needs a follow-up: three days after issue, or two days before it lapses when that is
 * sooner. The ONE rule — the workspace's «عروض تحتاج متابعة», the deal page and my-day all read it.
 */
export function quoteFollowUpDue(q: { issuedAt: Date | string | null; validUntil: Date | string | null }, now: Date = new Date()): Date {
  const issued = q.issuedAt ? new Date(q.issuedAt).getTime() : now.getTime();
  const byAge = issued + QUOTE_FOLLOW_UP_DAYS * DAY;
  const byExpiry = q.validUntil ? new Date(q.validUntil).getTime() - 2 * DAY : Infinity;
  return new Date(Math.min(byAge, byExpiry));
}

/**
 * An Arabic count of days in its correct form (gate fix L4): «يوم واحد» · «يومين» · «3 أيام» … «10 أيام» · «11 يومًا».
 * Callers phrase 0 themselves («اليوم»). Exported for the screens that say the same thing.
 */
export function arDays(n: number): string {
  const a = Math.abs(n);
  if (a === 1) return "يوم واحد";
  if (a === 2) return "يومين";
  if (a >= 3 && a <= 10) return `${a} أيام`;
  return `${a} يومًا`;
}
const enDays = (n: number) => `${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"}`;

export type Phase = "QUALIFIED" | "SAMPLES" | "QUOTE" | "CLOSED";

export type QuoteState =
  | "NONE" | "DRAFT" | "REVISING" | "AWAITING_DISCOUNT" | "DISCOUNT_REFUSED"
  | "SENT" | "LAPSED" | "REJECTED" | "ACCEPTED" | "ORDERED";

export const QUOTE_STATE_LABELS: Record<QuoteState, { ar: string; en: string }> = {
  NONE: { ar: "لا يوجد عرض سعر", en: "No quotation" },
  DRAFT: { ar: "مسودة — لم تُرسل", en: "Draft — not sent" },
  REVISING: { ar: "قيد التعديل", en: "Being revised" },
  AWAITING_DISCOUNT: { ar: "بانتظار اعتماد الخصم", en: "Awaiting discount approval" },
  DISCOUNT_REFUSED: { ar: "رُفض الخصم — عدّل العرض", en: "Discount refused — edit the quotation" },
  SENT: { ar: "مُرسل — بانتظار رد العميل", en: "Sent — awaiting the customer's reply" },
  LAPSED: { ar: "انتهت صلاحية العرض", en: "The quotation has lapsed" },
  REJECTED: { ar: "رفض العميل العرض", en: "The customer rejected the quotation" },
  ACCEPTED: { ar: "معتمد من العميل", en: "Accepted by the customer" },
  ORDERED: { ar: "تم إنشاء الطلب", en: "Order created" },
};

export type DealActionKey =
  | "RECORD_NEEDS" | "REQUEST_SAMPLE" | "SEND_SAMPLE" | "RECORD_SAMPLE_EVALUATION" | "SKIP_SAMPLES" | "WAIT_SAMPLE"
  | "CREATE_QUOTE" | "ISSUE_QUOTE" | "EDIT_QUOTE" | "REVISE_QUOTE" | "REQUEST_APPROVAL" | "RECORD_REPLY" | "LOG_CALL"
  | "WIN" | "CREATE_ORDER" | "VIEW_ORDER" | "DOCUMENT_LOSS" | "REOPEN" | "ADVANCE"
  | "APPROVE_SAMPLE" | "DECLINE_SAMPLE";

export type DealAction = {
  key: DealActionKey;
  ar: string;
  en: string;
  quoteId?: string;
  sampleId?: string;
  orderId?: string;
  /** Shown but not clickable (it explains what the deal waits for). */
  disabled?: boolean;
};

const LABEL: Record<DealActionKey, { ar: string; en: string }> = {
  RECORD_NEEDS: { ar: "تسجيل تحليل الاحتياج", en: "Record the needs" },
  REQUEST_SAMPLE: { ar: "اطلب عيّنة", en: "Request a sample" },
  SEND_SAMPLE: { ar: "تعليم العيّنة مُرسلة", en: "Mark the sample sent" },
  RECORD_SAMPLE_EVALUATION: { ar: "سجّل رأي العميل في العيّنة", en: "Record the customer's view of the sample" },
  SKIP_SAMPLES: { ar: "العميل ما يحتاج عينات", en: "The customer needs no sample" },
  WAIT_SAMPLE: { ar: "العيّنة بانتظار الصرف", en: "The sample awaits dispatch" },
  APPROVE_SAMPLE: { ar: "وافق", en: "Approve" },
  DECLINE_SAMPLE: { ar: "ارفض", en: "Decline" },
  CREATE_QUOTE: { ar: "إنشاء عرض سعر", en: "Create a quotation" },
  ISSUE_QUOTE: { ar: "راجع العرض وأرسله", en: "Review and send the quotation" },
  EDIT_QUOTE: { ar: "عدّل العرض", en: "Edit the quotation" },
  REVISE_QUOTE: { ar: "عدّل العرض", en: "Revise the quotation" },
  REQUEST_APPROVAL: { ar: "اعتماد الخصم", en: "Approve the discount" },
  RECORD_REPLY: { ar: "سجّل رد العميل", en: "Record the customer's reply" },
  LOG_CALL: { ar: "سجّل مكالمة متابعة", en: "Log a follow-up call" },
  WIN: { ar: "توثيق الربح", en: "Mark won" },
  CREATE_ORDER: { ar: "إنشاء الطلب", en: "Create the order" },
  VIEW_ORDER: { ar: "عرض الطلب", en: "View the order" },
  DOCUMENT_LOSS: { ar: "توثيق سبب الخسارة", en: "Record the loss reason" },
  REOPEN: { ar: "إعادة فتح الصفقة", en: "Reopen the deal" },
  ADVANCE: { ar: "المرحلة التالية", en: "Next stage" },
};

const act = (key: DealActionKey, extra: Partial<DealAction> = {}): DealAction => ({ key, ...LABEL[key], ...extra });

export type NextStepQuote = {
  id: string;
  status: string;
  revision: number;
  discountApproval?: "NOT_NEEDED" | "PENDING" | "APPROVED" | "REJECTED" | null;
  issuedAt?: Date | string | null;
  validUntil?: Date | string | null;
  /** Orders raised from this quotation (`_count.orderLinks`). */
  orderLinks?: number;
  createdAt?: Date | string | null;
};

export type NextStepSample = {
  id: string;
  status: string;
  fromStock?: boolean;
  approval?: "NOT_NEEDED" | "PENDING" | "APPROVED" | "DECLINED" | null;
  sentAt?: Date | string | null;
};

export type NextStepDeal = {
  outcome: "OPEN" | "WON" | "LOST";
  hasCustomer: boolean;
  stagePurpose: StagePurpose | null;
  stageCode?: string;
  /** Whether there is an active stage after this one (a purpose-less stage moves on). */
  hasNextStage?: boolean;
  businessType: string | null;
  needSummary: string | null;
  agreedNextStep: string | null;
  samples: NextStepSample[];
  quotes: NextStepQuote[];
  /** The deal's open dated promises (activities), for the PLANNED follow-up. */
  openActivities?: { id: string; type: string; dueAt: Date | string | null; sourceKey?: string | null }[];
  /** The first order raised from the deal, if any. */
  orderId?: string | null;
};

export type DealNextStep = {
  phase: Phase;
  stageCode: string;
  stagePurpose: StagePurpose | null;
  quoteState: QuoteState;
  quoteStateLabel: { ar: string; en: string };
  quoteId?: string;
  quoteRevision?: number;
  requiredNow: { key: string; ar: string; en: string }[];
  nextAction: DealAction | null;
  secondary: DealAction[];
  followUp: { kind: "SAMPLE_FEEDBACK" | "QUOTE_REPLY" | "PLANNED"; dueAt: string; activityId?: string; sampleId?: string; quoteId?: string } | null;
};

const ts = (v: Date | string | null | undefined) => (v ? new Date(v).getTime() : 0);

/**
 * The quotation that speaks for the deal: the newest that is not SUPERSEDED, an ACCEPTED one first (an accepted
 * quotation beats a later draft — the customer said yes to it).
 */
export function currentQuote(quotes: readonly NextStepQuote[]): NextStepQuote | null {
  const live = quotes
    .filter((q) => q.status !== "SUPERSEDED")
    .sort((a, b) => b.revision - a.revision || ts(b.createdAt) - ts(a.createdAt));
  return live.find((q) => q.status === "ACCEPTED") ?? live[0] ?? null;
}

/** The quotation's sub-status inside the quotation stage (§2.2). Derived, never stored. */
export function quoteStateOf(q: NextStepQuote | null, now: Date): QuoteState {
  if (!q) return "NONE";
  switch (q.status) {
    case "DRAFT":
      if (q.discountApproval === "PENDING") return "AWAITING_DISCOUNT";
      if (q.discountApproval === "REJECTED") return "DISCOUNT_REFUSED";
      return q.revision > 1 ? "REVISING" : "DRAFT";
    case "ISSUED":
      return q.validUntil && new Date(q.validUntil).getTime() < now.getTime() ? "LAPSED" : "SENT";
    case "EXPIRED": return "LAPSED";
    case "REJECTED": return "REJECTED";
    case "ACCEPTED": return (q.orderLinks ?? 0) > 0 ? "ORDERED" : "ACCEPTED";
    default: return "NONE";
  }
}

const dayDiff = (from: number, to: number) => Math.floor((to - from) / DAY);

/** Phase of a deal: its outcome first (Closed), then its stage's purpose (legacy NEGOTIATION is the quotation step). */
export function phaseOf(outcome: NextStepDeal["outcome"], purpose: StagePurpose | null): Phase {
  if (outcome !== "OPEN") return "CLOSED";
  const p = effectivePurpose(purpose);
  return p === "SAMPLE_EVALUATION" ? "SAMPLES" : p === "QUOTATION" ? "QUOTE" : "QUALIFIED";
}

export function dealNextStep(deal: NextStepDeal, now: Date, viewer: { approveDiscount?: boolean; approveSamples?: boolean } = {}): DealNextStep {
  const purpose = deal.stagePurpose;
  const phase = phaseOf(deal.outcome, purpose);
  const q = currentQuote(deal.quotes);
  const state = quoteStateOf(q, now);
  const required: DealNextStep["requiredNow"] = [];
  const secondary: DealAction[] = [];
  let next: DealAction | null = null;
  const qid = q ? { quoteId: q.id } : {};
  const t = now.getTime();

  const live = deal.samples.filter((s) => s.status !== "CANCELLED");
  const sent = live.find((s) => s.status === "SENT");
  const sentDue = sent?.sentAt ? ts(sent.sentAt) + SAMPLE_FEEDBACK_DAYS * DAY : null;

  // ── The follow-up the deal waits on (one) ──
  let followUp: DealNextStep["followUp"] = null;
  if (deal.outcome === "OPEN") {
    if (q && state === "SENT" && q.issuedAt) {
      followUp = { kind: "QUOTE_REPLY", dueAt: quoteFollowUpDue({ issuedAt: q.issuedAt, validUntil: q.validUntil ?? null }, now).toISOString(), quoteId: q.id };
    } else if (sent && sentDue !== null) {
      const a = deal.openActivities?.find((x) => x.sourceKey === `sample:${sent.id}`);
      followUp = { kind: "SAMPLE_FEEDBACK", dueAt: new Date(sentDue).toISOString(), sampleId: sent.id, ...(a ? { activityId: a.id } : {}) };
    } else {
      const planned = (deal.openActivities ?? [])
        .filter((x) => x.dueAt && x.type !== "SAMPLE_FOLLOW_UP")
        .sort((a, b) => ts(a.dueAt) - ts(b.dueAt))[0];
      if (planned) followUp = { kind: "PLANNED", dueAt: new Date(planned.dueAt!).toISOString(), activityId: planned.id };
    }
  }

  const base = { phase, stageCode: deal.stageCode ?? "", stagePurpose: purpose, quoteState: state, quoteStateLabel: labelOf(state, q), ...(q ? { quoteId: q.id, quoteRevision: q.revision } : {}) };
  const done = (): DealNextStep => ({ ...base, requiredNow: required.slice(0, 3), nextAction: next, secondary: secondary.slice(0, 2), followUp });

  // ── Closed ──
  if (deal.outcome === "WON") {
    if (state === "ACCEPTED" && q) {
      required.push({ key: "CREATE_ORDER", ar: "أنشئ الطلب من العرض المعتمد", en: "Create the order from the accepted quotation" });
      next = act("CREATE_ORDER", { quoteId: q.id });
    } else if (deal.orderId) {
      secondary.push(act("VIEW_ORDER", { orderId: deal.orderId }));
    }
    return done();
  }
  if (deal.outcome === "LOST") {
    secondary.push(act("REOPEN"));
    return done();
  }

  // ── Open: an accepted quotation with a customer makes winning the action, wherever the deal is ──
  if ((state === "ACCEPTED" || state === "ORDERED") && q) {
    if (deal.hasCustomer) {
      required.push({ key: "WIN", ar: "العميل وافق على العرض — سجّل الربح", en: "The customer accepted — mark the deal won" });
      next = act("WIN", { quoteId: q.id });
    } else {
      required.push({ key: "LINK_CUSTOMER", ar: "اربط عميلًا بالصفقة لتسجيل الربح", en: "Link a customer to the deal to mark it won" });
    }
    return done();
  }

  // ── A quotation already in play decides, whatever stage the deal shows ──
  const quoteInPlay = ["REVISING", "AWAITING_DISCOUNT", "DISCOUNT_REFUSED", "SENT", "LAPSED", "REJECTED"].includes(state);
  if (phase === "QUOTE" || quoteInPlay) {
    quoteRules(state, q, now, required, secondary, viewer, (a) => { next = a; });
    return done();
  }

  // ── A stage with no purpose (not aligned): move on, as before v2 ──
  if (!effectivePurpose(purpose)) {
    if (deal.hasNextStage) next = act("ADVANCE");
    else if (state === "DRAFT" && q) next = act("ISSUE_QUOTE", qid);
    return done();
  }

  // ── Qualified opportunity, or Sample evaluation ──
  const missing = qualificationMissing(deal);
  if (phase === "QUALIFIED" && missing.length > 0) {
    const names = missing.map((m) => QUALIFICATION_FIELD_LABELS[m]);
    required.push({ key: "NEEDS", ar: `أكمل تحليل الاحتياج: ${names.map((n) => n.ar).join("، ")}`, en: `Complete the needs analysis: ${names.map((n) => n.en).join(", ")}` });
    next = act("RECORD_NEEDS");
    if (live.length === 0) secondary.push(act("SKIP_SAMPLES"));
    return done();
  }

  if (live.length > 0) {
    sampleRules(live, sent, sentDue, t, state, q, required, secondary, (a) => { next = a; }, viewer);
    return done();
  }
  if (state === "DRAFT" && q) {
    required.push({ key: "SEND_DRAFT", ar: "أكمل العرض وأرسله", en: "Finish the quotation and send it" });
    next = act("ISSUE_QUOTE", qid);
    secondary.push(act("REQUEST_SAMPLE"));
    return done();
  }
  if (phase === "QUALIFIED") {
    required.push({ key: "SAMPLE_OR_SKIP", ar: "اطلب عيّنة أو حدّد أن العميل لا يحتاجها", en: "Request a sample, or record that the customer needs none" });
  } else {
    required.push({ key: "SAMPLE_OR_SKIP", ar: "اطلب عيّنة أو تخطّ العيّنات", en: "Request a sample, or skip the samples" });
  }
  next = act("REQUEST_SAMPLE");
  secondary.push(act("SKIP_SAMPLES"));
  if (phase === "QUALIFIED") secondary.push(act("CREATE_QUOTE"));
  return done();
}

function labelOf(state: QuoteState, q: NextStepQuote | null): { ar: string; en: string } {
  const l = QUOTE_STATE_LABELS[state];
  if (state === "REVISING" && q) return { ar: `${l.ar} (نسخة ${q.revision})`, en: `${l.en} (version ${q.revision})` };
  return l;
}

function sampleRules(
  live: NextStepSample[], sent: NextStepSample | undefined, sentDue: number | null, t: number,
  state: QuoteState, q: NextStepQuote | null,
  required: DealNextStep["requiredNow"], secondary: DealAction[], setNext: (a: DealAction) => void,
  viewer: { approveSamples?: boolean } = {},
) {
  if (sent) {
    const left = sentDue !== null ? Math.ceil((sentDue - t) / DAY) : SAMPLE_FEEDBACK_DAYS;
    required.push(left > 0
      ? { key: "SAMPLE_FEEDBACK", ar: `سجّل رأي العميل في العيّنة (متوقع خلال ${arDays(left)})`, en: `Record the customer's view of the sample (expected within ${enDays(left)})` }
      : left === 0
        ? { key: "SAMPLE_FEEDBACK", ar: "سجّل رأي العميل في العيّنة (متوقع اليوم)", en: "Record the customer's view of the sample (expected today)" }
        : { key: "SAMPLE_FEEDBACK", ar: `سجّل رأي العميل في العيّنة (متأخر ${arDays(-left)})`, en: `Record the customer's view of the sample (${enDays(-left)} late)` });
    setNext(act("RECORD_SAMPLE_EVALUATION", { sampleId: sent.id }));
    secondary.push(state === "DRAFT" && q ? act("ISSUE_QUOTE", { quoteId: q.id }) : act("CREATE_QUOTE"));
    return;
  }
  const recordOnly = live.find((s) => s.status === "PREPARING" && !s.fromStock);
  if (recordOnly) {
    required.push({ key: "SEND_SAMPLE", ar: "أرسل العيّنة", en: "Send the sample" });
    setNext(act("SEND_SAMPLE", { sampleId: recordOnly.id }));
    return;
  }
  const waiting = live.find((s) => s.status === "REQUESTED" || s.status === "PREPARING");
  if (waiting) {
    const approval = waiting.approval === "PENDING";
    required.push(approval
      ? { key: "SAMPLE_APPROVAL", ar: "العيّنة بانتظار اعتماد المدير", en: "The sample awaits the manager's approval" }
      : { key: "SAMPLE_DISPATCH", ar: "العيّنة بانتظار الصرف من قسم الشحن", en: "The sample awaits dispatch" });
    // أبو فهد B7: the approver (sales manager / admin) is offered the decision itself — «وافق / ارفض» — never a grey wait.
    setNext(approval
      ? (viewer.approveSamples
        ? act("APPROVE_SAMPLE", { sampleId: waiting.id, ar: "وافق", en: "Approve" })
        : act("WAIT_SAMPLE", { sampleId: waiting.id, disabled: true, ar: "بانتظار اعتماد المدير", en: "Awaiting the manager's approval" }))
      : act("WAIT_SAMPLE", { sampleId: waiting.id, disabled: true }));
    if (approval && viewer.approveSamples) secondary.push(act("DECLINE_SAMPLE", { sampleId: waiting.id, ar: "ارفض", en: "Decline" }));
    secondary.push(state === "DRAFT" && q ? act("ISSUE_QUOTE", { quoteId: q.id }) : act("CREATE_QUOTE"));
    return;
  }
  // Every live sample has its evaluation: the quotation is next.
  required.push({ key: "PREPARE_QUOTE", ar: "جهّز عرض السعر", en: "Prepare the quotation" });
  setNext(state === "DRAFT" && q ? act("ISSUE_QUOTE", { quoteId: q.id }) : act("CREATE_QUOTE"));
}

function quoteRules(
  state: QuoteState, q: NextStepQuote | null, now: Date,
  required: DealNextStep["requiredNow"], secondary: DealAction[], viewer: { approveDiscount?: boolean },
  setNext: (a: DealAction) => void,
) {
  const qid = q ? { quoteId: q.id } : {};
  const t = now.getTime();
  switch (state) {
    case "NONE":
      required.push({ key: "CREATE_QUOTE", ar: "أنشئ عرض السعر وأرسله للعميل", en: "Create the quotation and send it to the customer" });
      setNext(act("CREATE_QUOTE"));
      secondary.push(act("DOCUMENT_LOSS"));
      return;
    case "DRAFT":
      required.push({ key: "SEND_DRAFT", ar: "أكمل العرض وأرسله", en: "Finish the quotation and send it" });
      setNext(act("ISSUE_QUOTE", qid));
      secondary.push(act("DOCUMENT_LOSS"));
      return;
    case "REVISING":
      required.push({ key: "SEND_REVISION", ar: `أرسل النسخة ${q?.revision ?? ""}`.trim(), en: `Send version ${q?.revision ?? ""}`.trim() });
      setNext(act("ISSUE_QUOTE", { ...qid, ar: `أرسل النسخة ${q?.revision ?? ""}`.trim(), en: `Send version ${q?.revision ?? ""}`.trim() }));
      secondary.push(act("DOCUMENT_LOSS"));
      return;
    case "AWAITING_DISCOUNT":
      required.push({ key: "DISCOUNT_PENDING", ar: "بانتظار اعتماد الخصم", en: "The discount awaits approval" });
      setNext(viewer.approveDiscount
        ? act("REQUEST_APPROVAL", qid)
        : act("REQUEST_APPROVAL", { ...qid, disabled: true, ar: "بانتظار اعتماد الخصم", en: "Awaiting the discount approval" }));
      return;
    case "DISCOUNT_REFUSED":
      required.push({ key: "DISCOUNT_REFUSED", ar: "رُفض الخصم — عدّل العرض", en: "The discount was refused — edit the quotation" });
      setNext(act("EDIT_QUOTE", qid));
      secondary.push(act("DOCUMENT_LOSS"));
      return;
    case "SENT": {
      const since = q?.issuedAt ? Math.max(0, dayDiff(new Date(q.issuedAt).getTime(), t)) : 0;
      required.push(since === 0
        ? { key: "AWAIT_REPLY", ar: "مُرسل — بانتظار رد العميل (أُرسل اليوم)", en: "Sent — awaiting the customer's reply (sent today)" }
        : { key: "AWAIT_REPLY", ar: `مُرسل — بانتظار رد العميل (منذ ${arDays(since)})`, en: `Sent — awaiting the customer's reply (${enDays(since)})` });
      if (q?.validUntil) {
        const left = Math.ceil((new Date(q.validUntil).getTime() - t) / DAY);
        if (left <= 2) required.push(left <= 0
          ? { key: "EXPIRES_SOON", ar: "ينتهي العرض اليوم", en: "The quotation expires today" }
          : { key: "EXPIRES_SOON", ar: `ينتهي العرض بعد ${arDays(left)}`, en: `The quotation expires in ${enDays(left)}` });
      }
      setNext(act("RECORD_REPLY", qid));
      secondary.push(act("LOG_CALL"), act("REVISE_QUOTE", qid));
      return;
    }
    case "LAPSED":
      required.push({ key: "LAPSED", ar: "انتهت صلاحية العرض — عدّله وأرسله من جديد", en: "The quotation lapsed — revise and send it again" });
      setNext(act("REVISE_QUOTE", qid));
      secondary.push(act("DOCUMENT_LOSS"));
      return;
    case "REJECTED":
      required.push({ key: "REJECTED", ar: "رفض العميل العرض — عدّله أو وثّق الخسارة", en: "The customer rejected the quotation — revise it, or record the loss" });
      setNext(act("REVISE_QUOTE", qid));
      secondary.push(act("DOCUMENT_LOSS", qid));
      return;
    default:
      return;
  }
}
