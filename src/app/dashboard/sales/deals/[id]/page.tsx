"use client";

import { halalas } from "@/lib/format/money";
import { displayPhone, waDigits } from "@/lib/contact/phone";
import { useState, useEffect, useRef, use } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import {
  useLang, pick, Alert, Spinner, Button, Field, TextInput, Select, TextArea, Modal, api,
  QUOTE_STATUS_SPECS, LEAD_SOURCE_LABELS,
} from "../../_components/ui";
import { Ico } from "@/components/shell/icons";
import { useD21Title, usePhone, useD21Phone, useCreateRequest } from "@/components/shell/page-context";
import { splitTitle } from "@/components/d21/labels";
import { ACTIVITY_OUTCOMES } from "@/lib/services/sales/qualification";
import {
  dayCount, daysFromToday, dueText, longDate, money2, relativeDays, shortDate,
} from "@/components/d21/format";
import { CollectionsPanel, type CollectionRow, type Summary } from "./CollectionsPanel";
import { NeedsDialog } from "./PipelinePanels";
import { parseSampleSkip, type StagePurpose } from "@/lib/services/sales/stages";
import { QUALIFICATION_FIELD_LABELS, BUSINESS_TYPE_LABELS, qualificationMissing, type BusinessType } from "@/lib/services/sales/needs";
import type { DealNextStep, DealAction } from "@/lib/services/sales/next-step";
import {
  Chip, QUOTE_TONE, StageStepper, AutoToast, SkipSamplesSheet, LossSheet, FollowUpSheet, MoveSheet, DecideMoveSheet,
  autoWhy, humanReason, isAutoReason, type Step,
} from "../../_components/pv2";
import { SampleDialog } from "../../_components/SampleDialog";
import { NewCustomerDialog, type CreatedCustomer } from "@/components/customers/new-customer-form";
import { useUser } from "../../../user-context";
import { riyadhDayOf } from "@/lib/dates/not-past";


/** FOLLOWUPS sales UI bug 4: a product's Arabic name on the Arabic screen (its English name, else its code, otherwise). */
function skuName(sku: { skuCode: string; name: string | null; nameAr?: string | null } | null | undefined, ar: boolean): string | null {
  if (!sku) return null;
  return (ar ? sku.nameAr || sku.name : sku.name) || sku.skuCode;
}

/**
 * Pipeline v2 (Figma page 08: 02a `1766:603` · 02b `1767:810` · 02c `1768:1038` · 02d `1769:1264` · 02e `1769:1850`,
 * phone `1766:965` …, annotations `1773:1674`): header with «⋯», the stage stepper (a skipped sample stage dashed),
 * then «المطلوب منك الآن» — ONE primary button and at most two links, all from the server's `nextStep` — the stage's
 * own panel (needs, samples, the current quotation with its versions), the ONE follow-up, and the timeline that tags
 * automatic moves «تلقائي»; the deal's details, samples/quotations and contacts beside it. A manual move by a rep is a
 * request a supervisor approves (owner decision 3): its banner sits above «المطلوب منك الآن».
 *
 * Earlier: built to the approved frame `crm-deal` (Figma `176:1032` / `177:1168`;
 * markup `docs/design/direction-2.1-rc/src/crm.py` `deal()`), in its order:
 * header (title, outcome · owner · created; lose · log activity · next stage) → four
 * metrics → stage tracker → next step → quotations, samples and the activity timeline,
 * with the customer and the deal's details beside them.
 *
 * Functions the frame does not draw keep a place next to the thing they act on rather than
 * a button row of their own: edit beside «التفاصيل», the split beside «توزيع العمولة»,
 * collections under the quotations once one is accepted, win as the primary action once
 * there is an accepted quotation or no further stage. The placements are listed in
 * docs/implementation/CRM-BATCH-0-1.md (visual correction, conflicts).
 */

type Deal = {
  id: string;
  title: string;
  outcome: "OPEN" | "WON" | "LOST";
  lostReason: string | null;
  lostReasonCode?: string | null;
  closedAt: string | null;
  /** «تحليل الاحتياج» (20261204100000_pipeline_qualification). */
  businessType: string | null;
  needSummary: string | null;
  expectedMonthlyKg: string | null;
  agreedNextStep: string | null;
  amount: string;
  /** Soon batch round 2: the latest rejected / expired quotation while the deal has no live one (from the Quote table). */
  lastClosedQuote?: { id: string; quoteNumber: string; status: string; grandTotal: string; currency: string } | null;
  currency: string;
  probability: number;
  expectedCloseAt: string | null;
  nextFollowUpAt: string | null;
  createdAt: string;
  stage: { id: string; code: string; nameEn: string; nameAr: string; probability: number; purpose?: StagePurpose | null };
  customer: { id: string; name: string; nameAr: string | null; phone: string | null; email: string | null } | null;
  /** The customer file's balance figure (services/customers/balance.ts). */
  customerBalance?: { outstanding: string; documents: number; ar: { outstanding: string } | null } | null;
  owner: { id: string; name: string } | null;
  owners: { id: string; sharePercent: string; effectiveFrom: string; employee: { id: string; name: string } }[];
  conversion: { leadId: string; convertedAt: string; convertedById: string | null; lead: { companyName: string; contactName: string; phone: string | null; source: string } } | null;
  quotes: {
    id: string; quoteNumber: string; revision: number; status: string; currency: string;
    validUntil: string | null; grandTotal: string; taxTotal: string; issuedAt: string | null; acceptedAt: string | null;
    lines: { taxRatePercent: string }[];
    _count: { lines: number; orderLinks: number };
    /** The discount-approval state, as the quotation screens compute it. */
    discountApproval?: "NOT_NEEDED" | "PENDING" | "APPROVED" | "REJECTED";
  }[];
  samples: {
    id: string; description: string | null; quantity: string; unit: string; status: string;
    sentAt: string | null; feedbackScore: number | null; feedbackNotes: string | null;
    /** Issued from finished stock by dispatch (a product in units); false = record-only, moves no stock. */
    fromStock?: boolean; issuedAt?: string | null;
    /** «للعميل من كل محصول عيّنة واحدة»: a second sample of the product and the manager's decision on it. */
    approval?: "NOT_NEEDED" | "PENDING" | "APPROVED" | "DECLINED"; approvalNote?: string | null;
    productSku: { id: string; skuCode: string; name: string | null; nameAr?: string | null } | null;
  }[];
  activities: {
    id: string; type: string; subject: string; body: string | null; outcome: string | null;
    dueAt: string | null; completedAt: string | null; createdAt: string;
    owner: { id: string; name: string } | null;
  }[];
  stageEvents: {
    id: string; reason: string | null; createdAt: string; toOutcome: string | null;
    fromStageId: string | null; toStageId: string | null; actorId: string | null;
    toStage: { nameEn: string; nameAr: string } | null;
  }[];
  orderLinks: {
    id: string; isFirstOrder: boolean; createdAt: string;
    order: { id: string; orderNumber: number; status: string };
  }[];
};

type Stage = { id: string; code: string; nameEn: string; nameAr: string; position: number; probability: number; isActive: boolean; purpose?: StagePurpose | null };

type Can = {
  write: boolean; close: boolean; reopen: boolean; quote: boolean;
  approveDiscount: boolean; assign: boolean; createOrder: boolean;
  /** Approves a customer's second sample of a product (sales manager / admin). */
  approveSample?: boolean;
  /** D22: «إرسال عيّنة» (the invoice page's sample mode) and turning a customer-less deal into a customer first. */
  sendSample?: boolean; makeCustomer?: boolean;
  submitCollection?: boolean; verifyCollection?: boolean;
  rejectCollection?: boolean; reverseCollection?: boolean;
};


// A stock sample (docs/sales/SAMPLES_INVENTORY.md) reads requested → being prepared → sent: the rep asks, the
// dispatch department prepares and issues it from stock. A record-only sample keeps «قيد التحضير» → «أُرسلت».
const SAMPLE_LABELS: Record<string, { en: string; ar: string }> = {
  REQUESTED: { en: "Requested · awaiting dispatch", ar: "مطلوبة · بانتظار الشحن" },
  PREPARING: { en: "Preparing", ar: "قيد التحضير" },
  SENT: { en: "Sent", ar: "أُرسلت" },
  FEEDBACK_RECEIVED: { en: "Feedback received", ar: "وصل التقييم" },
  CANCELLED: { en: "Cancelled", ar: "ملغاة" },
};
// A customer's second sample of a product waits for the sales manager (owner decision «للعميل من كل محصول عيّنة واحدة»):
// shown instead of the status while it waits, and beside it once decided.
const SAMPLE_APPROVAL_LABELS: Record<string, { en: string; ar: string }> = {
  PENDING: { en: "Awaiting the manager's approval", ar: "بانتظار موافقة المدير" },
  APPROVED: { en: "second sample · approved by the manager", ar: "عيّنة ثانية · وافق عليها المدير" },
  DECLINED: { en: "declined by the manager", ar: "رفضها المدير" },
};

/** Same wording as the lead page's outcome list (`leads/[id]/page.tsx`). */
const OUTCOME_LABELS: Record<string, { en: string; ar: string }> = {
  NO_ANSWER: { en: "No answer", ar: "لا رد" },
  LEFT_MESSAGE: { en: "Left a message", ar: "تُركت رسالة" },
  INTERESTED: { en: "Spoke — interested", ar: "تواصل ناجح — مهتم" },
  MEETING_SCHEDULED: { en: "Meeting scheduled", ar: "حُدِّد موعد اجتماع مع العميل" },
  VISIT_SCHEDULED: { en: "Visit scheduled", ar: "حُدِّد موعد زيارة للعميل" },
  MEETING_COMPLETED: { en: "Meeting held", ar: "تم الاجتماع" },
  VISIT_COMPLETED: { en: "Visit made", ar: "تمت الزيارة" },
  FOLLOW_UP_REQUIRED: { en: "Needs a follow-up", ar: "يحتاج متابعة" },
  NOT_INTERESTED: { en: "Not interested", ar: "غير مهتم" },
  NOTE_ONLY: { en: "Note / internal task", ar: "ملاحظة أو مهمة داخلية" },
};

const UNIT_LABELS: Record<string, { en: string; ar: string }> = {
  KG: { en: "kg", ar: "كجم" }, G: { en: "g", ar: "غ" }, PCS: { en: "pcs", ar: "قطعة" },
  GRAM: { en: "g", ar: "غ" }, UNIT: { en: "units", ar: "عبوة" },
};

const ACTIVITY_LABELS: Record<string, { en: string; ar: string }> = {
  CALL: { en: "Call", ar: "مكالمة" }, // CRM.md D6
  VISIT: { en: "Visit", ar: "زيارة" },
  MEETING: { en: "Meeting", ar: "اجتماع" },
  NOTE: { en: "Note", ar: "ملاحظة" },
  TASK: { en: "Task", ar: "مهمة" },
  SAMPLE_FOLLOW_UP: { en: "Sample follow-up", ar: "متابعة عينة" },
  WHATSAPP: { en: "WhatsApp", ar: "واتساب" },
  EMAIL: { en: "Email", ar: "بريد" },
};

type HeldOrder = { id: string; orderNumber: number; paymentHold: string | null; topUpPending: boolean; short: string | null; needsRep: boolean };

export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Abu Fahd R4 F1: «سجّل تحصيل» from a normal order's panel lands here with ?collect=<orderId> — the form opens on it.
  const collectFor = useSearchParams().get("collect");
  const lang = useLang();
  const ar = lang === "ar";

  const [deal, setDeal] = useState<Deal | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  // Employee names for the history lines whose record names who did it.
  const [actors, setActors] = useState<Record<string, string>>({});
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const meId = useUser()?.id ?? null;
  const [collectionSummary, setCollectionSummary] = useState<Summary | null>(null);
  const [heldOrder, setHeldOrder] = useState<HeldOrder | null>(null);
  const [dealOrders, setDealOrders] = useState<{ id: string; orderNumber: number; held: boolean }[]>([]);
  // The server's verdict on whether this person may record a collection here, and if not
  // why. Not derived on the client: see `collectionAction` in services/sales/collections.
  const [collectionAction, setCollectionAction] =
    useState<{ available: boolean; reason: string }>({ available: false, reason: "NO_PRIVILEGE" });
  const [can, setCan] = useState<Can | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  const [dialog, setDialog] = useState<"activity" | "sample" | "close" | "edit" | "splits" | "needs" | "skip" | "followup" | "move" | "decide" | null>(null);
  // Pipeline v2: the server's answer to «what now?», and a manual move waiting for (or refused by) a supervisor.
  const [ns, setNs] = useState<DealNextStep | null>(null);
  const [pendingMove, setPendingMove] = useState<{ id: string; toStageId: string; toStage: { nameAr: string; nameEn: string } | null; reason: string | null; requestedBy: string | null; createdAt: string; canDecide: boolean; canWithdraw: boolean } | null>(null);
  const [rejectedMove, setRejectedMove] = useState<{ id: string; toStage: { nameAr: string; nameEn: string } | null; note: string | null; decidedBy: string | null; decidedAt: string } | null>(null);
  const [moveDirect, setMoveDirect] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [toast, setToast] = useState<{ title: string; why: string } | null>(null);
  // The sample whose customer evaluation is being recorded («تسجيل النتيجة»).
  const [feedbackFor, setFeedbackFor] = useState<Deal["samples"][number] | null>(null);
  // «للعميل من كل محصول عيّنة واحدة»: the coffee products this customer already had a sample of (the dialog warns),
  // and the second sample a manager is declining (the reason is asked for).
  const [sampledProducts, setSampledProducts] = useState<string[]>([]);
  const [declineFor, setDeclineFor] = useState<Deal["samples"][number] | null>(null);
  // D22 gate (owner 1أ / 4أ): the manager's approval note; a customer-less deal made a customer before its sample.
  const [approveFor, setApproveFor] = useState<Deal["samples"][number] | null>(null);
  const [toCustomer, setToCustomer] = useState<null | "ask" | "form">(null);
  // The stage a refused move was headed for (409 SAMPLE_SKIP_REASON_REQUIRED), set with the skip dialog.
  const [skipTarget, setSkipTarget] = useState<{ id: string; nameAr: string; nameEn: string } | null>(null);
  // The timeline used to stop at twenty with no sign that there were more (IMD-04).
  const [allEntries, setAllEntries] = useState(false);
  // Phone (below 768): the 390 frame `178:1285`, with its «⋯» menu in the sticky bar.
  const phone = usePhone();
  const [more, setMore] = useState(false);

  /**
   * Reload counter. The fetch lives in the effect; mutations refresh by bumping this, and
   * `cancelled` stops a slow response landing after a newer one.
   */
  const [reloadToken, setReloadToken] = useState(0);
  // Where the deal was on the previous load: an automatic move since then is announced once (annotation 2).
  const prevStage = useRef<string | null>(null);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<{
        deal: Deal; stages: Stage[]; actors: Record<string, string>; can: Can;
        collections: CollectionRow[]; collectionSummary: Summary; heldOrder?: HeldOrder | null; dealOrders?: { id: string; orderNumber: number; held: boolean }[];
        collectionAction: { available: boolean; reason: string };
        sampledProductIds?: string[];
        nextStep?: DealNextStep; pendingMove?: typeof pendingMove; rejectedMove?: typeof rejectedMove;
      }>(`/api/sales/opportunities/${id}`);
      if (cancelled) return;
      if (res.ok) {
        const d = res.data.deal;
        if (prevStage.current && prevStage.current !== d.stage.id) {
          const ev = d.stageEvents.find((e) => e.toStageId === d.stage.id && e.fromStageId);
          if (ev && isAutoReason(ev.reason)) {
            setToast({ title: ar ? `انتقلت الصفقة إلى ${d.stage.nameAr}` : `The deal moved to ${d.stage.nameEn}`, why: autoWhy(ev.reason, ar) ?? "" });
          }
        }
        prevStage.current = d.stage.id;
        setDeal(d);
        setSampledProducts(res.data.sampledProductIds ?? []);
        setStages(res.data.stages);
        setActors(res.data.actors ?? {});
        setCan(res.data.can);
        setNs(res.data.nextStep ?? null);
        setPendingMove(res.data.pendingMove ?? null);
        setRejectedMove(res.data.rejectedMove ?? null);
        setMoveDirect(!!(res.data.can as Can & { moveDirectly?: boolean }).moveDirectly);
        setCollections(res.data.collections ?? []);
        setCollectionSummary(res.data.collectionSummary ?? null);
        setHeldOrder(res.data.heldOrder ?? null);
        setDealOrders(res.data.dealOrders ?? []);
        setCollectionAction(res.data.collectionAction ?? { available: false, reason: "NO_PRIVILEGE" });
        setError("");
      } else {
        setError(res.data.error ?? (ar ? "تعذّر تحميل الصفقة." : "Could not load the deal."));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, ar, reloadToken]);

  // The last crumb is the deal's name, as in the reference trail «المبيعات / الصفقات / …».
  useD21Title(deal?.title);
  // The phone header of the frame: the customer as the title, «صفقة · <the rest of the deal's
  // name>» under it, and a back arrow to the pipeline. Without a customer the deal names itself.
  const phoneCustomer = deal?.customer ? (ar ? (deal.customer.nameAr ?? deal.customer.name) : deal.customer.name) : null;
  const phoneRest = deal && phoneCustomer ? splitTitle(deal.title, phoneCustomer).sub : "";
  useD21Phone({
    title: phoneCustomer ?? deal?.title ?? "",
    sub: deal ? `${ar ? "صفقة" : "Deal"}${phoneRest ? ` · ${phoneRest}` : ""}` : undefined,
    back: "/dashboard/sales/pipeline",
  });
  // Batch 24 WP-A: «عيّنة» from the customer page lands here with ?new=sample — the existing request form
  // (one sample per product, the manager's approval for a second) opens on arrival.
  // D22 gate (owner's workflow «إرسال عيّنة ← صفحة الفاتورة الضريبية»): a sample is sent from the tax invoice page in its sample
  // mode, on this deal's customer and on this deal. The old request dialog (SampleDialog) stays in the code, linked from nowhere.
  const router = useRouter();
  const sampleFor = (customerId: string) => `/dashboard/sales/invoices/new?mode=sample&customerId=${encodeURIComponent(customerId)}&opportunityId=${encodeURIComponent(deal!.id)}`;
  const sampleHref = deal?.customer?.id ? sampleFor(deal.customer.id) : null;
  // A deal with no customer (a prospect's): «حوّله لعميل» first (owner 1أ), then the sample on the new customer and this deal.
  const openSample = () => { if (sampleHref) router.push(sampleHref); else setToCustomer("ask"); };
  const maySample = !!can?.write && !!can?.sendSample;
  useCreateRequest("sample", openSample, !!deal && maySample && deal.outcome === "OPEN");
  const madeCustomer = async (c: CreatedCustomer) => {
    const res = await api<{ error?: string; errorEn?: string }>(`/api/sales/opportunities/${encodeURIComponent(id)}`, { method: "PATCH", body: { customerId: c.id } });
    if (!res.ok) { setToCustomer(null); setError((ar ? res.data.error : res.data.errorEn ?? res.data.error) ?? ""); return; }
    setToCustomer(null);
    router.push(sampleFor(c.id));
  };
  useEffect(() => {
    if (!more) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[data-deal-more]")) setMore(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMore(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [more]);

  async function transition(body: Record<string, unknown>, okMessage: string) {
    if (busy) return;
    setBusy(true);
    setError(""); setDialogError(""); setSuccess("");
    const res = await api<{ code?: string; pending?: boolean; stageAdvanced?: boolean }>(`/api/sales/opportunities/${id}/transition`, { method: "POST", body });
    setBusy(false);
    // Moving past Sample Evaluation with no sample: the server asks for the documented skip — the
    // «العميل ما يحتاج عينات» sheet, which sends `skipSamples` with its coded reason.
    if (!res.ok && res.data.code === "SAMPLE_SKIP_REASON_REQUIRED") {
      const target = typeof body.toStageId === "string" ? stages.find((s) => s.id === body.toStageId) : undefined;
      setSkipTarget(target ? { id: target.id, nameAr: target.nameAr, nameEn: target.nameEn } : null);
      setDialog("skip");
      return false;
    }
    if (!res.ok) {
      const msg = res.data.error ?? (ar ? "تعذّر التنفيذ." : "Could not do that.");
      // A dialog stays open with what was typed (annotation 5); the message shows inside it.
      if (dialog) setDialogError(msg); else setError(msg);
      return false;
    }
    // A rep's manual move is a request (202): nothing moved yet.
    setSuccess(res.data.pending
      ? (ar ? "أُرسل طلب النقل إلى المشرف؛ تبقى الصفقة في مرحلتها حتى يعتمده." : "Move request sent; the deal stays where it is until a supervisor approves.")
      : okMessage);
    setDialog(null);
    reload();
    return true;
  }

  /** The supervisor's decision on a pending move, or the requester withdrawing it. */
  async function decideMove(decision: "APPROVE" | "REJECT" | "WITHDRAW", note?: string) {
    if (!pendingMove || busy) return;
    setBusy(true); setDialogError(""); setError("");
    const res = decision === "WITHDRAW"
      ? await api(`/api/sales/stage-move-requests/${pendingMove.id}`, { method: "DELETE" })
      : await api(`/api/sales/stage-move-requests/${pendingMove.id}`, { method: "POST", body: { decision, note } });
    setBusy(false);
    if (!res.ok) { const m = res.data.error ?? (ar ? "تعذّر التنفيذ." : "Could not do that."); if (dialog) setDialogError(m); else setError(m); return; }
    setDialog(null);
    setSuccess(decision === "APPROVE" ? (ar ? "اعتُمد النقل ونُقلت الصفقة." : "Move approved; the deal moved.")
      : decision === "REJECT" ? (ar ? "رُفض طلب النقل؛ بقيت الصفقة مكانها." : "Move rejected; the deal stays put.")
        : (ar ? "سُحب طلب النقل." : "Move request withdrawn."));
    reload();
  }

  /** «جدولة متابعة»: the deal's ONE follow-up, moved — never a second (PATCH; services/sales/follow-through.ts). */
  async function scheduleFollowUp(at: Date, subject: string) {
    if (busy) return;
    setBusy(true); setDialogError("");
    const res = await api(`/api/sales/opportunities/${id}`, { method: "PATCH", body: { nextFollowUpAt: at.toISOString(), followUpSubject: subject } });
    setBusy(false);
    if (!res.ok) { setDialogError(res.data.error ?? (ar ? "تعذّر الحفظ." : "Could not save.")); return; }
    setDialog(null);
    setSuccess(ar ? "حُفظت المتابعة." : "Follow-up saved.");
    reload();
  }

  async function complete(activityId: string) {
    setBusy(true);
    const res = await api(`/api/sales/activities/${activityId}`, { method: "PATCH", body: { completed: true } });
    setBusy(false);
    if (res.ok) reload();
    else setError(res.data.error ?? "");
  }

  if (loading) return <div className="pg"><Spinner /></div>;
  if (!deal || !can) {
    return (
      <div className="pg">
        <p className="notice er" role="alert" data-testid="alert-error">{error || (ar ? "الصفقة غير موجودة." : "Deal not found.")}</p>
        <p style={{ marginTop: 16 }}>
          <Link href="/dashboard/sales/pipeline" className="btn">{ar ? "العودة إلى مسار الصفقات" : "Back to the pipeline"}</Link>
        </p>
      </div>
    );
  }

  const L = (x: { ar: string; en: string } | { nameAr: string; nameEn: string }) =>
    "ar" in x ? (ar ? x.ar : x.en) : (ar ? x.nameAr : x.nameEn);
  const open = deal.outcome === "OPEN";
  const acceptedQuote = deal.quotes.find((q) => q.status === "ACCEPTED");
  const qty = (q: string, unit: string) =>
    `${unit === "KG" ? money2(q) : q} ${UNIT_LABELS[unit] ? pick(UNIT_LABELS, unit, lang) : unit}`;

  // ── Stages: the ordered active ones, plus the deal's own if it has since been retired.
  const shown = stages.filter((s) => s.isActive || s.id === deal.stage.id).sort((a, b) => a.position - b.position);
  const atIdx = shown.findIndex((s) => s.id === deal.stage.id);
  const stageById = new Map(stages.map((s) => [s.id, s]));
  // When the deal reached each stage: the latest event into it.
  const reached = new Map<string, string>();
  for (const e of deal.stageEvents) if (e.toStageId && !reached.has(e.toStageId)) reached.set(e.toStageId, e.createdAt);
  const inStageSince = reached.get(deal.stage.id) ?? deal.createdAt;
  const inStageDays = Math.max(0, -daysFromToday(inStageSince));

  // ── The one next step: the open activity due soonest; an undated one only if nothing is dated.
  const openActivities = deal.activities.filter((a) => !a.completedAt);
  const soonest = [...openActivities].sort((a, b) =>
    (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity))[0];
  // Pipeline v2: the ONE follow-up is the server's (`nextStep.followUp`); a quotation's reply date has no task of its own.
  const nextStep = (ns?.followUp?.activityId ? openActivities.find((a) => a.id === ns.followUp!.activityId) : undefined)
    ?? (ns?.followUp && ns.followUp.kind !== "PLANNED" ? undefined : soonest);

  // ── «المطلوب منك الآن»: the server's action → the control, gated by what this person may do ──
  const quoteHref = (qid?: string) => (qid ? `/dashboard/sales/quotes/${qid}` : `/dashboard/sales/quotes/new?opportunityId=${deal.id}`);
  /** Why an action is shown disabled for THIS person (annotation 5, «صلاحية»), or null when allowed. */
  const blockedBy = (k: DealAction["key"]): string | null => {
    switch (k) {
      case "WIN": return can.close ? (deal.customer ? null : (ar ? "اربط عميلًا بالصفقة أولًا" : "Link a customer first"))
        : (ar ? "تسجيل القبول يحتاج صلاحية إغلاق الصفقات — اطلبها من مديرك" : "Marking it won needs the close permission — ask your manager");
      case "DOCUMENT_LOSS": return can.close ? null : (ar ? "يحتاج صلاحية إغلاق الصفقات" : "Needs the close permission");
      case "REOPEN": return can.reopen ? null : (ar ? "يحتاج صلاحية إعادة الفتح" : "Needs the reopen permission");
      case "CREATE_QUOTE": case "ISSUE_QUOTE": case "EDIT_QUOTE": case "REVISE_QUOTE": case "RECORD_REPLY":
        return can.quote ? null : (ar ? "يحتاج صلاحية عروض الأسعار" : "Needs the quotation permission");
      case "REQUEST_APPROVAL": return null;
      case "APPROVE_SAMPLE": case "DECLINE_SAMPLE": return can.approveSample ? null : (ar ? "الموافقة للمدير" : "The manager decides");
      case "CREATE_ORDER": return can.createOrder ? null : (ar ? "إنشاء الطلب يحتاج صلاحية الطلبات" : "Creating the order needs the orders permission");
      case "VIEW_ORDER": return null;
      default: return can.write ? null : (ar ? "يحتاج صلاحية تعديل الصفقات" : "Needs the deal write permission");
    }
  };
  const actionHref = (a: DealAction): string | null => {
    switch (a.key) {
      case "CREATE_QUOTE": return quoteHref();
      case "ISSUE_QUOTE": case "EDIT_QUOTE": case "REVISE_QUOTE": case "REQUEST_APPROVAL": case "RECORD_REPLY": case "CREATE_ORDER":
        return quoteHref(a.quoteId);
      case "VIEW_ORDER": return "/dashboard/orders";
      default: return null;
    }
  };
  const nextStageId = (() => {
    const shownIds = stages.filter((s) => s.isActive).sort((x, y) => x.position - y.position);
    const i = shownIds.findIndex((s) => s.id === deal.stage.id);
    return i >= 0 ? shownIds[i + 1]?.id : undefined;
  })();
  async function runAction(a: DealAction) {
    switch (a.key) {
      case "RECORD_NEEDS": setDialog("needs"); return;
      case "REQUEST_SAMPLE": openSample(); return;
      case "RECORD_SAMPLE_EVALUATION": { const x = deal?.samples.find((y) => y.id === a.sampleId) ?? deal?.samples.find((y) => y.status === "SENT"); if (x) setFeedbackFor(x); return; }
      case "SKIP_SAMPLES": setSkipTarget(null); setDialogError(""); setDialog("skip"); return;
      case "SEND_SAMPLE": {
        if (!a.sampleId) return;
        setBusy(true);
        const res = await api(`/api/sales/samples/${a.sampleId}`, { method: "PATCH", body: { status: "SENT" } });
        setBusy(false);
        if (res.ok) { setSuccess(ar ? "عُلّمت العيّنة مُرسلة." : "Sample marked sent."); reload(); } else setError(res.data.error ?? "");
        return;
      }
      // أبو فهد B7: the approver decides the second sample from «المطلوب منك الآن» (the same dialogs as the samples table).
      case "APPROVE_SAMPLE": { const x = deal?.samples.find((y) => y.id === a.sampleId); if (x) setApproveFor(x); return; }
      case "DECLINE_SAMPLE": { const x = deal?.samples.find((y) => y.id === a.sampleId); if (x) setDeclineFor(x); return; }
      case "LOG_CALL": setDialog("activity"); return;
      case "DOCUMENT_LOSS": setDialogError(""); setDialog("close"); return;
      case "WIN": transition({ toOutcome: "WON" }, ar ? "سُجّلت الصفقة رابحة." : "Deal marked won."); return;
      case "REOPEN": transition({ toOutcome: "OPEN" }, ar ? "أُعيد فتح الصفقة." : "Deal reopened."); return;
      case "ADVANCE":
        if (nextStageId) transition({ toStageId: nextStageId }, ar ? "نُقلت الصفقة إلى المرحلة التالية." : "Moved to the next stage.");
        return;
      default: return; // the quotation and order actions are links
    }
  }
  const ACTION_TESTID: Partial<Record<DealAction["key"], string>> = { WIN: "win-deal", REOPEN: "reopen-deal", ADVANCE: "next-stage" };
  /** The one primary button (annotation 1): disabled with its reason when the deal waits, or the person may not. */
  const actionControl = (a: DealAction, primary: boolean) => {
    const why = a.disabled ? null : blockedBy(a.key);
    const label = ar ? a.ar : a.en;
    const testId = ACTION_TESTID[a.key] ?? `stage-action-${a.key.toLowerCase().replace(/_/g, "-")}`;
    if (!primary) {
      if (why) return null; // a link the person cannot use is not offered
      const href = actionHref(a);
      return href
        ? <Link key={a.key} className="pv2-lk" style={{ margin: 0 }} href={href} data-testid={testId}>{label}</Link>
        : <button key={a.key} type="button" className="pv2-lk" style={{ margin: 0 }} data-testid={testId} disabled={busy} onClick={() => runAction(a)}>{label}</button>;
    }
    if (a.disabled || why) {
      return (
        <span key={a.key} style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="pv2-btn" disabled data-testid={testId} aria-describedby="now-why">{label}</button>
          {why ? <span className="why" id="now-why" data-testid="now-why">{why}</span> : null}
        </span>
      );
    }
    const href = actionHref(a);
    return href
      ? <Link key={a.key} className="pv2-btn" href={href} data-testid={testId}><Ico name="note" small />{label}</Link>
      : <button key={a.key} type="button" className="pv2-btn" data-testid={testId} disabled={busy} onClick={() => runAction(a)}><Ico name="note" small />{label}</button>;
  };
  // The documented skip, if this deal skipped its samples.
  const skipEvent = deal.stageEvents.find((e) => parseSampleSkip(e.reason));
  const skippedBecause = skipEvent ? parseSampleSkip(skipEvent.reason) : null;

  // ── The activity timeline: what happened on the deal, newest first — activities, samples
  //    sent, quotations issued and accepted, stage and outcome changes, the conversion.
  type Entry = { key: string; at: string; kind: string; title: React.ReactNode; detail?: React.ReactNode;
    when: string; diff?: string; activity?: Deal["activities"][number]; auto?: boolean };
  const entries: Entry[] = [];
  const stageName = (sid: string | null | undefined) => {
    const s = sid ? stageById.get(sid) : undefined;
    return s ? (ar ? s.nameAr : s.nameEn) : null;
  };
  const stageDiffs: { at: number; text: string; used: boolean; auto: boolean; why: string | null }[] = deal.stageEvents
    // The stage a deal starts in is not a change; only moves get the «A ← B» chip.
    .filter((e) => e.toStageId && e.fromStageId)
    .map((e) => {
      const from = stageName(e.fromStageId), to = stageName(e.toStageId) ?? (e.toStage ? L(e.toStage) : "");
      return { at: new Date(e.createdAt).getTime(), text: `${ar ? "المرحلة" : "Stage"}: ${from ? `${from} ${ar ? "←" : "→"} ` : ""}${to}`, used: false,
        auto: isAutoReason(e.reason), why: autoWhy(e.reason, ar) };
    });
  const claimDiff = (at: string) => {
    const t = new Date(at).getTime();
    const d = stageDiffs.find((x) => !x.used && Math.abs(x.at - t) < 120_000);
    if (d) d.used = true;
    return d;
  };
  const by = (name?: string | null) => (name ? ` · ${name}` : "");
  const actorName = (empId?: string | null) => (empId ? actors[empId] : undefined);
  for (const a of deal.activities) {
    // The next step is already the band above; the timeline is what has happened and the rest that is due.
    if (a.id === nextStep?.id) continue;
    // A logged outcome reads as the event («مكالمة · يحتاج متابعة») and the subject as its note.
    const withOutcome = !!a.outcome && !!a.completedAt;
    entries.push({
      key: `a-${a.id}`, at: a.completedAt ?? a.createdAt, kind: "activity", activity: a,
      title: <>{pick(ACTIVITY_LABELS, a.type, lang)} · {withOutcome ? pick(OUTCOME_LABELS, a.outcome!, lang) : <bdi>{a.subject}</bdi>}</>,
      detail: withOutcome ? [a.subject, a.body].filter(Boolean).join(" ") : (a.body ?? undefined),
      when: a.completedAt ? `${shortDate(a.completedAt, lang)}${by(a.owner?.name)}`
        : `${ar ? "مستحقة " : "due "}${a.dueAt ? dueText(a.dueAt, lang) : "—"}${by(a.owner?.name)}`,
    });
  }
  for (const s of deal.samples) {
    if (!s.sentAt) continue;
    entries.push({
      key: `s-${s.id}`, at: s.sentAt, kind: "sample",
      title: <>{ar ? "أُرسلت عيّنة" : "Sample sent"} · <bdi>{skuName(s.productSku, ar) ?? s.description}</bdi></>,
      // In a sentence the quantity reads plainly («2 كجم»); the samples table keeps two decimals.
      detail: <><span className="n">{Number(s.quantity)}</span> {UNIT_LABELS[s.unit] ? pick(UNIT_LABELS, s.unit, lang) : s.unit}</>,
      when: shortDate(s.sentAt, lang),
    });
  }
  for (const q of deal.quotes) {
    if (q.issuedAt) entries.push({
      key: `qi-${q.id}`, at: q.issuedAt, kind: "quote",
      title: ar
        ? <>أُصدر العرض <bdi className="id" dir="ltr">{q.quoteNumber}</bdi> · المراجعة {q.revision}</>
        : <>Quotation <bdi className="id" dir="ltr">{q.quoteNumber}</bdi> issued · revision {q.revision}</>,
      when: shortDate(q.issuedAt, lang), ...(() => { const d = claimDiff(q.issuedAt!); return d ? { diff: d.text, auto: d.auto } : {}; })(),
    });
    if (q.acceptedAt) entries.push({
      key: `qa-${q.id}`, at: q.acceptedAt, kind: "quote",
      title: <>{ar ? "قُبل العرض" : "Accepted"} <bdi className="id" dir="ltr">{q.quoteNumber}</bdi></>,
      when: shortDate(q.acceptedAt, lang),
    });
  }
  if (deal.conversion) entries.push({
    key: "conv", at: deal.conversion.convertedAt, kind: "conversion",
    title: <><Link href={`/dashboard/sales/leads/${deal.conversion.leadId}`} style={{ color: "inherit", textDecoration: "none" }}>{ar ? "حُوِّل من عميل محتمل" : "Converted from a lead"}</Link> · {pick(LEAD_SOURCE_LABELS, deal.conversion.lead.source, lang)}</>,
    when: `${shortDate(deal.conversion.convertedAt, lang)}${by(actorName(deal.conversion.convertedById))}`, diff: claimDiff(deal.conversion.convertedAt)?.text,
  });
  for (const e of deal.stageEvents) {
    if (e.toOutcome && e.toOutcome !== "OPEN") {
      entries.push({ key: `o-${e.id}`, at: e.createdAt, kind: "outcome", auto: isAutoReason(e.reason),
        title: e.toOutcome === "WON" ? (ar ? "أُغلقت الصفقة رابحة" : "Deal won") : (ar ? "خُسرت الصفقة" : "Deal lost"),
        detail: (isAutoReason(e.reason) ? autoWhy(e.reason, ar) : humanReason(e.reason)) ?? undefined, when: `${shortDate(e.createdAt, lang)}${by(actorName(e.actorId))}` });
    } else if (e.toOutcome === "OPEN" && !e.toStageId) {
      entries.push({ key: `o-${e.id}`, at: e.createdAt, kind: "outcome", title: ar ? "أُعيد فتح الصفقة" : "Deal reopened",
        detail: e.reason ?? undefined, when: `${shortDate(e.createdAt, lang)}${by(actorName(e.actorId))}` });
    }
  }
  // Stage moves that did not coincide with an issue or the conversion stand on their own.
  for (const e of deal.stageEvents) {
    if (!e.toStageId) continue;
    if (!e.fromStageId) {
      // Where the deal started: part of the conversion when there was one, else its own line.
      if (!deal.conversion) entries.push({ key: `st-${e.id}`, at: e.createdAt, kind: "stage",
        title: ar ? `أُنشئت الصفقة في مرحلة ${stageName(e.toStageId) ?? ""}` : `Deal created in ${stageName(e.toStageId) ?? ""}`,
        when: `${shortDate(e.createdAt, lang)}${by(actorName(e.actorId))}` });
      continue;
    }
    const t = new Date(e.createdAt).getTime();
    const d = stageDiffs.find((x) => x.at === t && !x.used);
    if (!d) continue;
    d.used = true;
    const skipped = parseSampleSkip(e.reason);
    const manual = humanReason(e.reason)?.split(" · ").filter((x) => !x.startsWith("تخطّي العيّنات: ")).join(" · ") || null;
    entries.push({ key: `st-${e.id}`, at: e.createdAt, kind: "stage", auto: d.auto,
      title: ar ? `انتقلت إلى «${stageName(e.toStageId) ?? ""}»` : `Moved to “${stageName(e.toStageId) ?? ""}”`,
      detail: [skipped ? (ar ? `تُخطّيت العيّنات: ${skipped}` : `Samples skipped: ${skipped}`) : null, d.auto ? d.why : manual].filter(Boolean).join(" · ") || undefined, when: `${shortDate(e.createdAt, lang)}${by(actorName(e.actorId))}`, diff: d.text });
  }
  // Open follow-ups first (they are what is due), then the history newest first.
  entries.sort((a, b) => {
    const ao = a.activity && !a.activity.completedAt ? 1 : 0, bo = b.activity && !b.activity.completedAt ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  });
  const visible = allEntries ? entries : entries.slice(0, 20);

  // The action column exists only while some sample has a next step for the rep: a record-only sample being
  // prepared («mark sent»), a stock request not yet issued («cancel request»), or a sent sample whose result is
  // still to be recorded («record result»). Sending a stock sample is dispatch's issue, never a button here.
  const sampleAction = (x: Deal["samples"][number]) =>
    !x.fromStock && x.status === "PREPARING" ? "send"
      : x.fromStock && (x.status === "REQUESTED" || x.status === "PREPARING") ? "cancel"
      : x.status === "SENT" ? "result" : null;
  // A second sample waiting for the manager: the manager (lead_assign / admin) approves or declines it right here.
  const awaitsManager = (x: Deal["samples"][number]) => x.approval === "PENDING" && x.status === "REQUESTED";
  const canSend = (can.write && deal.samples.some((x) => sampleAction(x) !== null))
    || (!!can.approveSample && deal.samples.some(awaitsManager));
  const patchSample = async (sid: string, body: Record<string, unknown>) => {
    setBusy(true);
    const res = await api<{ error?: string; errorEn?: string }>(`/api/sales/samples/${sid}`, { method: "PATCH", body });
    setBusy(false);
    if (res.ok) reload(); else setError((ar ? res.data.error : res.data.errorEn ?? res.data.error) ?? "");
    return res.ok;
  };
  // The manager's decision (POST /api/sales/samples/[id]/approval), recorded on the request.
  const decideSample = async (sid: string, decision: "APPROVE" | "DECLINE", note?: string) => {
    setBusy(true);
    const res = await api<{ error?: string; errorEn?: string }>(`/api/sales/samples/${sid}/approval`, { method: "POST", body: { decision, note } });
    setBusy(false);
    if (res.ok) {
      setSuccess(decision === "APPROVE"
        ? (ar ? "وافقت على العيّنة الثانية؛ وصل الطلب إلى قسم الشحن." : "Second sample approved; the request has gone to dispatch.")
        : (ar ? "رُفضت العيّنة الثانية وأُلغي طلبها." : "Second sample declined; its request is cancelled."));
      reload();
    } else setError((ar ? res.data.error : res.data.errorEn ?? res.data.error) ?? "");
    return res.ok;
  };

  // Collections: under the quotations once there is something to collect against; before
  // that only the panel's reason («no accepted quotation yet») is useful, so it waits at the
  // end of the main column instead of pushing the frame's sections down.
  const collectionsHere = !!collectionSummary && (!!collectionSummary.document || collections.length > 0);
  const collectionsPanel = collectionSummary ? (
    <div style={{ marginBottom: 32 }}>
      <CollectionsPanel dealId={id} ar={ar} lang={lang} summary={collectionSummary} rows={collections} heldOrder={heldOrder} dealOrders={dealOrders} collectFor={collectFor}
        action={collectionAction} onChanged={reload} />
    </div>
  ) : null;
  const customerName = deal.customer ? (ar ? (deal.customer.nameAr ?? deal.customer.name) : deal.customer.name) : null;
  // The rate printed above the quotations comes from their lines: one rate when every line on
  // every listed quotation carries the same one, otherwise "per line". Never a fixed 15%.
  const rates = [...new Set(deal.quotes.flatMap((q) => (q.lines ?? []).map((l) => Number(l.taxRatePercent))))];
  const vatNote = rates.length === 1
    ? (ar ? <>الضريبة <span className="n">{rates[0]}%</span> تُحسب لكل بند بعد الخصم</> : <>VAT <span className="n">{rates[0]}%</span> is calculated per line after the discount</>)
    : (ar ? "الضريبة تُحسب لكل بند بعد الخصم، بنسبة البند" : "VAT is calculated per line after the discount, at each line's rate");


  // The decisions on one sample (approve / decline, mark sent, cancel, record the result) — the table cell on a desktop,
  // the card's button row on a phone (FOLLOWUPS sales UI bug 6: they were cut off at 390).
  const sampleButtons = (s: Deal["samples"][number]) => (
    <>
                  {can.approveSample && awaitsManager(s) && (
                    <>
                      <button type="button" className="btn sm" data-testid={`approve-sample-${s.id}`} disabled={busy}
                        onClick={() => setApproveFor(s)}>
                        {ar ? "موافقة" : "Approve"}
                      </button>{" "}
                      <button type="button" className="btn sm" data-testid={`decline-sample-${s.id}`} disabled={busy}
                        onClick={() => setDeclineFor(s)}>
                        {ar ? "رفض" : "Decline"}
                      </button>{" "}
                    </>
                  )}
                  {can.write && sampleAction(s) === "send" && (
                    <button type="button" className="btn sm" data-testid={`send-sample-${s.id}`} disabled={busy}
                      onClick={() => patchSample(s.id, { status: "SENT" })}>
                      {ar ? "تعليم مُرسلة" : "Mark sent"}
                    </button>
                  )}
                  {can.write && sampleAction(s) === "cancel" && (
                    <button type="button" className="btn sm" data-testid={`cancel-sample-${s.id}`} disabled={busy}
                      onClick={() => patchSample(s.id, { status: "CANCELLED" })}>
                      {ar ? "إلغاء الطلب" : "Cancel request"}
                    </button>
                  )}
                  {can.write && sampleAction(s) === "result" && (
                    <button type="button" className="btn sm" data-testid={`result-sample-${s.id}`} disabled={busy}
                      onClick={() => setFeedbackFor(s)}>
                      {ar ? "تسجيل النتيجة" : "Record result"}
                    </button>
                  )}
    </>
  );
  // ── Sections shared by the desktop and phone layouts ──
  // ═══ Pipeline v2 layout (Figma page 08) — one layout; below 768 the two columns stack (1766:965) ═══
  const L2 = (o: { ar: string; en: string }) => (ar ? o.ar : o.en);
  const { top: headTitle, sub: headSub } = splitTitle(deal.title, customerName);
  const phase = ns?.phase ?? (open ? "QUALIFIED" : "CLOSED");
  const liveSamples = deal.samples.filter((x) => x.status !== "CANCELLED");
  // P2 UXM-21: the deal value keeps its halalas (it is compared with what is collected, «310.50», on the same page).
  const money = (v: string | number) => ar ? <><span className="n">{halalas(v)}</span> ⃁</> : <>SAR <span className="n">{halalas(v)}</span></>;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const timeOf = (v: string) => { const d = new Date(v); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

  // ── The stepper (1766:797): three stages + «مغلقة»; a skipped sample stage is dashed with its reason ──
  const sampleIdx = shown.findIndex((x) => x.purpose === "SAMPLE_EVALUATION");
  const pastSamples = sampleIdx >= 0 && (atIdx > sampleIdx || (!open && atIdx >= sampleIdx));
  const samplesSkipped = !!skippedBecause || (pastSamples && liveSamples.length === 0 && atIdx !== sampleIdx);
  const shortName = (x: Stage) => {
    if (!phone) return ar ? x.nameAr : x.nameEn;
    const short: Record<string, { ar: string; en: string }> = { QUALIFICATION: { ar: "مؤهلة", en: "Qualified" }, SAMPLE_EVALUATION: { ar: "العيّنات", en: "Samples" }, QUOTATION: { ar: "عرض السعر", en: "Quotation" } };
    return x.purpose && short[x.purpose] ? L2(short[x.purpose]) : (ar ? x.nameAr : x.nameEn);
  };
  const steps: Step[] = shown.map((x, i) => {
    const isSample = i === sampleIdx;
    const reachedAt = reached.get(x.id);
    let state: Step["state"];
    if (open) state = i < atIdx ? (isSample && samplesSkipped ? "skip" : "done") : i === atIdx ? "cur" : "up";
    else state = i <= atIdx ? (isSample && samplesSkipped && i < atIdx ? "skip" : "done") : "up";
    const sub = state === "skip" ? `${ar ? "تُخطّيت" : "skipped"}${skippedBecause ? ` · ${skippedBecause}` : ""}`
      : state === "cur" ? (phone ? (ar ? "الآن" : "now") : inStageDays === 0 ? (ar ? "منذ اليوم" : "since today") : relativeDays(inStageSince, lang))
        : state === "done" ? (reachedAt ? shortDate(reachedAt, lang) : "") : (phone ? "" : "—");
    return { key: x.id, label: shortName(x), sub, state, testId: `stage-${x.code}` };
  });
  steps.push({
    key: "closed", testId: "stage-closed-step",
    label: deal.outcome === "WON" ? (ar ? "مغلقة · رابحة" : "Closed · won") : deal.outcome === "LOST" ? (ar ? "مغلقة · خاسرة" : "Closed · lost") : (ar ? "مغلقة" : "Closed"),
    state: deal.outcome === "WON" ? "done" : deal.outcome === "LOST" ? "cur" : "up",
    sub: deal.closedAt ? shortDate(deal.closedAt, lang) : phone ? "" : (ar ? "رابحة أو خاسرة" : "won or lost"),
  });
  const stepperNote = open && phase !== "QUOTE"
    ? (ar ? "لا تحتاج تحريك الصفقة يدويًا: طلب عيّنة ينقلها إلى «العيّنات»، وإصدار عرض سعر ينقلها إلى «عرض السعر والتفاوض»."
      : "No need to move the deal by hand: requesting a sample moves it to Samples, issuing a quotation to Quotation & negotiation.")
    : null;

  // ── The latest automatic move into where the deal is now (annotation 2: shown in «المطلوب منك الآن») ──
  const lastIn = deal.stageEvents.find((e) => (open ? e.toStageId === deal.stage.id && e.fromStageId : e.toOutcome === deal.outcome));
  const autoLine = lastIn && isAutoReason(lastIn.reason) ? (
    <div className="auto" data-testid="now-auto">
      <Chip label={ar ? "تلقائي" : "Automatic"} dot={false} />
      <span>{open
        ? (ar ? `انتقلت الصفقة إلى هذه المرحلة تلقائيًا ${autoWhy(lastIn.reason, ar)}` : `The deal moved here automatically, ${autoWhy(lastIn.reason, ar)}`)
        : (ar ? `أُغلقت الصفقة رابحة تلقائيًا ${autoWhy(lastIn.reason, ar)}` : `The deal was won automatically, ${autoWhy(lastIn.reason, ar)}`)}
        {acceptedQuote && !open ? <> <bdi className="id" dir="ltr">{acceptedQuote.quoteNumber}</bdi></> : null} · {shortDate(lastIn.createdAt, lang)}، {timeOf(lastIn.createdAt)}</span>
    </div>
  ) : null;

  // ── The current quotation (the server's choice) and its versions ──
  const currentQuote = (ns?.quoteId ? deal.quotes.find((x) => x.id === ns.quoteId) : undefined)
    ?? [...deal.quotes].filter((x) => x.status !== "SUPERSEDED").sort((a, b) => b.revision - a.revision)[0];
  const versions = [...deal.quotes].sort((a, b) => a.revision - b.revision);
  const daysLeft = (v: string) => daysFromToday(v);

  // ── «المطلوب منك الآن» (1766:816; won 1769:1264; lost 1769:1850) ──
  const needItems: { key: "businessType" | "needSummary" | "expectedMonthlyKg" | "nextStep"; label: string; value: React.ReactNode | null }[] = [
    { key: "businessType", label: L2(QUALIFICATION_FIELD_LABELS.businessType), value: deal.businessType ? L2(BUSINESS_TYPE_LABELS[deal.businessType as BusinessType] ?? { ar: deal.businessType, en: deal.businessType }) : null },
    { key: "needSummary", label: L2(QUALIFICATION_FIELD_LABELS.needSummary), value: deal.needSummary ? <bdi>{deal.needSummary}</bdi> : null },
    { key: "expectedMonthlyKg", label: ar ? "الكمية الشهرية المتوقعة (اختياري)" : "Expected monthly volume (optional)", value: deal.expectedMonthlyKg !== null ? <><span className="n">{Number(deal.expectedMonthlyKg)}</span> {ar ? "كغ" : "kg"}</> : null },
    { key: "nextStep", label: L2(QUALIFICATION_FIELD_LABELS.nextStep), value: deal.agreedNextStep ? <bdi>{deal.agreedNextStep}</bdi> : null },
  ];
  const needsDone = needItems.filter((x) => x.value !== null).length;
  const sentSample = liveSamples.find((x) => x.status === "SENT");
  const nowDetail = (): string | null => {
    if (!ns) return null;
    const extra = ns.requiredNow.slice(1).map(L2);
    const k = ns.nextAction?.key;
    let base: string | null = null;
    if (k === "RECORD_NEEDS") {
      // The count is the minimum's — the same items the title lists (gate fix L4); the monthly volume is optional.
      const left = qualificationMissing(deal).length;
      base = ar ? `${left === 1 ? "بقي بند واحد" : left === 2 ? "بقي بندان" : `بقيت ${left} بنود`} من الحد الأدنى. بعدها اطلب عيّنة، أو حدّد أن العميل لا يحتاجها.`
        : `${left} of the minimum left. Then request a sample, or say the customer needs none.`;
    }
    else if (k === "RECORD_SAMPLE_EVALUATION" && sentSample?.sentAt) {
      const due = ns.followUp?.dueAt;
      base = ar ? `أُرسلت العيّنة يوم ${shortDate(sentSample.sentAt, lang)}. الرأي متوقع ${due ? (daysFromToday(due) === 0 ? "اليوم" : daysFromToday(due) < 0 ? `منذ ${dayCount(-daysFromToday(due), lang)}` : shortDate(due, lang)) : ""}.`
        : `The sample was sent on ${shortDate(sentSample.sentAt, lang)}. The view is expected ${due ? shortDate(due, lang) : ""}.`;
    } else if (k === "RECORD_REPLY" && currentQuote?.issuedAt) {
      const n = -daysFromToday(currentQuote.issuedAt);
      base = ar ? `${n === 0 ? "أُرسلت اليوم" : `أُرسلت قبل ${dayCount(n, lang)}`} ولم يصل رد بعد.${currentQuote.validUntil ? ` العرض صالح حتى ${shortDate(currentQuote.validUntil, lang)}.` : ""}`
        : `${n === 0 ? "Sent today" : `Sent ${dayCount(n, lang)} ago`} with no reply yet.${currentQuote.validUntil ? ` Valid until ${shortDate(currentQuote.validUntil, lang)}.` : ""}`;
    } else if (k === "CREATE_ORDER" && acceptedQuote) {
      base = ar ? `قبل العميل النسخة ${acceptedQuote.revision} بقيمة ${halalas(acceptedQuote.grandTotal)} ⃁. إنشاء الطلب يبدأ التجهيز والتوصيل، ولا يحتاج إعادة إدخال الأصناف.`
        : `The customer accepted version ${acceptedQuote.revision} (SAR ${halalas(acceptedQuote.grandTotal)}). The order starts preparation and delivery; nothing is typed again.`;
    }
    return [base, ...extra].filter(Boolean).join(" ") || null;
  };
  // D20 (أبو فهد B2): the rep's own bank transfer waiting without its receipt is what is asked for now.
  const receiptDue = collections.find((c) => c.status === "PENDING_VERIFICATION" && c.paymentMethod === "BANK_TRANSFER" && c._count.evidence === 0 && !!meId && c.submittedBy?.id === meId);
  const lostEvent = deal.outcome === "LOST" ? deal.stageEvents.find((e) => e.toOutcome === "LOST") : undefined;
  const nowCard = !ns ? (
    <div className="pv2-now idle" aria-busy="true"><div className="pv2-skel" style={{ width: 120 }} /><div className="pv2-skel" style={{ width: 260 }} /><div className="pv2-skel" style={{ width: 180 }} /></div>
  ) : deal.outcome === "LOST" ? (
    <div className="pv2-now idle" data-testid="now-card">
      <span className="k" style={{ color: "var(--text-secondary)" }}>{ar ? "الصفقة مغلقة — لا شيء مطلوب منك" : "The deal is closed — nothing for you"}</span>
      <h2>{ar ? "خُسرت الصفقة" : "The deal was lost"}{deal.lostReason ? <>: <bdi>{deal.lostReason}</bdi></> : null}</h2>
      {lostEvent && <p>{ar ? `سجّلها ${actorName(lostEvent.actorId) ?? "—"} في ${longDate(lostEvent.createdAt, lang)}.` : `Recorded by ${actorName(lostEvent.actorId) ?? "—"} on ${longDate(lostEvent.createdAt, lang)}.`} {ar ? "أُغلقت المتابعات المفتوحة تلقائيًا." : "Open follow-ups were closed automatically."}</p>}
      {ns.secondary.length > 0 && <div className="acts">{ns.secondary.slice(0, 2).map((a) => actionControl(a, false))}</div>}
    </div>
  ) : (
    <div className={`pv2-now${deal.outcome === "WON" ? " won" : ""}`} data-testid="now-card">
      <span className="k">{ar ? "المطلوب منك الآن" : "What you need to do now"}</span>
      {/* Abu Fahd R4 F2: a held order that needs the rep is never «لا شيء مطلوب منك الآن». */}
      <h2 data-testid="now-title">{ns.requiredNow[0] ? L2(ns.requiredNow[0]) : heldOrder?.needsRep ? (heldOrder.short ? (ar ? `سجّل الباقي من الطلب #${heldOrder.orderNumber}` : `Record the rest from order #${heldOrder.orderNumber}`) : (ar ? `الطلب #${heldOrder.orderNumber} موقوف بانتظار المبلغ` : `Order #${heldOrder.orderNumber} is held for its money`)) : receiptDue ? (ar ? "ارفع إيصال التحويل" : "Upload the transfer receipt") : (ar ? "لا شيء مطلوب منك الآن" : "Nothing for you now")}</h2>
      {!ns.requiredNow[0] && heldOrder?.needsRep ? (
        <div className="acts"><Link className="btn p" href={`/dashboard/orders?order=${encodeURIComponent(heldOrder.id)}`} data-testid="now-held-go">{heldOrder.short ? (ar ? `سجّل الباقي (${Number(heldOrder.short).toFixed(2)} ⃁)` : `Record the rest (SAR ${Number(heldOrder.short).toFixed(2)})`) : (ar ? `افتح الطلب #${heldOrder.orderNumber}` : `Open order #${heldOrder.orderNumber}`)}</Link></div>
      ) : null}
      {nowDetail() ? <p>{nowDetail()}</p> : null}
      {!ns.requiredNow[0] && receiptDue ? <p data-testid="now-receipt-due">{ar ? "التحويل البنكي مسجّل بدون إيصال — ارفعه عشان يعتمده المحاسب أسرع." : "The bank transfer is recorded without its receipt — upload it so the accountant can approve sooner."}</p> : null}
      {autoLine}
      {!ns.requiredNow[0] && receiptDue ? (
        <div className="acts"><a className="btn p" href="#collections" data-testid="now-receipt-go">{ar ? "أرفق الإيصال" : "Attach the receipt"}</a></div>
      ) : null}
      {(ns.nextAction || ns.secondary.length > 0) && (
        <div className="acts">
          {ns.nextAction ? actionControl(ns.nextAction, true) : null}
          {ns.secondary.slice(0, 2).map((a) => actionControl(a, false))}
        </div>
      )}
    </div>
  );

  // ── A manual move waiting for a supervisor (owner decision 3), or the last refusal ──
  const moveBanner = pendingMove ? (
    <div className="pv2-pending" role="status" data-testid="pending-move">
      <b>{ar ? "طلب نقل بانتظار اعتماد المشرف" : "Move request awaiting a supervisor"}</b>
      <span>{ar ? `إلى «${pendingMove.toStage?.nameAr ?? ""}»` : `to “${pendingMove.toStage?.nameEn ?? ""}”`}{pendingMove.requestedBy ? ` · ${ar ? "بطلب" : "by"} ${pendingMove.requestedBy}` : ""}{pendingMove.reason ? <> · <bdi>{pendingMove.reason}</bdi></> : null}</span>
      <span className="sp" />
      {pendingMove.canDecide && <button type="button" className="btn sm p" data-testid="decide-move" onClick={() => { setDialogError(""); setDialog("decide"); }}>{ar ? "اعتماد أو رفض" : "Approve or reject"}</button>}
      {pendingMove.canWithdraw && <button type="button" className="btn sm g" data-testid="withdraw-move" disabled={busy} onClick={() => decideMove("WITHDRAW")}>{ar ? "سحب الطلب" : "Withdraw"}</button>}
    </div>
  ) : rejectedMove && open ? (
    <div className="pv2-pending rej" role="status" data-testid="rejected-move">
      <b>{ar ? "رُفض طلب النقل" : "Move request rejected"}</b>
      <span>{ar ? `إلى «${rejectedMove.toStage?.nameAr ?? ""}»` : `to “${rejectedMove.toStage?.nameEn ?? ""}”`}{rejectedMove.decidedBy ? ` · ${rejectedMove.decidedBy}` : ""}{rejectedMove.note ? <>: <bdi>{rejectedMove.note}</bdi></> : null}</span>
    </div>
  ) : null;

  // ── Needs (1766:849): a step inside «فرصة مؤهلة» ──
  const needsPanel = (
    <section className="pv2-panel" data-testid="deal-needs" aria-labelledby="pv2-needs-h">
      <div className="h">
        <h2 id="pv2-needs-h">{ar ? "تحليل الاحتياج · خطوة داخل «فرصة مؤهلة»" : "Needs analysis · a step of “Qualified”"}</h2>
        <span className="c">{ar ? `${needsDone} من 4` : `${needsDone} of 4`}</span>
        {open && can.write && <button type="button" className="lk" data-testid="edit-needs" onClick={() => setDialog("needs")}>{ar ? "تعديل" : "Edit"}</button>}
      </div>
      <div className="pv2-progress" aria-hidden><span style={{ width: `${needsDone * 25}%` }} /></div>
      <ul className="pv2-check">
        {needItems.map((it) => (
          <li key={it.key} data-testid={`need-${it.key}`}>
            <span className={`bx${it.value !== null ? " on" : ""}`} role="img" aria-label={it.value !== null ? (ar ? "مكتمل" : "done") : (ar ? "ناقص" : "missing")}>{it.value !== null ? <Ico name="tick" small /> : null}</span>
            <span className="tx"><b>{it.label}</b>{it.value !== null ? <span>{it.value}</span> : <span className="no">{ar ? "لم يُسجّل بعد" : "Not recorded yet"}</span>}</span>
            {it.value === null && open && can.write && <button type="button" className="pv2-lk" onClick={() => setDialog("needs")}>{ar ? "إضافة" : "Add"}</button>}
          </li>
        ))}
      </ul>
      <p className="note">{ar ? "يكفي إكمال الحد الأدنى (نوع النشاط، الاحتياج، الخطوة التالية) لتصبح الخطوة التالية «طلب عيّنة». لا يلزم ترتيب معيّن." : "The minimum (business type, need, next step) makes «request a sample» the next step. Any order."}</p>
    </section>
  );

  // ── Samples (1767:810) ──
  const sampleChip = (x: Deal["samples"][number]) => awaitsManager(x)
    ? <Chip tone="warn" label={pick(SAMPLE_APPROVAL_LABELS, "PENDING", lang)} testId={`sample-status-${x.id}`} />
    : <Chip tone={x.status === "SENT" ? "info" : x.status === "FEEDBACK_RECEIVED" ? "ok" : "neutral"} testId={`sample-status-${x.id}`}
      label={x.status === "SENT" ? (ar ? "أُرسلت · بانتظار الرأي" : "Sent · awaiting the view") : x.status === "FEEDBACK_RECEIVED" && x.feedbackScore !== null ? `${pick(SAMPLE_LABELS, x.status, lang)} · ${x.feedbackScore}/5` : pick(SAMPLE_LABELS, x.status, lang)} />;
  const samplesPanel = (
    <section className="pv2-panel" data-testid="deal-samples" aria-labelledby="pv2-smp-h">
      <div className="h">
        <h2 id="pv2-smp-h">{ar ? "العيّنات في هذه الصفقة" : "Samples on this deal"}</h2>
        <span className="c">{deal.samples.length}</span>
        {maySample && open && <button type="button" className="lk" data-testid="add-sample" onClick={openSample}>{ar ? "إرسال عيّنة" : "Send a sample"}</button>}
      </div>
      {deal.samples.length === 0 ? <p className="txt">{ar ? "لا توجد عيّنات." : "No samples."}</p> : deal.samples.map((x) => (
        <div key={x.id} className="pv2-smp" data-testid={`sample-${x.id}`}>
          <span className="ic" aria-hidden><Ico name="flask" small /></span>
          <span className="tx">
            <b><bdi>{skuName(x.productSku, ar) ?? x.description}</bdi> · {qty(x.quantity, x.unit)}</b>
            {x.description && x.productSku ? <span><bdi>{x.description}</bdi></span> : null}
            <small data-testid={`sample-kind-${x.id}`}>{x.fromStock ? (ar ? "من المخزون" : "from stock") : (ar ? "للتسجيل فقط · لا يُصرف من المخزون" : "record only · no stock movement")}{x.sentAt ? ` · ${ar ? "أُرسلت" : "sent"} ${shortDate(x.sentAt, lang)}` : ""}</small>
            {(x.approval === "APPROVED" || x.approval === "DECLINED") && (
              <small data-testid={`sample-approval-${x.id}`}>{pick(SAMPLE_APPROVAL_LABELS, x.approval, lang)}{(x.approval === "DECLINED" || x.approval === "APPROVED") && x.approvalNote ? <>: <bdi data-testid={`sample-approval-note-${x.id}`}>{x.approvalNote}</bdi></> : null}</small>
            )}
            {canSend && <span className="deal-smp-act" style={{ marginTop: 6 }}>{sampleButtons(x)}</span>}
          </span>
          {sampleChip(x)}
        </div>
      ))}
      {sentSample && open && (
        <>
          <hr />
          <p className="txt" style={{ margin: 0 }}>{ar ? "عند تسجيل التقييم ستختار واحدًا:" : "When you record the view you choose one:"}</p>
          <div className="pv2-opts" aria-hidden>
            <Chip tone="ok" dot={false} label={ar ? "أعجبه — جهّز العرض" : "Liked it — prepare the quotation"} />
            <Chip dot={false} label={ar ? "يريد صنفًا آخر" : "Wants another product"} />
            <Chip dot={false} label={ar ? "لم يعجبه" : "Did not like it"} />
          </div>
        </>
      )}
    </section>
  );

  // ── The current quotation with its version history (1768:1038); the accepted one (1769:1264) ──
  const quotePanel = currentQuote ? (
    <section className="pv2-panel pv2-q" data-testid="deal-quotes" aria-labelledby="pv2-q-h">
      <div className="h">
        <h2 id="pv2-q-h">{currentQuote.status === "ACCEPTED" ? (ar ? "العرض المعتمد" : "Accepted quotation") : (ar ? "عرض السعر الحالي" : "Current quotation")}</h2>
        {can.quote && open
          ? <Link className="lk" href={`/dashboard/sales/quotes/new?opportunityId=${deal.id}`} data-testid="new-quote">{ar ? "عرض سعر جديد" : "New quotation"}</Link>
          : <Link className="lk" href={quoteHref(currentQuote.id)}>{ar ? "فتح العرض" : "Open"}</Link>}
      </div>
      <div className="ttl">
        <span style={{ display: "flex", flexDirection: "column" }}>
          <b>{ar ? "عرض السعر " : "Quotation "}<bdi className="id" dir="ltr">{currentQuote.quoteNumber}</bdi> · {ar ? `النسخة ${currentQuote.revision}` : `version ${currentQuote.revision}`}</b>
          {currentQuote.acceptedAt ? <span className="txt">{ar ? `قُبل في ${longDate(currentQuote.acceptedAt, lang)}` : `Accepted on ${longDate(currentQuote.acceptedAt, lang)}`}</span> : null}
        </span>
        {ns && ns.quoteId === currentQuote.id
          ? <Chip tone={QUOTE_TONE[ns.quoteState]} label={L2(ns.quoteStateLabel)} testId="quote-state" />
          : <Chip tone={currentQuote.status === "ACCEPTED" ? "ok" : "neutral"} label={pick(QUOTE_STATUS_SPECS, currentQuote.status, lang)} testId="quote-state" />}
      </div>
      <div>
        <div className="kv">{ar ? "المجموع قبل الضريبة" : "Before VAT"}<b>{money(Number(currentQuote.grandTotal) - Number(currentQuote.taxTotal ?? 0))}</b></div>
        <div className="kv">{ar ? "ضريبة القيمة المضافة" : "VAT"}<b>{money(Number(currentQuote.taxTotal ?? 0))}</b></div>
        <div className="kv">{ar ? "الإجمالي شامل ضريبة القيمة المضافة" : "Total incl. VAT"}<b>{money(currentQuote.grandTotal)}</b></div>
        {currentQuote.discountApproval && currentQuote.discountApproval !== "NOT_NEEDED" && (
          <div className="kv">{ar ? "الخصم" : "Discount"}<b>{currentQuote.discountApproval === "APPROVED" ? (ar ? "معتمد" : "approved") : currentQuote.discountApproval === "PENDING" ? (ar ? "بانتظار الاعتماد" : "awaiting approval") : (ar ? "مرفوض" : "refused")}</b></div>
        )}
        {currentQuote.validUntil && currentQuote.status !== "ACCEPTED" && open && (
          <div className="kv">{ar ? "صالح حتى" : "Valid until"}<b>{longDate(currentQuote.validUntil, lang)}{daysLeft(currentQuote.validUntil) >= 0 ? ` · ${relativeDays(currentQuote.validUntil, lang)}` : ""}</b></div>
        )}
        <p className="note" style={{ margin: "4px 0 0" }}>{vatNote}</p>
      </div>
      {versions.length > 1 && (
        <>
          <hr />
          <div className="h" style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <b style={{ font: "600 13px/22px var(--f-ui)" }}>{ar ? "تاريخ النسخ" : "Version history"}</b>
            <span className="note" style={{ marginInlineStart: "auto" }}>{ar ? "الأحدث يسارًا" : "newest last"}</span>
          </div>
          <div className="pv2-vers" data-testid="quote-versions">
            {versions.map((v) => (
              <Link key={v.id} href={quoteHref(v.id)} className={`pv2-ver${v.id === currentQuote.id ? " cur" : ""}`} data-testid={`quote-row-${v.quoteNumber}`} aria-current={v.id === currentQuote.id ? "true" : undefined}>
                <span className="top"><b>{ar ? `النسخة ${v.revision}` : `Version ${v.revision}`}</b><span>{money(v.grandTotal)}</span></span>
                <Chip tone={v.status === "ACCEPTED" ? "ok" : v.status === "REJECTED" || v.status === "EXPIRED" ? "danger" : v.status === "ISSUED" ? "info" : "neutral"} label={pick(QUOTE_STATUS_SPECS, v.status, lang)} />
                <small>{v.issuedAt ? shortDate(v.issuedAt, lang) : (ar ? "لم تُصدر" : "not issued")}</small>
              </Link>
            ))}
          </div>
        </>
      )}
      {versions.length === 1 && <span hidden data-testid={`quote-row-${currentQuote.quoteNumber}`} />}
      <div style={{ display: "flex", gap: 16 }}>
        <Link className="pv2-lk" style={{ margin: 0 }} href={quoteHref(currentQuote.id)}>{ar ? "فتح العرض" : "Open quotation"}</Link>
        <Link className="pv2-lk" style={{ margin: 0 }} href={`/dashboard/sales/quotes/${currentQuote.id}/print`}>{ar ? "تنزيل PDF" : "Download PDF"}</Link>
      </div>
    </section>
  ) : null;
  const showSamplesMain = phase === "SAMPLES" || (phase === "QUALIFIED" && deal.samples.length > 0);
  const showQuoteMain = !!currentQuote && (phase === "QUOTE" || phase === "CLOSED" || !showSamplesMain);

  // ── The ONE follow-up (1766:871) ──
  const fu = ns?.followUp ?? null;
  const fuAct = nextStep;
  const fuDue = fuAct?.dueAt ?? fu?.dueAt ?? deal.nextFollowUpAt ?? null;
  const fuLate = fuDue ? Math.max(0, -daysFromToday(fuDue)) : 0;
  const fuToday = !!fuDue && daysFromToday(fuDue) === 0 && new Date(fuDue) >= new Date(new Date().setHours(0, 0, 0, 0));
  // The sample reminder's stored subject is the system's (English); its title is said in the page's language.
  const fuTitle = fu?.kind === "SAMPLE_FEEDBACK" ? (ar ? "سؤال العميل عن رأيه في العيّنة" : "Ask the customer about the sample")
    : fuAct ? fuAct.subject
    : fu?.kind === "QUOTE_REPLY" ? (ar ? `متابعة رد العميل على النسخة ${currentQuote?.revision ?? ""}` : `Follow the customer's reply to version ${currentQuote?.revision ?? ""}`)
      : deal.nextFollowUpAt ? (ar ? "متابعة" : "Follow-up") : null;
  const fuNote = fu?.kind === "SAMPLE_FEEDBACK" ? (ar ? "أُنشئت تلقائيًا مع العيّنة، وتُغلق وحدها عند تسجيل التقييم — لا تحتاج مهمة أخرى." : "Created with the sample; it closes when the view is recorded.")
    : fu?.kind === "QUOTE_REPLY" ? (ar ? "مأخوذة من العرض المُرسل، وتنتهي وحدها عند تسجيل القبول أو الرفض أو التعديل." : "Taken from the sent quotation; it ends when the reply is recorded.")
      : (ar ? "متابعة واحدة لهذه الصفقة. جدولة موعد جديد تنقل هذه ولا تضيف أخرى." : "One follow-up per deal. Scheduling a new time moves this one.");
  const followPanel = (open || !!fuAct) ? (
    <section className="pv2-panel" data-testid="next-step" aria-labelledby="pv2-fu-h">
      <div className="h">
        <h2 id="pv2-fu-h">{ar ? "المتابعة القادمة" : "Next follow-up"}</h2>
        {open && can.write && <button type="button" className="lk" data-testid="schedule-follow-up" onClick={() => { setDialogError(""); setDialog("followup"); }}>{fuTitle ? (ar ? "تغيير الموعد" : "Reschedule") : (ar ? "جدولة متابعة" : "Schedule")}</button>}
      </div>
      {fuTitle ? (
        <div className="pv2-fu">
          <span className={`ic${fuLate ? " late" : ""}`} aria-hidden><Ico name="cal" small /></span>
          <span className="tx">
            <b><bdi>{fuTitle}</bdi></b>
            {fuDue && <span className={fuLate ? "late" : fuToday ? "today" : undefined}>
              {fuLate ? `${ar ? `متأخرة ${dayCount(fuLate, lang)} · كانت` : `${dayCount(fuLate, lang)} late · was`} ${longDate(fuDue, lang)}، ${timeOf(fuDue)}`
                : fuToday ? `${ar ? "اليوم" : "Today"} · ${longDate(fuDue, lang)}، ${timeOf(fuDue)}` : `${dueText(fuDue, lang)}`}
            </span>}
          </span>
          {fuAct && can.write && (
            <button type="button" className="btn sm" data-testid={`complete-${fuAct.id}`} disabled={busy} onClick={() => complete(fuAct.id)}>{ar ? "إكمال" : "Complete"}</button>
          )}
        </div>
      ) : <p className="txt" style={{ margin: 0 }}>{ar ? "لا متابعة مجدولة لهذه الصفقة." : "No follow-up scheduled for this deal."}</p>}
      <p className="note" style={{ margin: 0 }}>{fuNote}</p>
    </section>
  ) : null;

  // ── The timeline «السجل» (1766:907): «تلقائي» on automatic moves ──
  const timeline = (
    <section className="pv2-panel" aria-labelledby="pv2-tl-h">
      <div className="h">
        <h2 id="pv2-tl-h">{ar ? "السجل" : "History"}</h2>
        {entries.length > 20 && (
          <span className="c" data-testid="deal-activities-count">{ar ? "يُعرض " : "Showing "}<bdi className="n">{visible.length}</bdi>{ar ? " من " : " of "}<bdi className="n">{entries.length}</bdi></span>
        )}
        {entries.length > 20 && (
          <button type="button" className="lk" data-testid="toggle-all-activities" aria-expanded={allEntries} onClick={() => setAllEntries((v) => !v)}>
            {allEntries ? (ar ? "عرض أقل" : "Show fewer") : (ar ? "عرض الكل" : "Show all")}
          </button>
        )}
      </div>
      {entries.length === 0 ? <p className="txt" style={{ margin: 0 }}>{ar ? "لم يُسجَّل أي نشاط." : "Nothing logged yet."}</p> : (
        <ol className="pv2-tl" data-testid="deal-activities">
          {visible.map((e) => {
            const a = e.activity;
            const openA = a && !a.completedAt;
            const late = openA && a.dueAt && new Date(a.dueAt) < new Date();
            return (
              <li key={e.key} data-kind={e.kind} data-auto={e.auto ? "true" : undefined} data-testid={a ? `activity-${a.id}` : undefined}>
                <span className={`m${e.auto ? " auto" : ""}`} aria-hidden />
                <span className="tx">
                  <span className="r">
                    <span>{e.title}</span>
                    {e.auto && <Chip label={ar ? "تلقائي" : "Automatic"} dot={false} testId={`auto-${e.key}`} />}
                    {late && <Chip tone="danger" label={ar ? "متأخرة" : "Overdue"} />}
                  </span>
                  {e.detail && <span className="d" dir="auto">{e.detail}</span>}
                  <span className="w">{e.when}</span>
                  {openA && can.write && a.id !== nextStep?.id && (
                    <span><button type="button" className="btn sm" data-testid={`complete-${a.id}`} disabled={busy} onClick={() => complete(a.id)}>{ar ? "إكمال" : "Complete"}</button></span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );

  // ── Side column: details, samples / quotations at a glance, contacts ──
  const splits = (deal.owners.length > 0
    ? deal.owners.map((o) => ({ name: o.employee.name, pct: Number(o.sharePercent) }))
    : deal.owner ? [{ name: deal.owner.name, pct: 100 }] : []);
  const detailsPanel = (
    <section className="pv2-panel" data-testid="deal-metrics" aria-labelledby="pv2-det-h">
      <div className="h">
        <h2 id="pv2-det-h">{ar ? "تفاصيل الصفقة" : "Deal details"}</h2>
        {can.write && open && <button type="button" className="lk" data-testid="edit-deal" onClick={() => setDialog("edit")}>{ar ? "تعديل" : "Edit"}</button>}
      </div>
      <div className="kv">{ar ? "القيمة المتوقعة" : "Expected value"}<b>{money(deal.amount)}</b></div>
      {deal.lastClosedQuote && <div className="kv" data-testid="deal-metric-last-closed">{deal.lastClosedQuote.status === "EXPIRED" ? (ar ? "آخر عرض منتهي" : "Last expired quotation") : (ar ? "آخر عرض مرفوض" : "Last rejected quotation")}<b>{money(deal.lastClosedQuote.grandTotal)}</b></div>}
      <div className="kv">{ar ? "الاحتمال" : "Probability"}<b><span className="n">{deal.probability}%</span></b></div>
      <div className="kv">{ar ? "الكمية الشهرية المتوقعة" : "Expected monthly volume"}<b>{deal.expectedMonthlyKg !== null ? <><span className="n">{Number(deal.expectedMonthlyKg)}</span> {ar ? "كغ" : "kg"}</> : (ar ? "لم تُحدّد" : "Not set")}</b></div>
      {open
        ? <div className="kv">{ar ? "الإغلاق المتوقع" : "Expected close"}<b>{deal.expectedCloseAt ? longDate(deal.expectedCloseAt, lang) : (ar ? "غير محدد" : "Not set")}</b></div>
        : <div className="kv">{ar ? "أُغلقت" : "Closed"}<b>{deal.closedAt ? longDate(deal.closedAt, lang) : "—"}</b></div>}
      <div className="kv">{ar ? "أصل الصفقة" : "Origin"}<b>{deal.conversion
        ? <Link href={`/dashboard/sales/leads/${deal.conversion.leadId}`} style={{ color: "inherit", textDecoration: "none" }}>{ar ? "عميل محتمل · " : "Lead · "}{pick(LEAD_SOURCE_LABELS, deal.conversion.lead.source, lang)}</Link>
        : (ar ? "أُنشئت مباشرة" : "Created directly")}</b></div>
      <div className="kv" data-testid="split-list">{ar ? "توزيع العمولة" : "Commission split"}<b>
        {splits.map((o, i) => <span key={i} style={{ display: "block" }}>{o.name} · <span className="n">{o.pct}%</span></span>)}
        {can.assign && <button type="button" className="lk-inline" data-testid="edit-splits" onClick={() => setDialog("splits")}>{ar ? "تعديل" : "Edit"}</button>}
      </b></div>
      {(deal.outcome === "WON" || deal.orderLinks.length > 0) && (
        <div className="kv">{ar ? "الطلب" : "Order"}<b>{deal.orderLinks.length === 0 ? (ar ? "لم يُنشأ بعد" : "Not created yet")
          : deal.orderLinks.map((l) => <Link key={l.id} href="/dashboard/orders" style={{ color: "inherit", display: "block" }}><bdi className="id" dir="ltr">#{l.order.orderNumber}</bdi></Link>)}</b></div>
      )}
    </section>
  );
  const sideSamples = !showSamplesMain && (deal.samples.length > 0 || samplesSkipped) ? (
    <section className="pv2-panel" aria-labelledby="pv2-ss-h" data-testid="side-samples">
      <div className="h"><h2 id="pv2-ss-h">{ar ? "العيّنات" : "Samples"}</h2>
        {maySample && open && <button type="button" className="lk" data-testid="add-sample" onClick={openSample}>{ar ? "إرسال عيّنة" : "Send"}</button>}</div>
      {deal.samples.length === 0 && samplesSkipped ? (
        <>
          <span><Chip dashed label={ar ? "تُخطّيت" : "Skipped"} testId="samples-skipped" /></span>
          <p className="txt" style={{ margin: 0 }}>{skippedBecause ? <bdi>{skippedBecause}</bdi> : null}{skipEvent ? ` · ${actorName(skipEvent.actorId) ?? ""}، ${shortDate(skipEvent.createdAt, lang)}` : ""}</p>
        </>
      ) : deal.samples.map((x) => (
        <div key={x.id} data-testid={`sample-${x.id}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="kv" style={{ alignItems: "center" }}><bdi>{skuName(x.productSku, ar) ?? x.description}</bdi><b>{sampleChip(x)}</b></div>
          <span className="note">{qty(x.quantity, x.unit)}{x.sentAt ? ` · ${ar ? "أُرسلت" : "sent"} ${shortDate(x.sentAt, lang)}` : ""}</span>
          {canSend && <span className="deal-smp-act">{sampleButtons(x)}</span>}
        </div>
      ))}
    </section>
  ) : null;
  const sideQuotes = !showQuoteMain ? (
    <section className="pv2-panel" aria-labelledby="pv2-sq-h">
      <div className="h"><h2 id="pv2-sq-h">{deal.samples.length === 0 && !currentQuote && !samplesSkipped ? (ar ? "العيّنات وعروض الأسعار" : "Samples and quotations") : (ar ? "عروض الأسعار" : "Quotations")}</h2>
        {can.quote && open && <Link className="lk" href={`/dashboard/sales/quotes/new?opportunityId=${deal.id}`} data-testid="new-quote">{ar ? "عرض سعر جديد" : "New quotation"}</Link>}</div>
      {currentQuote ? (
        <div className="kv" data-testid={`quote-row-${currentQuote.quoteNumber}`}>
          <Link href={quoteHref(currentQuote.id)} style={{ color: "inherit" }}><bdi className="id" dir="ltr">{currentQuote.quoteNumber}</bdi></Link>
          <b>{ns && ns.quoteId === currentQuote.id ? <Chip tone={QUOTE_TONE[ns.quoteState]} label={L2(ns.quoteStateLabel)} /> : pick(QUOTE_STATUS_SPECS, currentQuote.status, lang)}</b>
        </div>
      ) : (
        <p className="txt" style={{ margin: 0 }}>{deal.samples.length === 0 && !samplesSkipped
          ? (ar ? "لا عيّنات ولا عروض بعد. أول عيّنة أو عرض يظهر هنا." : "No samples or quotations yet.")
          : (ar ? "لا يوجد عرض بعد. إصدار العرض ينقل الصفقة إلى «عرض السعر والتفاوض» تلقائيًا." : "No quotation yet. Issuing one moves the deal to Quotation & negotiation.")}</p>
      )}
    </section>
  ) : null;
  const contact = deal.conversion?.lead.contactName ? { name: deal.conversion.lead.contactName, phone: deal.conversion.lead.phone ?? deal.customer?.phone ?? null }
    : deal.customer ? { name: customerName ?? "", phone: deal.customer.phone } : null;
  const digits = (p: string) => p.replace(/[^\d]/g, "");
  const contactsPanel = (
    <section className="pv2-panel" aria-labelledby="pv2-ct-h">
      <div className="h"><h2 id="pv2-ct-h">{ar ? "جهات الاتصال" : "Contacts"}</h2></div>
      {customerName ? (
        <div className="kv">{ar ? "العميل" : "Customer"}<b><Link href={`/dashboard/customers/${deal.customer!.id}`} style={{ color: "inherit", textDecoration: "none" }} data-testid="deal-customer-link">{customerName}</Link></b></div>
      ) : <p className="txt" style={{ margin: 0 }}>{ar ? "لا عميل مرتبط بالصفقة بعد." : "No customer linked to this deal yet."}</p>}
      {deal.customerBalance && (
        <div className="kv">{deal.customerBalance.ar ? (ar ? "الرصيد المستحق" : "Balance due") : (ar ? "عروض مقبولة لم تُفوتر" : "Accepted, not invoiced")}
          <b data-testid="deal-customer-balance">{money(deal.customerBalance.ar ? deal.customerBalance.ar.outstanding : deal.customerBalance.outstanding)}</b></div>
      )}
      {contact && (
        <>
          <div className="pv2-ct">
            <span className="av" aria-hidden>{contact.name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("")}</span>
            <span className="tx"><b>{contact.name}</b>{contact.phone ? <span><bdi dir="ltr" className="n">{displayPhone(contact.phone)}</bdi></span> : null}</span>
          </div>
          {contact.phone && (
            <div className="pv2-ct-acts">
              <a className="btn sm" href={`tel:${contact.phone.trim().startsWith("+") ? "+" : ""}${digits(contact.phone)}`}><Ico name="phone" small />{ar ? "اتصال" : "Call"}</a>
              <a className="btn sm" href={`https://wa.me/${waDigits(contact.phone) ?? digits(contact.phone)}`} target="_blank" rel="noreferrer"><Ico name="chat" small />{ar ? "واتساب" : "WhatsApp"}</a>
            </div>
          )}
        </>
      )}
    </section>
  );

  const notice = (error || success) ? (
    <p className={`notice ${error ? "er" : "ok"}`} role={error ? "alert" : "status"} style={{ marginBottom: 16 }}
      data-testid={error ? "alert-error" : "alert-success"}>
      {error || success}
      <button type="button" onClick={() => { setError(""); setSuccess(""); }} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
    </p>
  ) : null;

  const quoteStage = stages.find((x) => x.isActive && x.purpose === "QUOTATION");
  const dealLine = `${headTitle} · ${halalas(deal.amount)} ${ar ? "⃁" : "SAR"} · ${ar ? deal.stage.nameAr : deal.stage.nameEn}`;
  const dialogs = (
    <>
      {dialog === "close" && (
        <LossSheet ar={ar} busy={busy} dealLine={dealLine} error={dialogError} onClose={() => setDialog(null)}
          onSubmit={(reason, code) => transition({ toOutcome: "LOST", lostReason: reason, ...(code ? { lostReasonCode: code } : {}) }, ar ? "سُجّلت الصفقة خاسرة." : "Deal marked lost.")} />
      )}
      {dialog === "needs" && (
        <NeedsDialog ar={ar} dealId={deal.id} needs={deal} onClose={() => setDialog(null)}
          onDone={(message) => { setDialog(null); setSuccess(message); reload(); }} />
      )}
      {dialog === "skip" && (
        <SkipSamplesSheet ar={ar} busy={busy} dealName={headTitle} error={dialogError}
          targetName={quoteStage ? (ar ? quoteStage.nameAr : quoteStage.nameEn) : skipTarget ? (ar ? skipTarget.nameAr : skipTarget.nameEn) : (ar ? "عرض السعر والتفاوض" : "Quotation")}
          onClose={() => { setDialog(null); setSkipTarget(null); }}
          onSubmit={(code, text) => transition({ skipSamples: true, skipReasonCode: code, ...(text ? { skipReason: text } : {}) },
            ar ? "تُخطّيت العيّنات ونُقلت الصفقة إلى عرض السعر والتفاوض." : "Samples skipped; moved to the quotation stage.")} />
      )}
      {dialog === "followup" && (
        <FollowUpSheet ar={ar} busy={busy} dealName={headTitle} error={dialogError} onClose={() => setDialog(null)}
          current={fuDue && fuTitle ? { dueAt: fuDue, label: dueText(fuDue, lang) } : null}
          onSubmit={(at, subject) => scheduleFollowUp(at, subject)} />
      )}
      {dialog === "move" && (
        <MoveSheet ar={ar} busy={busy} dealName={headTitle} stages={shown.filter((x) => x.isActive)} currentStageId={deal.stage.id}
          direct={moveDirect} error={dialogError} onClose={() => setDialog(null)}
          onSubmit={(to, reason) => transition({ toStageId: to, ...(reason ? { reason } : {}) }, ar ? `نُقلت الصفقة إلى ${stageName(to) ?? ""}.` : `Moved to ${stageName(to) ?? ""}.`)} />
      )}
      {dialog === "decide" && pendingMove && (
        <DecideMoveSheet ar={ar} busy={busy} error={dialogError} onClose={() => setDialog(null)}
          line={ar ? `${headTitle} · إلى «${pendingMove.toStage?.nameAr ?? ""}»${pendingMove.requestedBy ? ` · بطلب ${pendingMove.requestedBy}` : ""}${pendingMove.reason ? ` · ${pendingMove.reason}` : ""}`
            : `${headTitle} · to “${pendingMove.toStage?.nameEn ?? ""}”${pendingMove.requestedBy ? ` · by ${pendingMove.requestedBy}` : ""}`}
          onSubmit={(d, note) => decideMove(d, note)} />
      )}
      {dialog === "activity" && (
        <ActivityDialog ar={ar} opportunityId={deal.id} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); setSuccess(ar ? "سُجّل النشاط." : "Activity logged."); reload(); }} />
      )}
      {dialog === "sample" && (
        <SampleDialog ar={ar} opportunityId={deal.id} onClose={() => setDialog(null)}
          sampledProductIds={sampledProducts} manager={!!can.approveSample}
          onDone={(requested, replayed, approval) => {
            setDialog(null);
            setSuccess(replayed
              ? (ar ? "هذا الطلب مُسجّل مسبقًا؛ لم يُكرَّر." : "This request was already recorded; it was not duplicated.")
              : approval === "PENDING"
              // A rep's second sample of the product: recorded, but it waits for the manager before dispatch sees it.
              ? (ar ? "سُجّل طلب العيّنة الثانية وهو بانتظار موافقة المدير؛ لن يصل إلى قسم الشحن قبل موافقته." : "Second-sample request recorded; it awaits the sales manager's approval and reaches dispatch only once approved.")
              : approval === "APPROVED"
              ? (ar ? "سُجّلت موافقتك على العيّنة الثانية وأُرسل الطلب إلى قسم الشحن. لم يتحرك المخزون بعد." : "Your approval of the second sample is recorded and the request has gone to dispatch. No stock has moved yet.")
              : requested
              ? (ar ? "أُرسل طلب العيّنة إلى قسم الشحن. لم يتحرك المخزون بعد." : "Sample requested from dispatch. No stock has moved yet.")
              : (ar ? "سُجّلت العيّنة." : "Sample recorded."));
            reload();
          }} />
      )}
      {feedbackFor && (
        <FeedbackDialog ar={ar} sample={feedbackFor} busy={busy} onClose={() => setFeedbackFor(null)}
          onSubmit={async (score, notes) => {
            const ok = await patchSample(feedbackFor.id, { status: "FEEDBACK_RECEIVED", feedbackScore: score, feedbackNotes: notes });
            if (ok) { setFeedbackFor(null); setSuccess(ar ? "سُجّلت نتيجة العيّنة." : "Sample result recorded."); }
          }} />
      )}
      {approveFor && (
        <ApproveSampleDialog ar={ar} busy={busy} onClose={() => setApproveFor(null)}
          onSubmit={async (note) => { if (await decideSample(approveFor.id, "APPROVE", note || undefined)) setApproveFor(null); }} />
      )}
      {toCustomer === "ask" && (
        <Modal title={ar ? "الصفقة ما لها عميل" : "This deal has no customer"} onClose={() => setToCustomer(null)} testId="deal-to-customer"
          footer={<>
            <Button variant="secondary" onClick={() => setToCustomer(null)}>{ar ? "إلغاء" : "Cancel"}</Button>
            {can.makeCustomer ? <Button testId="deal-to-customer-go" onClick={() => setToCustomer("form")}>{ar ? "حوّله لعميل" : "Make it a customer"}</Button> : null}
          </>}>
          <p>{can.makeCustomer
            ? (ar ? "العيّنة تنرسل بفاتورة ضريبية باسم العميل — حوّل الصفقة لعميل أول، وبعدها تنفتح صفحة العيّنة على العميل الجديد وهالصفقة." : "A sample goes out with a tax invoice in the customer's name — make this deal a customer first; the sample page then opens on the new customer and this deal.")
            : <span data-testid="deal-to-customer-forbidden">{ar ? "ما عندك صلاحية تحوّل الصفقة لعميل — اطلب من مشرفك يسجّل العميل ويربطه بالصفقة، وبعدها ترسل العيّنة." : "You may not make this deal a customer — ask your supervisor to register the customer and link it to the deal; then send the sample."}</span>}</p>
        </Modal>
      )}
      <NewCustomerDialog open={toCustomer === "form"} ar={ar} onClose={() => setToCustomer(null)} onCreated={madeCustomer}
        initialName={deal.conversion?.lead?.companyName ?? deal.title} />
      {declineFor && (
        <DeclineSampleDialog ar={ar} busy={busy} onClose={() => setDeclineFor(null)}
          onSubmit={async (reason) => { if (await decideSample(declineFor.id, "DECLINE", reason)) setDeclineFor(null); }} />
      )}
      {dialog === "edit" && (
        <EditDialog ar={ar} deal={deal} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); setSuccess(ar ? "حُفظت التعديلات." : "Saved."); reload(); }} />
      )}
      {dialog === "splits" && (
        <SplitDialog ar={ar} deal={deal} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); setSuccess(ar ? "حُفظ التوزيع." : "Split saved."); reload(); }} />
      )}
      {toast && <AutoToast ar={ar} title={toast.title} why={toast.why} onDone={() => setToast(null)} />}
    </>
  );

  // «⋯» (IconButton 12:201): the deal's other actions, so «المطلوب منك الآن» keeps one primary button.
  const moreItems: React.ReactNode[] = [];
  if (open && can.write) moreItems.push(
    <button key="fu" type="button" role="menuitem" data-testid="menu-follow-up" onClick={() => { setMore(false); setDialogError(""); setDialog("followup"); }}>{ar ? "جدولة متابعة" : "Schedule a follow-up"}</button>,
    <button key="mv" type="button" role="menuitem" data-testid="move-deal" disabled={!!pendingMove} onClick={() => { setMore(false); setDialogError(""); setDialog("move"); }}>
      {moveDirect ? (ar ? "نقل إلى…" : "Move to…") : (ar ? "طلب نقل إلى…" : "Request a move…")}</button>,
    ...(maySample ? [<button key="smp" type="button" role="menuitem" data-testid="menu-add-sample" onClick={() => { setMore(false); openSample(); }}>{ar ? "إرسال عيّنة" : "Send a sample"}</button>] : []),
  );
  if (open && can.quote) moreItems.push(<Link key="q" role="menuitem" href={`/dashboard/sales/quotes/new?opportunityId=${deal.id}`} data-testid="menu-new-quote">{ar ? "عرض سعر جديد" : "New quotation"}</Link>);
  if (open && can.write) moreItems.push(<button key="ed" type="button" role="menuitem" data-testid="menu-edit-deal" onClick={() => { setMore(false); setDialog("edit"); }}>{ar ? "تعديل التفاصيل" : "Edit details"}</button>);
  if (open && can.close) moreItems.push(
    <button key="lose" type="button" role="menuitem" className="danger" data-testid="lose-deal" disabled={busy}
      onClick={() => { setMore(false); setDialogError(""); setDialog("close"); }}>{ar ? "تعليم خاسرة" : "Mark as lost"}</button>);

  return (
    <div className="pg">
      {notice}
      <header className="pv2-dh">
        <div className="t">
          <h1>
            <span>{headTitle}</span>
            {deal.outcome !== "OPEN"
              ? <Chip tone={deal.outcome === "WON" ? "ok" : "neutral"} label={deal.outcome === "WON" ? (ar ? "رابحة" : "Won") : (ar ? "خاسرة" : "Lost")} testId="deal-outcome" />
              : <span hidden data-testid="deal-outcome">{ar ? "مفتوحة" : "Open"}</span>}
          </h1>
          {headSub ? <div className="sub">{headSub}</div> : null}
          <div className="meta">
            <span className="amt">{money(deal.amount)}{open ? (ar ? " متوقعة" : " expected") : ""}</span>
            {deal.lastClosedQuote && <><i>·</i><span data-testid="deal-last-closed-quote">{lastClosedLine(deal.lastClosedQuote, ar)}</span></>}
            {deal.owner && <><i>·</i><span>{ar ? "المالك: " : "Owner: "}{deal.owner.name}</span></>}
            <i>·</i><span>{ar ? "أُنشئت " : "Created "}{longDate(deal.createdAt, lang)}</span>
          </div>
        </div>
        <div className="act">
          {open && can.write && (
            <button type="button" className="btn" data-testid="log-activity" onClick={() => setDialog("activity")}>
              <Ico name="phone" small />{ar ? "تسجيل نشاط" : "Log activity"}
            </button>
          )}
          {moreItems.length > 0 && (
            <div style={{ position: "relative" }} data-deal-more>
              <button type="button" className="btn g" style={{ width: 34, padding: 0, justifyContent: "center" }}
                aria-haspopup="menu" aria-expanded={more} aria-label={ar ? "إجراءات أخرى" : "More actions"}
                data-testid="deal-more" onClick={() => setMore((v) => !v)}>
                <Ico name="more" small />
              </button>
              {more && <div className="menu" role="menu" style={{ insetInlineEnd: 0, top: "calc(100% + 4px)", bottom: "auto", minWidth: 200 }}>{moreItems}</div>}
            </div>
          )}
        </div>
      </header>

      <StageStepper ar={ar} steps={steps} note={stepperNote} />

      <div className="pv2-body">
        <div className="pv2-main">
          {moveBanner}
          {nowCard}
          {phase === "QUALIFIED" && open && needsPanel}
          {showSamplesMain && samplesPanel}
          {showQuoteMain && quotePanel}
          {collectionsHere && collectionsPanel}
          {followPanel}
          {timeline}
          {!collectionsHere && collectionsPanel}
        </div>
        <aside className="pv2-side" aria-label={ar ? "تفاصيل" : "Details"}>
          {detailsPanel}
          {sideSamples}
          {sideQuotes}
          {contactsPanel}
        </aside>
      </div>
      {dialogs}
    </div>
  );
}


function ActivityDialog({
  ar, opportunityId, onClose, onDone,
}: {
  ar: boolean; opportunityId: string; onClose: () => void; onDone: () => void;
}) {
  const [type, setType] = useState("CALL");
  const [outcome, setOutcome] = useState("NOTE_ONLY");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [completed, setCompleted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const isTask = type === "TASK";

  return (
    <Modal
      title={ar ? "تسجيل نشاط" : "Log an activity"}
      onClose={onClose}
      testId="activity-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || subject.trim().length < 2 || (isTask && !dueAt)}
            testId="save-activity"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api("/api/sales/activities", {
                method: "POST",
                body: {
                  type, subject, body, opportunityId,
                  outcome: isTask ? undefined : outcome,
                  dueAt: dueAt || null,
                  completed: isTask ? false : completed,
                },
              });
              setBusy(false);
              if (res.ok) onDone();
              else setErr(res.data.error ?? "");
            }}
          >
            {ar ? "حفظ" : "Save"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}
      <Field id="act-type" label={ar ? "النوع" : "Type"}>
        <Select id="act-type" value={type} onChange={setType}>
          {Object.keys(ACTIVITY_LABELS).map((k) => (
            <option key={k} value={k}>{pick(ACTIVITY_LABELS, k, ar ? "ar" : "en")}</option>
          ))}
        </Select>
      </Field>
      {/* D6.1: the outcome, as the lead page records it. On a deal it is a record only — no
          automation reads it (`qualification` acts on leads). */}
      {!isTask && (
        <Field id="act-outcome" label={ar ? "ماذا حدث؟" : "What happened?"}>
          <Select id="act-outcome" value={outcome} onChange={setOutcome}>
            {ACTIVITY_OUTCOMES.map((o) => (
              <option key={o} value={o}>{pick(OUTCOME_LABELS, o, ar ? "ar" : "en")}</option>
            ))}
          </Select>
        </Field>
      )}
      <Field id="act-subject" label={ar ? "الموضوع" : "Subject"} required>
        <TextInput id="act-subject" value={subject} onChange={setSubject} />
      </Field>
      <Field id="act-body" label={ar ? "التفاصيل" : "Details"}>
        <TextArea id="act-body" value={body} onChange={setBody} rows={3} />
      </Field>
      <Field
        id="act-due"
        label={ar ? "تاريخ الاستحقاق" : "Due date"}
        required={isTask}
        hint={isTask ? (ar ? "المهمة بلا تاريخ لا تظهر في المتأخرات أبداً." : "A task with no due date never appears on an overdue list.") : undefined}
      >
        <TextInput id="act-due" type="date" value={dueAt} onChange={setDueAt} />
      </Field>
      {!isTask && (
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={completed}
            onChange={(e) => setCompleted(e.target.checked)}
            className="w-4 h-4 accent-orange"
          />
          {ar ? "حدث بالفعل" : "This already happened"}
        </label>
      )}
      <p className="text-[11px] text-oo-text-muted font-medium">
        {ar
          ? "هذا تسجيل لما حدث. لا يُرسل بريداً ولا رسالة."
          : "This records that contact happened. It does not send an email or a message."}
      </p>
    </Modal>
  );
}

/** «تسجيل النتيجة»: what the customer thought of a sent sample — the existing score (1–5) and notes. */
function FeedbackDialog({
  ar, sample, busy, onClose, onSubmit,
}: {
  ar: boolean; sample: Deal["samples"][number]; busy: boolean; onClose: () => void;
  onSubmit: (score: number, notes: string) => void;
}) {
  const [score, setScore] = useState("");
  const [notes, setNotes] = useState(sample.feedbackNotes ?? "");
  return (
    <Modal
      title={ar ? "نتيجة العيّنة" : "Sample result"}
      onClose={onClose}
      testId="sample-feedback-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button disabled={busy || !score} testId="save-sample-feedback" onClick={() => onSubmit(Number(score), notes)}>
            {ar ? "حفظ" : "Save"}
          </Button>
        </>
      }
    >
      <p data-ui="field-hint"><bdi>{skuName(sample.productSku, ar) ?? sample.description}</bdi></p>
      <Field id="smp-score" label={ar ? "تقييم العميل" : "Customer's score"} required>
        <Select id="smp-score" value={score} onChange={setScore}>
          <option value="">{ar ? "— اختر —" : "— choose —"}</option>
          {[5, 4, 3, 2, 1].map((n) => <option key={n} value={String(n)}>{n} / 5</option>)}
        </Select>
      </Field>
      <Field id="smp-notes" label={ar ? "ماذا قال العميل" : "What the customer said"}>
        <TextArea id="smp-notes" value={notes} onChange={setNotes} rows={3} />
      </Field>
    </Modal>
  );
}

/** The manager declines a customer's second sample of a product: the reason is required (the rep reads it). */
/** D22 gate (owner 4أ): the manager approves a repeat sample with an optional note, kept on the request (approvalNote). */
function ApproveSampleDialog({
  ar, busy, onClose, onSubmit,
}: {
  ar: boolean; busy: boolean; onClose: () => void; onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Modal
      title={ar ? "الموافقة على العيّنة الثانية" : "Approve the second sample"}
      onClose={onClose}
      testId="sample-approve-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button disabled={busy} testId="confirm-sample-approve" onClick={() => onSubmit(note.trim())}>
            {ar ? "موافقة" : "Approve"}
          </Button>
        </>
      }
    >
      <Field id="smp-approve" label={ar ? "ملاحظة الموافقة (اختيارية)" : "Approval note (optional)"}>
        <TextArea id="smp-approve" value={note} onChange={setNote} rows={3} />
      </Field>
      <p data-ui="field-hint">{ar ? "تنحفظ مع الطلب ويشوفها المندوب، والطلب يروح لقسم الشحن." : "Kept on the request for the rep to read; the request goes to dispatch."}</p>
    </Modal>
  );
}

function DeclineSampleDialog({
  ar, busy, onClose, onSubmit,
}: {
  ar: boolean; busy: boolean; onClose: () => void; onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      title={ar ? "رفض العيّنة الثانية" : "Decline the second sample"}
      onClose={onClose}
      testId="sample-decline-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button disabled={busy || !reason.trim()} testId="confirm-sample-decline" onClick={() => onSubmit(reason.trim())}>
            {ar ? "رفض الطلب" : "Decline request"}
          </Button>
        </>
      }
    >
      <Field id="smp-decline" label={ar ? "سبب الرفض" : "Reason"} required>
        <TextArea id="smp-decline" value={reason} onChange={setReason} rows={3} />
      </Field>
      <p data-ui="field-hint">{ar ? "يُلغى الطلب ولا يُحسب عيّنة للعميل." : "The request is cancelled and does not count as a sample for the customer."}</p>
    </Modal>
  );
}

function EditDialog({
  ar, deal, onClose, onDone,
}: {
  ar: boolean; deal: Deal; onClose: () => void; onDone: () => void;
}) {
  const [title, setTitle] = useState(deal.title);
  const [amount, setAmount] = useState(String(deal.amount));
  const [probability, setProbability] = useState(String(deal.probability));
  const [expectedCloseAt, setExpectedCloseAt] = useState(deal.expectedCloseAt?.slice(0, 10) ?? "");
  // Gate B2: the follow-up is shown as its RIYADH day (a follow-up after 21:00 UTC is the next day there), and sent only
  // when it is changed — an overdue follow-up never blocks renaming the deal or changing its amount.
  const followUpDay = deal.nextFollowUpAt ? riyadhDayOf(new Date(deal.nextFollowUpAt)) : "";
  const [nextFollowUpAt, setNextFollowUpAt] = useState(followUpDay);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  return (
    <Modal
      title={ar ? "تعديل الصفقة" : "Edit the deal"}
      onClose={onClose}
      testId="edit-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || title.trim().length < 2}
            testId="save-deal"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api(`/api/sales/opportunities/${deal.id}`, {
                method: "PATCH",
                body: {
                  title,
                  amount,
                  probability: Number(probability),
                  expectedCloseAt: expectedCloseAt || null,
                  ...(nextFollowUpAt !== followUpDay ? { nextFollowUpAt: nextFollowUpAt || null } : {}),
                },
              });
              setBusy(false);
              if (res.ok) onDone();
              else setErr(res.data.error ?? "");
            }}
          >
            {ar ? "حفظ" : "Save"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}
      <Field id="d-title" label={ar ? "العنوان" : "Title"} required>
        <TextInput id="d-title" value={title} onChange={setTitle} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="d-amount" label={ar ? "القيمة المتوقعة (SAR)" : "Expected value (SAR)"}>
          <TextInput id="d-amount" value={amount} onChange={setAmount} inputMode="decimal" />
        </Field>
        <Field id="d-prob" label={ar ? "الاحتمال %" : "Probability %"}>
          <TextInput id="d-prob" value={probability} onChange={setProbability} inputMode="numeric" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field id="d-close" label={ar ? "الإغلاق المتوقع" : "Expected close"}>
          <TextInput id="d-close" type="date" value={expectedCloseAt} onChange={setExpectedCloseAt} />
        </Field>
        <Field id="d-follow" label={ar ? "المتابعة القادمة" : "Next follow-up"}>
          <TextInput id="d-follow" type="date" value={nextFollowUpAt} onChange={setNextFollowUpAt} />
        </Field>
      </div>
    </Modal>
  );
}

function SplitDialog({
  ar, deal, onClose, onDone,
}: {
  ar: boolean; deal: Deal; onClose: () => void; onDone: () => void;
}) {
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<{ employeeId: string; sharePercent: string }[]>(
    deal.owners.length > 0
      ? deal.owners.map((o) => ({ employeeId: o.employee.id, sharePercent: String(o.sharePercent) }))
      : [{ employeeId: deal.owner?.id ?? "", sharePercent: "100" }],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    // The roster endpoint answers with a bare array. Non-admin callers get id, name, role
    // and active only — no permissions blob and no credential fields.
    api<{ id: string; name: string; active: boolean }[]>("/api/employees").then((r) => {
      if (r.ok && Array.isArray(r.data)) {
        setEmployees(r.data.filter((e) => e.active !== false).map((e) => ({ id: e.id, name: e.name })));
      }
    });
  }, []);

  const total = rows.reduce((acc, r) => acc + (Number(r.sharePercent) || 0), 0);
  const balanced = Math.abs(total - 100) < 0.005;

  return (
    <Modal
      title={ar ? "توزيع العمولة" : "Commission split"}
      onClose={onClose}
      testId="split-dialog"
      wide
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => setRows([...rows, { employeeId: "", sharePercent: "0" }])}
            testId="add-split-row"
          >
            <Plus size={14} aria-hidden /> {ar ? "إضافة" : "Add"}
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || !balanced || rows.some((r) => !r.employeeId)}
            testId="save-splits"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api(`/api/sales/opportunities/${deal.id}/owners`, {
                method: "PUT",
                body: { splits: rows },
              });
              setBusy(false);
              if (res.ok) onDone();
              else setErr(res.data.error ?? "");
            }}
          >
            {ar ? "حفظ" : "Save"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2 items-end" data-testid={`split-row-${i}`}>
            <div className="flex-1">
              <Field id={`split-emp-${i}`} label={ar ? "الموظف" : "Employee"}>
                <Select
                  id={`split-emp-${i}`}
                  value={r.employeeId}
                  onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, employeeId: v } : x)))}
                >
                  <option value="">—</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="w-28">
              <Field id={`split-pct-${i}`} label="%">
                <TextInput
                  id={`split-pct-${i}`}
                  value={r.sharePercent}
                  inputMode="decimal"
                  onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, sharePercent: v } : x)))}
                />
              </Field>
            </div>
            <Button variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</Button>
          </div>
        ))}
      </div>
      <div
        className={`text-sm font-bold ${balanced ? "text-oo-status-success" : "text-oo-status-rejected"}`}
        data-testid="split-total"
        role="status"
      >
        {ar ? "الإجمالي" : "Total"}: {total.toFixed(2)}%
        {!balanced && ` — ${ar ? "يجب أن يساوي 100" : "must equal 100"}`}
      </div>
      <p className="text-[11px] text-oo-text-muted font-medium">
        {ar
          ? "التوزيع يقسّم الأساس قبل الشرائح، لا العمولة النهائية. والاستحقاقات السابقة لا تتغيّر."
          : "Splits divide the base before tiers, not the finished commission. Accruals already written do not change."}
      </p>
    </Modal>
  );
}

/** «آخر عرض مرفوض: 1,150.00 ⃁» (soon batch round 2): the offer stays visible while the deal is worth 0.00. */
function lastClosedLine(q: { status: string; quoteNumber: string; grandTotal: string }, ar: boolean): string {
  const word = q.status === "EXPIRED" ? (ar ? "آخر عرض منتهي" : "Last expired quotation") : (ar ? "آخر عرض مرفوض" : "Last rejected quotation");
  const n = Number(q.grandTotal).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return ar ? `${word}: ${n} ⃁` : `${word}: SAR ${n}`;
}
