"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import {
  useLang, pick, Alert, Spinner, Button, Field, TextInput, Select, TextArea, Modal, api,
  QUOTE_STATUS_SPECS, LEAD_SOURCE_LABELS,
} from "../../_components/ui";
import { Ico } from "@/components/shell/icons";
import { useD21Title, usePhone, useD21Phone } from "@/components/shell/page-context";
import { splitTitle } from "@/components/d21/labels";
import { ACTIVITY_OUTCOMES } from "@/lib/services/sales/qualification";
import {
  currencyLabel, dayCount, dayUnit, daysFromToday, dueText, money2, relativeDays, shortDate, whole,
} from "@/components/d21/format";
import { CollectionsPanel, type CollectionRow, type Summary } from "./CollectionsPanel";

/**
 * Deal detail — built to the approved frame `crm-deal` (Figma `176:1032` / `177:1168`;
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
  closedAt: string | null;
  amount: string;
  currency: string;
  probability: number;
  expectedCloseAt: string | null;
  nextFollowUpAt: string | null;
  createdAt: string;
  stage: { id: string; code: string; nameEn: string; nameAr: string; probability: number };
  customer: { id: string; name: string; nameAr: string | null; phone: string | null; email: string | null } | null;
  owner: { id: string; name: string } | null;
  owners: { id: string; sharePercent: string; effectiveFrom: string; employee: { id: string; name: string } }[];
  conversion: { leadId: string; convertedAt: string; convertedById: string | null; lead: { companyName: string; contactName: string; phone: string | null; source: string } } | null;
  quotes: {
    id: string; quoteNumber: string; revision: number; status: string; currency: string;
    validUntil: string | null; grandTotal: string; taxTotal: string; issuedAt: string | null; acceptedAt: string | null;
    lines: { taxRatePercent: string }[];
    _count: { lines: number; orderLinks: number };
  }[];
  samples: {
    id: string; description: string | null; quantity: string; unit: string; status: string;
    sentAt: string | null; feedbackScore: number | null; feedbackNotes: string | null;
    productSku: { id: string; skuCode: string; name: string | null } | null;
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

type Stage = { id: string; code: string; nameEn: string; nameAr: string; position: number; probability: number; isActive: boolean };

type Can = {
  write: boolean; close: boolean; reopen: boolean; quote: boolean;
  approveDiscount: boolean; assign: boolean; createOrder: boolean;
  submitCollection?: boolean; verifyCollection?: boolean;
  rejectCollection?: boolean; reverseCollection?: boolean;
};


const SAMPLE_LABELS: Record<string, { en: string; ar: string }> = {
  PREPARING: { en: "Preparing", ar: "قيد التحضير" },
  SENT: { en: "Sent", ar: "أُرسلت" },
  FEEDBACK_RECEIVED: { en: "Feedback received", ar: "وصل التقييم" },
  CANCELLED: { en: "Cancelled", ar: "ملغاة" },
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
  KG: { en: "kg", ar: "كغ" }, G: { en: "g", ar: "غ" }, PCS: { en: "pcs", ar: "قطعة" },
};

const ACTIVITY_LABELS: Record<string, { en: string; ar: string }> = {
  CALL: { en: "Call", ar: "مكالمة" }, // CRM.md D6
  VISIT: { en: "Visit", ar: "زيارة" },
  MEETING: { en: "Meeting", ar: "اجتماع" },
  NOTE: { en: "Note", ar: "ملاحظة" },
  TASK: { en: "Task", ar: "مهمة" },
  SAMPLE_FOLLOW_UP: { en: "Sample follow-up", ar: "متابعة عينة" },
};

export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const lang = useLang();
  const ar = lang === "ar";

  const [deal, setDeal] = useState<Deal | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  // Employee names for the history lines whose record names who did it.
  const [actors, setActors] = useState<Record<string, string>>({});
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [collectionSummary, setCollectionSummary] = useState<Summary | null>(null);
  // The server's verdict on whether this person may record a collection here, and if not
  // why. Not derived on the client: see `collectionAction` in services/sales/collections.
  const [collectionAction, setCollectionAction] =
    useState<{ available: boolean; reason: string }>({ available: false, reason: "NO_PRIVILEGE" });
  const [can, setCan] = useState<Can | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  const [dialog, setDialog] = useState<"activity" | "sample" | "close" | "edit" | "splits" | null>(null);
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
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<{
        deal: Deal; stages: Stage[]; actors: Record<string, string>; can: Can;
        collections: CollectionRow[]; collectionSummary: Summary;
        collectionAction: { available: boolean; reason: string };
      }>(`/api/sales/opportunities/${id}`);
      if (cancelled) return;
      if (res.ok) {
        setDeal(res.data.deal);
        setStages(res.data.stages);
        setActors(res.data.actors ?? {});
        setCan(res.data.can);
        setCollections(res.data.collections ?? []);
        setCollectionSummary(res.data.collectionSummary ?? null);
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
    ownBar: true,
  });
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
    setError("");
    const res = await api(`/api/sales/opportunities/${id}/transition`, { method: "POST", body });
    setBusy(false);
    if (!res.ok) {
      setError(res.data.error ?? (ar ? "تعذّر التنفيذ." : "Could not do that."));
      return false;
    }
    setSuccess(okMessage);
    setDialog(null);
    reload();
    return true;
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
  const cur = currencyLabel(deal.currency, lang);
  const acceptedQuote = deal.quotes.find((q) => q.status === "ACCEPTED");
  const qty = (q: string, unit: string) =>
    `${unit === "KG" ? money2(q) : q} ${UNIT_LABELS[unit] ? pick(UNIT_LABELS, unit, lang) : unit}`;

  // ── Stages: the ordered active ones, plus the deal's own if it has since been retired.
  const shown = stages.filter((s) => s.isActive || s.id === deal.stage.id).sort((a, b) => a.position - b.position);
  const atIdx = shown.findIndex((s) => s.id === deal.stage.id);
  const nextStage = atIdx >= 0 ? shown[atIdx + 1] : undefined;
  const stageById = new Map(stages.map((s) => [s.id, s]));
  // When the deal reached each stage: the latest event into it.
  const reached = new Map<string, string>();
  for (const e of deal.stageEvents) if (e.toStageId && !reached.has(e.toStageId)) reached.set(e.toStageId, e.createdAt);
  const inStageSince = reached.get(deal.stage.id) ?? deal.createdAt;
  const inStageDays = Math.max(0, -daysFromToday(inStageSince));

  // ── The one next step: the open activity due soonest; an undated one only if nothing is dated.
  const openActivities = deal.activities.filter((a) => !a.completedAt);
  const nextStep = [...openActivities].sort((a, b) =>
    (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity))[0];
  const lateBy = nextStep?.dueAt && new Date(nextStep.dueAt) < new Date() ? Math.max(1, -daysFromToday(nextStep.dueAt)) : 0;

  // ── The primary action (reference: «التالي: تفاوض»). Moving the deal on is the default;
  //    once a quotation is accepted, or at the last stage, it is marking the deal won.
  const winButton = (primary: boolean) => (
    <button type="button" className={`btn${primary ? " p" : ""}`} data-testid="win-deal" disabled={busy}
      onClick={() => transition({ toOutcome: "WON" }, ar ? "سُجّلت الصفقة رابحة." : "Deal marked won.")}>
      {ar ? "تعليم رابحة" : "Mark won"}
    </button>
  );
  // Offered exactly when the server would accept it (`transitionOpportunity`): the close
  // privilege, a linked customer and an accepted quotation. The stage plays no part — reaching
  // the last stage does not make a deal winnable, and these rules are not changed here.
  const winnable = open && can.close && !!deal.customer && !!acceptedQuote;
  let primary: React.ReactNode = null;
  if (winnable) primary = winButton(true);
  else if (open && can.write && nextStage) {
    primary = (
      <button type="button" className="btn p" data-testid="next-stage" disabled={busy}
        onClick={() => transition({ toStageId: nextStage.id }, ar ? `نُقلت إلى ${nextStage.nameAr}.` : `Moved to ${nextStage.nameEn}.`)}>
        {ar ? `التالي: ${nextStage.nameAr}` : `Next: ${nextStage.nameEn}`}
      </button>
    );
  }

  // ── The activity timeline: what happened on the deal, newest first — activities, samples
  //    sent, quotations issued and accepted, stage and outcome changes, the conversion.
  type Entry = { key: string; at: string; kind: string; title: React.ReactNode; detail?: React.ReactNode;
    when: string; diff?: string; activity?: Deal["activities"][number] };
  const entries: Entry[] = [];
  const stageName = (sid: string | null | undefined) => {
    const s = sid ? stageById.get(sid) : undefined;
    return s ? (ar ? s.nameAr : s.nameEn) : null;
  };
  const stageDiffs: { at: number; text: string; used: boolean }[] = deal.stageEvents
    // The stage a deal starts in is not a change; only moves get the «A ← B» chip.
    .filter((e) => e.toStageId && e.fromStageId)
    .map((e) => {
      const from = stageName(e.fromStageId), to = stageName(e.toStageId) ?? (e.toStage ? L(e.toStage) : "");
      return { at: new Date(e.createdAt).getTime(), text: `${ar ? "المرحلة" : "Stage"}: ${from ? `${from} ${ar ? "←" : "→"} ` : ""}${to}`, used: false };
    });
  const claimDiff = (at: string) => {
    const t = new Date(at).getTime();
    const d = stageDiffs.find((x) => !x.used && Math.abs(x.at - t) < 120_000);
    if (d) d.used = true;
    return d?.text;
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
      title: <>{ar ? "أُرسلت عيّنة" : "Sample sent"} · <bdi>{s.productSku?.name ?? s.productSku?.skuCode ?? s.description}</bdi></>,
      // In a sentence the quantity reads plainly («2 كغ»); the samples table keeps two decimals.
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
      when: shortDate(q.issuedAt, lang), diff: claimDiff(q.issuedAt),
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
    when: `${shortDate(deal.conversion.convertedAt, lang)}${by(actorName(deal.conversion.convertedById))}`, diff: claimDiff(deal.conversion.convertedAt),
  });
  for (const e of deal.stageEvents) {
    if (e.toOutcome && e.toOutcome !== "OPEN") {
      entries.push({ key: `o-${e.id}`, at: e.createdAt, kind: "outcome",
        title: e.toOutcome === "WON" ? (ar ? "رُبحت الصفقة" : "Deal won") : (ar ? "خُسرت الصفقة" : "Deal lost"),
        detail: e.reason ?? undefined, when: `${shortDate(e.createdAt, lang)}${by(actorName(e.actorId))}` });
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
    entries.push({ key: `st-${e.id}`, at: e.createdAt, kind: "stage",
      title: ar ? `انتقلت إلى ${stageName(e.toStageId) ?? ""}` : `Moved to ${stageName(e.toStageId) ?? ""}`,
      detail: e.reason ?? undefined, when: `${shortDate(e.createdAt, lang)}${by(actorName(e.actorId))}`, diff: d.text });
  }
  // Open follow-ups first (they are what is due), then the history newest first.
  entries.sort((a, b) => {
    const ao = a.activity && !a.activity.completedAt ? 1 : 0, bo = b.activity && !b.activity.completedAt ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  });
  const visible = allEntries ? entries : entries.slice(0, 20);

  // The «mark sent» column exists only while a sample is still being prepared.
  const canSend = can.write && deal.samples.some((x) => x.status === "PREPARING");

  // Collections: under the quotations once there is something to collect against; before
  // that only the panel's reason («no accepted quotation yet») is useful, so it waits at the
  // end of the main column instead of pushing the frame's sections down.
  const collectionsHere = !!collectionSummary && (!!collectionSummary.document || collections.length > 0);
  const collectionsPanel = collectionSummary ? (
    <div style={{ marginBottom: 32 }}>
      <CollectionsPanel dealId={id} ar={ar} lang={lang} summary={collectionSummary} rows={collections}
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

  const notYet = <span style={{ color: "var(--text-muted)" }}>{ar ? "غير متوفر بعد" : "Not available yet"}</span>;

  // ── Sections shared by the desktop and phone layouts ──
  const samplesBlock = (
    <>
      {/* ── Samples ── */}
      <div className="bh">
        <h2 className="bt">{ar ? "العيّنات" : "Samples"}</h2>
        {can.write && open && (
          <button type="button" className="lk" data-testid="add-sample" onClick={() => setDialog("sample")}>
            <Ico name="plus" small />{ar ? "عيّنة" : "Sample"}
          </button>
        )}
      </div>
      {deal.samples.length === 0 ? (
        <p className="lbl" style={{ fontWeight: 400, margin: "0 0 32px" }}>{ar ? "لا توجد عيّنات." : "No samples."}</p>
      ) : (
        <div style={{ overflowX: "auto", marginBottom: 32 }}>
          <table className="t dense"><tbody>
            {deal.samples.map((s) => (
              <tr key={s.id} data-testid={`sample-${s.id}`}>
                <td><span className="who">{s.productSku?.name ?? s.productSku?.skuCode ?? s.description}</span>
                  {s.description && s.productSku && <span className="sm"> · {s.description}</span>}</td>
                <td className="num">{qty(s.quantity, s.unit)}</td>
                <td><span className={`st ${SAMPLE_ST[s.status] ?? ""}`}>{pick(SAMPLE_LABELS, s.status, lang)}</span></td>
                <td className="sm">
                  {s.sentAt ? shortDate(s.sentAt, lang) : ""}
                  {s.feedbackScore !== null && <> · {ar ? "التقييم" : "score"} {s.feedbackScore}/5</>}
                </td>
                {canSend && <td style={{ textAlign: "end" }}>
                  {s.status === "PREPARING" && can.write && (
                    <button type="button" className="btn sm" data-testid={`send-sample-${s.id}`} disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        const res = await api(`/api/sales/samples/${s.id}`, { method: "PATCH", body: { status: "SENT" } });
                        setBusy(false);
                        if (res.ok) reload(); else setError(res.data.error ?? "");
                      }}>
                      {ar ? "تعليم مُرسلة" : "Mark sent"}
                    </button>
                  )}
                </td>}
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </>
  );
  const activityBlock = (
    <>
      {/* ── Activity ── */}
      <div className="bh">
        <h2 className="bt">{ar ? "النشاط" : "Activity"}</h2>
        <span className="sub">{ar ? "مكالمات، زيارات، عيّنات، عروض" : "Calls, visits, samples, quotations"}</span>
      </div>
      {entries.length === 0 ? (
        <p className="lbl" style={{ fontWeight: 400 }}>{ar ? "لم يُسجَّل أي نشاط." : "Nothing logged yet."}</p>
      ) : (
        <ol className="tl" data-testid="deal-activities">
          {visible.map((e, i) => {
            const a = e.activity;
            const openA = a && !a.completedAt;
            const late = openA && a.dueAt && new Date(a.dueAt) < new Date();
            return (
              <li key={e.key} data-kind={e.kind} data-testid={a ? `activity-${a.id}` : undefined}>
                <span className={`m${i === 0 && !openA ? " b" : ""}`} />
                <div className="row" style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
                  <span>{e.title}</span>
                  {late && <span className="flag">{ar ? "متأخرة" : "Overdue"}</span>}
                  <span className="when" style={{ marginInlineStart: "auto", whiteSpace: "nowrap" }}>{e.when}</span>
                </div>
                {e.detail && <div style={{ color: "var(--text-secondary)", marginTop: 4, maxWidth: "60ch", overflowWrap: "anywhere" }} dir="auto">{e.detail}</div>}
                {e.diff && <span className="diff">{e.diff}</span>}
                {openA && can.write && a.id !== nextStep?.id && (
                  <div style={{ marginTop: 6 }}>
                    <button type="button" className="btn sm" data-testid={`complete-${a.id}`} disabled={busy} onClick={() => complete(a.id)}>
                      {ar ? "إكمال" : "Complete"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {entries.length > 20 && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
          <span data-testid="deal-activities-count">
            {ar ? "يُعرض " : "Showing "}<bdi className="n">{visible.length}</bdi>{ar ? " من " : " of "}<bdi className="n">{entries.length}</bdi>
          </span>
          <button type="button" className="btn sm" data-testid="toggle-all-activities" aria-expanded={allEntries}
            onClick={() => setAllEntries((v) => !v)} style={{ marginInlineStart: "auto" }}>
            {allEntries ? (ar ? "عرض أقل" : "Show fewer") : (ar ? "عرض الكل" : "Show all")}
          </button>
        </div>
      )}
    </>
  );
  const customerBlock = (
    <>
      <div className="lbl" style={{ marginBottom: 12 }}>{ar ? "العميل" : "Customer"}</div>
      {customerName ? (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            <Link href={`/dashboard/customers/${deal.customer!.id}`} style={{ color: "inherit", textDecoration: "none" }} data-testid="deal-customer-link">{customerName}</Link>
          </div>
          {/* CRM.md backend dependencies: no customer AR balance, open-order query or
              contacts relation exists yet, so these say so rather than show a figure. */}
          <dl className="props" style={{ marginBottom: 24 }}>
            <dt>{ar ? "الرصيد المستحق" : "Balance due"}</dt><dd>{notYet}</dd>
            <dt>{ar ? "طلب مفتوح" : "Open order"}</dt><dd>{notYet}</dd>
            {/* The contact is the person on the lead this deal came from. Without one, the
                customer's own phone is shown under its own name, not passed off as a person. */}
            {deal.conversion?.lead.contactName ? (
              <>
                <dt>{ar ? "جهة الاتصال" : "Contact"}</dt>
                <dd>
                  {deal.conversion.lead.contactName}
                  {deal.conversion.lead.phone && <> · <bdi dir="ltr" className="n">{deal.conversion.lead.phone}</bdi></>}
                </dd>
                {/* The customer's own number is not the contact's: named separately. */}
                {!deal.conversion.lead.phone && deal.customer?.phone && (
                  <><dt>{ar ? "هاتف العميل" : "Customer phone"}</dt><dd><bdi dir="ltr" className="n">{deal.customer.phone}</bdi></dd></>
                )}
              </>
            ) : deal.customer?.phone ? (
              <><dt>{ar ? "هاتف العميل" : "Customer phone"}</dt><dd><bdi dir="ltr" className="n">{deal.customer.phone}</bdi></dd></>
            ) : (
              <><dt>{ar ? "جهة الاتصال" : "Contact"}</dt><dd>{notYet}</dd></>
            )}
          </dl>
        </>
      ) : (
        <p style={{ color: "var(--text-muted)", fontSize: 13.5, margin: "0 0 24px" }}>
          {ar ? "لا عميل مرتبط بالصفقة بعد." : "No customer linked to this deal yet."}
        </p>
      )}
    </>
  );
  const detailsBlock = (
    <>
      <div className="lbl" style={{ marginBottom: 12, display: "flex", alignItems: "baseline" }}>
        {ar ? "التفاصيل" : "Details"}
        {can.write && open && (
          <button type="button" className="lk-inline" data-testid="edit-deal" onClick={() => setDialog("edit")}>
            {ar ? "تعديل" : "Edit"}
          </button>
        )}
      </div>
      <dl className="props">
        <dt>{ar ? "المرحلة" : "Stage"}</dt><dd>{ar ? deal.stage.nameAr : deal.stage.nameEn}</dd>
        <dt>{ar ? "توزيع العمولة" : "Commission split"}</dt>
        <dd data-testid="split-list">
          {(deal.owners.length > 0
            ? deal.owners.map((o) => ({ name: o.employee.name, pct: Number(o.sharePercent) }))
            : deal.owner ? [{ name: deal.owner.name, pct: 100 }] : []).map((o, i) => (
            <div key={i}>{o.name} · <span className="n">{o.pct}%</span>
              {i === 0 && can.assign && (
                <button type="button" className="lk-inline" data-testid="edit-splits" onClick={() => setDialog("splits")}>
                  {ar ? "تعديل" : "Edit"}
                </button>
              )}
            </div>
          ))}
        </dd>
        <dt>{ar ? "أصل الصفقة" : "Deal origin"}</dt>
        <dd>{deal.conversion
          ? <Link href={`/dashboard/sales/leads/${deal.conversion.leadId}`} style={{ color: "inherit", textDecoration: "none" }}>{ar ? "عميل محتمل · " : "Lead · "}{pick(LEAD_SOURCE_LABELS, deal.conversion.lead.source, lang)}</Link>
          : (ar ? "أُنشئت مباشرة" : "Created directly")}</dd>
        <dt>{ar ? "العملة" : "Currency"}</dt><dd>{cur}</dd>
        <dt>{ar ? "طلبات مرتبطة" : "Linked orders"}</dt>
        <dd>{deal.orderLinks.length === 0
          ? <span style={{ color: "var(--text-muted)" }}>{ar ? "تُنشأ بعد قبول العرض" : "Created once the quotation is accepted"}</span>
          : deal.orderLinks.map((l) => (
            <div key={l.id}><Link href="/dashboard/orders" style={{ color: "inherit" }}><bdi className="id" dir="ltr">#{l.order.orderNumber}</bdi></Link> · {l.order.status}{l.isFirstOrder ? (ar ? " · الأول" : " · first") : ""}</div>
          ))}</dd>
      </dl>
    </>
  );

  const notice = (
    <>
  {(error || success) && (
    <p className={`notice ${error ? "er" : "ok"}`} role={error ? "alert" : "status"} style={{ marginBottom: 16 }}
      data-testid={error ? "alert-error" : "alert-success"}>
      {error || success}
      <button type="button" onClick={() => { setError(""); setSuccess(""); }} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
    </p>
  )}
    </>
  );
  const dialogs = (
    <>
  {dialog === "close" && (
    <LostDialog ar={ar} busy={busy} onClose={() => setDialog(null)}
      onSubmit={(reason) => transition({ toOutcome: "LOST", lostReason: reason }, ar ? "سُجّلت الصفقة خاسرة." : "Deal marked lost.")} />
  )}
  {dialog === "activity" && (
    <ActivityDialog ar={ar} opportunityId={deal.id} onClose={() => setDialog(null)}
      onDone={() => { setDialog(null); setSuccess(ar ? "سُجّل النشاط." : "Activity logged."); reload(); }} />
  )}
  {dialog === "sample" && (
    <SampleDialog ar={ar} opportunityId={deal.id} onClose={() => setDialog(null)}
      onDone={() => { setDialog(null); setSuccess(ar ? "سُجّلت العيّنة." : "Sample recorded."); reload(); }} />
  )}
  {dialog === "edit" && (
    <EditDialog ar={ar} deal={deal} onClose={() => setDialog(null)}
      onDone={() => { setDialog(null); setSuccess(ar ? "حُفظت التعديلات." : "Saved."); reload(); }} />
  )}
  {dialog === "splits" && (
    <SplitDialog ar={ar} deal={deal} onClose={() => setDialog(null)}
      onDone={() => { setDialog(null); setSuccess(ar ? "حُفظ التوزيع." : "Split saved."); reload(); }} />
  )}
    </>
  );

  // ── Phone (below 768): the 390 frame `178:1285` ──
  // Status line, three figures as rows, the next step, the current quotations, the latest
  // activity, and a sticky bar with the page's primary action and «⋯». What the frame does not
  // draw but carries a function of this page (samples, collection, customer, details, the full
  // history) follows in the desktop order; nothing is dropped.
  if (phone) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const dueShort = (v: string) => { const d = new Date(v); return `${shortDate(d, lang)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const current = deal.quotes.filter((q) => q.status !== "SUPERSEDED");
    const latest = allEntries ? entries : entries.slice(0, 2);
    // D6.1 (owner, 15 Oct): the bar's primary is «تسجيل نتيجة المكالمة» as in the frame — it
    // opens the same log-activity dialog, which records a new activity with its outcome. It
    // does not complete the open follow-up; that stays «إكمال» in the next-step band. Moving
    // the deal on («التالي») and marking it won keep their permissions, under «⋯».
    const moreItems: React.ReactNode[] = [];
    if (open && can.write && nextStage) moreItems.push(
      <button key="next" type="button" role="menuitem" data-testid="next-stage" disabled={busy}
        onClick={() => { setMore(false); transition({ toStageId: nextStage.id }, ar ? `نُقلت إلى ${nextStage.nameAr}.` : `Moved to ${nextStage.nameEn}.`); }}>
        {ar ? `التالي: ${nextStage.nameAr}` : `Next: ${nextStage.nameEn}`}
      </button>);
    if (winnable) moreItems.push(
      <button key="win" type="button" role="menuitem" data-testid="win-deal" disabled={busy}
        onClick={() => { setMore(false); transition({ toOutcome: "WON" }, ar ? "سُجّلت الصفقة رابحة." : "Deal marked won."); }}>
        {ar ? "تعليم رابحة" : "Mark won"}
      </button>);
    if (can.quote && open) moreItems.push(
      <Link key="quote" role="menuitem" href={`/dashboard/sales/quotes/new?opportunityId=${deal.id}`} data-testid="new-quote">
        {ar ? "عرض سعر جديد" : "New quotation"}
      </Link>);
    if (open && can.close) moreItems.push(
      <button key="lose" type="button" role="menuitem" className="danger" data-testid="lose-deal" disabled={busy}
        onClick={() => { setMore(false); setDialog("close"); }}>
        {ar ? "تعليم خاسرة" : "Mark as lost"}
      </button>);
    const reopen = !open && can.reopen ? (
      <button type="button" className="btn p" data-testid="reopen-deal" disabled={busy}
        onClick={() => transition({ toOutcome: "OPEN" }, ar ? "أُعيد فتح الصفقة." : "Deal reopened.")}>
        {ar ? "إعادة فتح الصفقة" : "Reopen the deal"}
      </button>
    ) : null;
    const logOutcome = open && can.write ? (
      <button type="button" className="btn p" data-testid="log-activity" onClick={() => setDialog("activity")}>
        {ar ? "تسجيل نتيجة المكالمة" : "Log call outcome"}
      </button>
    ) : null;
    const barPrimary = reopen ?? logOutcome;
    return (
      <div className="pg">
        {notice}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`st${deal.outcome === "WON" ? " ok" : deal.outcome === "LOST" ? " er" : ""}`} data-testid="deal-outcome">
            {deal.outcome === "OPEN" ? (ar ? "مفتوحة" : "Open") : deal.outcome === "WON" ? (ar ? "رابحة" : "Won") : (ar ? "خاسرة" : "Lost")}
          </span>
          <span className="st in" style={{ fontSize: 12.5 }}>{ar ? deal.stage.nameAr : deal.stage.nameEn}</span>
          {deal.owner && <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{deal.owner.name}</span>}
        </div>

        <dl className="phrows" data-testid="deal-metrics">
          <div><dt className="lbl">{ar ? "القيمة المتوقعة" : "Expected value"}</dt>
            <dd>{ar
              ? <><span className="n" style={{ fontSize: 20 }}>{whole(deal.amount)}</span><span className="unit">{cur}</span></>
              : <><span className="unit pre">{cur}</span><span className="n" style={{ fontSize: 20 }}>{whole(deal.amount)}</span></>}</dd></div>
          <div><dt className="lbl">{ar ? "الاحتمال" : "Probability"}</dt>
            <dd><span className="n" style={{ fontSize: 20 }}>{deal.probability}%</span></dd></div>
          <div><dt className="lbl">{ar ? "الإغلاق المتوقع" : "Expected close"}</dt>
            <dd>{deal.expectedCloseAt ? shortDate(deal.expectedCloseAt, lang) : (ar ? "غير محدد" : "Not set")}</dd></div>
        </dl>

        {open ? (
          <div data-testid="next-step" className={`callout ph${lateBy ? " er" : ""}`}>
            {nextStep ? (
              <>
                {lateBy > 0 && <span className="flag">{ar ? `متأخرة ${dayCount(lateBy, lang)}` : `${dayCount(lateBy, lang)} overdue`}</span>}
                <span>
                  <b style={{ fontWeight: 600 }}>{ar ? "الخطوة التالية:" : "Next step:"}</b> <bdi>{nextStep.subject}</bdi>
                  {nextStep.dueAt && <> · {dueShort(nextStep.dueAt)}</>}
                </span>
                {/* Not in the frame, whose bar records the call's outcome — the system can only mark
                    a follow-up done (record: conflict P-2). */}
                {can.write && (
                  <button type="button" className="btn sm" data-testid={`complete-${nextStep.id}`} disabled={busy} onClick={() => complete(nextStep.id)}>
                    {ar ? "إكمال" : "Complete"}
                  </button>
                )}
              </>
            ) : (
              <span>
                <b style={{ fontWeight: 600 }}>{ar ? "الخطوة التالية:" : "Next step:"}</b>{" "}
                {deal.nextFollowUpAt
                  ? <>{ar ? "متابعة · " : "follow-up · "}{dueShort(deal.nextFollowUpAt)}</>
                  : <span style={{ color: "var(--text-secondary)" }}>{ar ? "لا نشاط مفتوح." : "Nothing open."}</span>}
              </span>
            )}
          </div>
        ) : deal.lostReason ? (
          <div className="callout ph">
            <span><b style={{ fontWeight: 600 }}>{ar ? "سبب الخسارة:" : "Lost because:"}</b> <bdi>{deal.lostReason}</bdi></span>
          </div>
        ) : null}

        <div className="lbl" style={{ margin: "18px 0 4px" }}>{ar ? "عروض الأسعار" : "Quotations"}</div>
        {current.length === 0 ? (
          <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>{ar ? "لا توجد عروض أسعار بعد." : "No quotations yet."}</p>
        ) : (
          <div data-testid="deal-quotes">
            {current.map((q) => (
              <div key={q.id} className="mrow" data-testid={`quote-row-${q.quoteNumber}`}>
                <div>
                  <Link href={`/dashboard/sales/quotes/${q.id}`} className="id" style={{ color: "inherit", textDecoration: "none" }}>
                    <bdi dir="ltr">{q.quoteNumber}</bdi>
                  </Link>{" "}
                  <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{ar ? "المراجعة" : "revision"} {q.revision}</span>
                </div>
                <span className="n">{money2(q.grandTotal)}</span>
                <div className="r2">
                  <span className={`st ${QUOTE_ST[q.status] ?? ""}`} style={{ fontSize: 12.5 }}>{pick(QUOTE_STATUS_SPECS, q.status, lang)}</span>
                  {q.validUntil && <span style={{ marginInlineStart: "auto" }}>{ar ? "صالح حتى " : "Valid until "}{shortDate(q.validUntil, lang)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="lbl" style={{ margin: "18px 0 8px" }}>{ar ? "آخر نشاط" : "Last activity"}</div>
        {entries.length === 0 ? (
          <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>{ar ? "لم يُسجَّل أي نشاط." : "Nothing logged yet."}</p>
        ) : (
          <ol className="tl" style={{ fontSize: 13 }} data-testid="deal-activities">
            {latest.map((e, i) => {
              const a = e.activity;
              const openA = a && !a.completedAt;
              return (
                <li key={e.key} data-kind={e.kind} data-testid={a ? `activity-${a.id}` : undefined}>
                  <span className={`m${i === 0 && !openA ? " b" : ""}`} />
                  {e.title}
                  <div className="when">{e.when}</div>
                  {openA && can.write && a.id !== nextStep?.id && (
                    <div style={{ marginTop: 6 }}>
                      <button type="button" className="btn sm" data-testid={`complete-${a.id}`} disabled={busy} onClick={() => complete(a.id)}>
                        {ar ? "إكمال" : "Complete"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {/* The frame shows the latest two; the rest of the history stays one tap away. */}
        {entries.length > 2 && (
          <button type="button" className="btn sm" data-testid="toggle-all-activities" aria-expanded={allEntries}
            onClick={() => setAllEntries((v) => !v)}>
            {allEntries ? (ar ? "عرض أقل" : "Show fewer") : (ar ? `عرض الكل (${entries.length})` : `Show all (${entries.length})`)}
          </button>
        )}

        {/* Not in the 390 frame; each carries a function of this page (record: P-3). */}
        <div style={{ marginTop: 32 }}>
          {collectionsHere && collectionsPanel}
          {samplesBlock}
          {!collectionsHere && collectionsPanel}
          {customerBlock}
          <div style={{ height: 1, background: "var(--border-subtle)", marginBottom: 24 }} />
          {detailsBlock}
        </div>

        <div className="sticky-act" data-deal-more>
          {barPrimary && <div className="grow">{barPrimary}</div>}
          {moreItems.length > 0 && (
            <div style={{ position: "relative", marginInlineStart: barPrimary ? undefined : "auto" }}>
              <button type="button" className="btn" style={{ width: 44, padding: 0, justifyContent: "center" }}
                aria-haspopup="menu" aria-expanded={more} aria-label={ar ? "المزيد" : "More"}
                data-testid="deal-more" onClick={() => setMore((v) => !v)}>
                <Ico name="more" small />
              </button>
              {more && <div className="menu" role="menu">{moreItems}</div>}
            </div>
          )}
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="pg">
      {notice}

      <div className="ph" style={{ alignItems: "flex-start" }}>
        <div>
          <h1>{deal.title}</h1>
          <div className="meta">
            {/* Outcome and stage are two facts: the outcome here, the stage on the tracker. */}
            <span className={`st${deal.outcome === "WON" ? " ok" : deal.outcome === "LOST" ? " er" : ""}`} data-testid="deal-outcome">
              {deal.outcome === "OPEN" ? (ar ? "مفتوحة" : "Open") : deal.outcome === "WON" ? (ar ? "رابحة" : "Won") : (ar ? "خاسرة" : "Lost")}
            </span>
            {deal.owner && <><i /><span>{ar ? "المالك " : "Owner "}{deal.owner.name}</span></>}
            <i /><span>{ar ? "أُنشئت " : "Created "}{shortDate(deal.createdAt, lang)}</span>
            {!open && deal.closedAt && <><i /><span>{ar ? "أُغلقت " : "Closed "}{shortDate(deal.closedAt, lang)}</span></>}
          </div>
        </div>
        <div className="act">
          {open && can.close && (
            <button type="button" className="btn g" data-testid="lose-deal" disabled={busy} onClick={() => setDialog("close")}>
              {ar ? "تعليم خاسرة" : "Mark as lost"}
            </button>
          )}
          {can.write && (
            <button type="button" className="btn" data-testid="log-activity" onClick={() => setDialog("activity")}>
              <Ico name="phone" small />{ar ? "تسجيل نشاط" : "Log activity"}
            </button>
          )}
          {!open && can.reopen && (
            <button type="button" className="btn p" data-testid="reopen-deal" disabled={busy}
              onClick={() => transition({ toOutcome: "OPEN" }, ar ? "أُعيد فتح الصفقة." : "Deal reopened.")}>
              {ar ? "إعادة فتح الصفقة" : "Reopen the deal"}
            </button>
          )}
          {primary}
        </div>
      </div>

      {/* The four figures a deal is read by (reference `crm-deal` metrics row). */}
      <dl className="metrics m4" data-testid="deal-metrics" style={{ gridTemplateColumns: "repeat(4,minmax(0,1fr))", margin: "8px 0 32px" }}>
        <div>
          <dt className="lbl">{ar ? "القيمة المتوقعة" : "Expected value"}</dt>
          <dd className="mid n">{whole(deal.amount)}</dd>
          <dd className="d">{cur}</dd>
        </div>
        <div>
          <dt className="lbl">{ar ? "الاحتمال" : "Probability"}</dt>
          <dd className="mid n">{deal.probability}%</dd>
          <dd className="d">{ar
            ? <>مرجّحة <span className="n">{whole(Number(deal.amount) * deal.probability / 100)}</span> {cur}</>
            : <>Weighted {cur} <span className="n">{whole(Number(deal.amount) * deal.probability / 100)}</span></>}</dd>
        </div>
        <div>
          <dt className="lbl">{ar ? "الإغلاق المتوقع" : "Expected close"}</dt>
          <dd className="mid">{deal.expectedCloseAt ? shortDate(deal.expectedCloseAt, lang) : (ar ? "غير محدد" : "Not set")}</dd>
          <dd className="d">{deal.expectedCloseAt ? relativeDays(deal.expectedCloseAt, lang) : " "}</dd>
        </div>
        <div>
          <dt className="lbl">{ar ? "في المرحلة" : "In stage"}</dt>
          <dd className="mid n">{inStageDays}<span className="unit">{dayUnit(inStageDays, lang)}</span></dd>
          <dd className="d">{ar ? "منذ " : "since "}{shortDate(inStageSince, lang)}</dd>
        </div>
      </dl>

      {/* Stage tracker (`.track`). Each step is also the control that moves the deal there. */}
      <div className="track-wrap" style={{ maxWidth: 628, marginBottom: 22 }}>
      <ol className="track" aria-label={ar ? "المرحلة" : "Stage"}>
        {shown.map((s, i) => {
          const done = i < atIdx, current = i === atIdx;
          const since = reached.get(s.id);
          return (
            <li key={s.id} className={done ? "done" : current ? "cur" : undefined}>
              <button type="button" data-testid={`stage-${s.code}`} aria-pressed={current}
                aria-current={current ? "step" : undefined}
                disabled={busy || current || !open || !can.write}
                onClick={() => transition({ toStageId: s.id }, ar ? `نُقلت إلى ${s.nameAr}.` : `Moved to ${s.nameEn}.`)}>
                <b className={done || current ? undefined : "later"}>{ar ? s.nameAr : s.nameEn}</b>
                {current ? <small>{inStageDays === 0 ? (ar ? "منذ اليوم" : "since today") : relativeDays(inStageSince, lang)}</small>
                  : done && since ? <small>{shortDate(since, lang)}</small> : null}
              </button>
            </li>
          );
        })}
      </ol>
      </div>

      {/* The next step (reference: red tint when it is overdue). Closed deals show why instead. */}
      {open ? (
        <div data-testid="next-step" className={`callout${lateBy ? " er" : ""}`} style={{ marginBottom: 32 }}>
          {nextStep ? (
            <>
              {lateBy > 0 && <span className="flag">{ar ? `متأخرة ${dayCount(lateBy, lang)}` : `${dayCount(lateBy, lang)} overdue`}</span>}
              <span>
                <b style={{ fontWeight: 600 }}>{ar ? "الخطوة التالية:" : "Next step:"}</b> <bdi>{nextStep.subject}</bdi>
                {nextStep.dueAt && <> · {lateBy ? (ar ? "كانت مستحقة " : "was due ") : (ar ? "مستحقة " : "due ")}{dueText(nextStep.dueAt, lang)}</>}
              </span>
              {can.write && (
                <button type="button" className="btn sm" data-testid={`complete-${nextStep.id}`} disabled={busy} onClick={() => complete(nextStep.id)}>
                  {ar ? "إكمال" : "Complete"}
                </button>
              )}
            </>
          ) : (
            <span>
              <b style={{ fontWeight: 600 }}>{ar ? "الخطوة التالية:" : "Next step:"}</b>{" "}
              {deal.nextFollowUpAt
                ? <>{ar ? "متابعة · " : "follow-up · "}{dueText(deal.nextFollowUpAt, lang)}</>
                : <span style={{ color: "var(--text-secondary)" }}>{ar ? "لا نشاط مفتوح. سجّل نشاطًا يحدّد ما يحدث بعد ذلك." : "Nothing open. Log an activity that says what happens next."}</span>}
            </span>
          )}
        </div>
      ) : deal.lostReason ? (
        <div className="callout" style={{ marginBottom: 32 }}>
          <span><b style={{ fontWeight: 600 }}>{ar ? "سبب الخسارة:" : "Lost because:"}</b> <bdi>{deal.lostReason}</bdi></span>
        </div>
      ) : null}

      <div className="cols" style={{ gridTemplateColumns: "minmax(0,1fr) 300px", gap: 56 }}>
        <div style={{ minWidth: 0 }}>
          {/* ── Quotations ── */}
          <div className="bh">
            <h2 className="bt">{ar ? "عروض الأسعار" : "Quotations"}</h2>
            <span className="sub">{vatNote}</span>
            {can.quote && open && (
              <Link className="lk" href={`/dashboard/sales/quotes/new?opportunityId=${deal.id}`} data-testid="new-quote">
                <Ico name="plus" small />{ar ? "عرض سعر جديد" : "New quotation"}
              </Link>
            )}
          </div>
          {deal.quotes.length === 0 ? (
            <p className="lbl" style={{ fontWeight: 400, margin: "0 0 32px" }}>{ar ? "لا توجد عروض أسعار بعد." : "No quotations yet."}</p>
          ) : (
            <div style={{ overflowX: "auto", marginBottom: 32 }}>
              <table className="t" data-testid="deal-quotes">
                <thead><tr>
                  <th>{ar ? "العرض" : "Quotation"}</th>
                  <th>{ar ? "المراجعة" : "Revision"}</th>
                  <th>{ar ? "الحالة" : "Status"}</th>
                  <th className="num">{ar ? "قبل الضريبة" : "Before VAT"}</th>
                  <th className="num">{ar ? `الإجمالي · ${currencyLabel(deal.currency, lang)}` : `Total · ${deal.currency}`}</th>
                  <th>{ar ? "صالح حتى" : "Valid until"}</th>
                </tr></thead>
                <tbody>
                  {deal.quotes.map((q) => (
                    <tr key={q.id} data-testid={`quote-row-${q.quoteNumber}`}>
                      <td className="id" style={{ color: "var(--text-secondary)" }}>
                        <Link href={`/dashboard/sales/quotes/${q.id}`}>{q.quoteNumber}</Link>
                      </td>
                      <td className="num" style={{ textAlign: "start" }}>{q.revision}</td>
                      <td><span className={`st ${QUOTE_ST[q.status] ?? ""}`}>{pick(QUOTE_STATUS_SPECS, q.status, lang)}</span></td>
                      <td className="num">{money2(Number(q.grandTotal) - Number(q.taxTotal))}</td>
                      <td className="num">{money2(q.grandTotal)}</td>
                      <td className="sm">{q.validUntil ? shortDate(q.validUntil, lang) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* The money against the deal — not in the frame (record: conflict C-3). Under the
              quotations once there is an accepted one to collect against. */}
          {collectionsHere && collectionsPanel}

          {samplesBlock}

          {activityBlock}
          {!collectionsHere && collectionsPanel && <div style={{ marginTop: 32 }}>{collectionsPanel}</div>}
        </div>

        {/* ── Side column: the customer, then the deal's own details ── */}
        <div style={{ minWidth: 0 }}>
          {customerBlock}
          <div style={{ height: 1, background: "var(--border-subtle)", marginBottom: 24 }} />
          {detailsBlock}
        </div>
      </div>

      {dialogs}
    </div>
  );
}

/** Quote status → the reference status dot (`.st` + tone). */
const QUOTE_ST: Record<string, string> = { ISSUED: "in", ACCEPTED: "ok", REJECTED: "er", EXPIRED: "wa", SUPERSEDED: "x" };
const SAMPLE_ST: Record<string, string> = { SENT: "in", FEEDBACK_RECEIVED: "ok", CANCELLED: "x" };

function LostDialog({
  ar, busy, onClose, onSubmit,
}: {
  ar: boolean; busy: boolean; onClose: () => void; onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      title={ar ? "تسجيل خسارة الصفقة" : "Mark the deal lost"}
      onClose={onClose}
      testId="lost-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button variant="danger" disabled={busy || reason.trim().length < 2} onClick={() => onSubmit(reason)} testId="confirm-lost">
            {ar ? "تأكيد الخسارة" : "Confirm lost"}
          </Button>
        </>
      }
    >
      <Field
        id="lost-reason"
        label={ar ? "السبب" : "Reason"}
        required
        hint={
          ar
            ? "مطلوب. مسار مليء بصفقات خاسرة بلا أسباب لا يُعلّم أحداً شيئاً."
            : "Required. A pipeline of lost deals with no reasons teaches nobody anything."
        }
      >
        <TextArea id="lost-reason" value={reason} onChange={setReason} rows={3} />
      </Field>
    </Modal>
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

function SampleDialog({
  ar, opportunityId, onClose, onDone,
}: {
  ar: boolean; opportunityId: string; onClose: () => void; onDone: () => void;
}) {
  const [skus, setSkus] = useState<{ id: string; skuCode: string; name: string | null }[]>([]);
  const [productSkuId, setProductSkuId] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("0.25");
  const [unit, setUnit] = useState("KG");
  const [status, setStatus] = useState("PREPARING");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    // The catalogue endpoint answers with a bare array of SKUs, already filtered to the
    // active ones.
    api<{ id: string; skuCode: string; name: string | null }[]>("/api/products").then((r) => {
      if (r.ok && Array.isArray(r.data)) setSkus(r.data);
    });
  }, []);

  return (
    <Modal
      title={ar ? "تسجيل عيّنة" : "Record a sample"}
      onClose={onClose}
      testId="sample-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || (!productSkuId && description.trim().length < 2) || Number(quantity) <= 0}
            testId="save-sample"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api("/api/sales/samples", {
                method: "POST",
                body: { opportunityId, productSkuId: productSkuId || null, description, quantity, unit, status },
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
      <Field id="smp-sku" label={ar ? "المنتج" : "Product"}>
        <Select id="smp-sku" value={productSkuId} onChange={setProductSkuId}>
          <option value="">{ar ? "— وصف حر —" : "— free text —"}</option>
          {skus.map((s) => (
            <option key={s.id} value={s.id}>{s.name ?? s.skuCode}</option>
          ))}
        </Select>
      </Field>
      {!productSkuId && (
        <Field id="smp-desc" label={ar ? "الوصف" : "Description"} required>
          <TextInput id="smp-desc" value={description} onChange={setDescription} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field id="smp-qty" label={ar ? "الكمية" : "Quantity"} required>
          <TextInput id="smp-qty" value={quantity} onChange={setQuantity} inputMode="decimal" />
        </Field>
        <Field id="smp-unit" label={ar ? "الوحدة" : "Unit"}>
          <Select id="smp-unit" value={unit} onChange={setUnit}>
            <option value="KG">{ar ? "كجم" : "KG"}</option>
            <option value="GRAM">{ar ? "غرام" : "GRAM"}</option>
            <option value="UNIT">{ar ? "عبوة" : "UNIT"}</option>
          </Select>
        </Field>
      </div>
      <Field id="smp-status" label={ar ? "الحالة" : "Status"}>
        <Select id="smp-status" value={status} onChange={setStatus}>
          <option value="PREPARING">{pick(SAMPLE_LABELS, "PREPARING", ar ? "ar" : "en")}</option>
          <option value="SENT">{pick(SAMPLE_LABELS, "SENT", ar ? "ar" : "en")}</option>
        </Select>
      </Field>
      {/* Moved here from under the samples list: it matters at the moment a sample is recorded. */}
      <p data-ui="field-hint">
        {ar
          ? "تسجيل العيّنة لا يُحرّك المخزون. اصرف البن من مسار المخزون والشحن المعتاد."
          : "Recording a sample does not move stock. Issue the coffee through the normal inventory and dispatch path."}
      </p>
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
  const [nextFollowUpAt, setNextFollowUpAt] = useState(deal.nextFollowUpAt?.slice(0, 10) ?? "");
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
                  nextFollowUpAt: nextFollowUpAt || null,
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
        className={`text-sm font-bold ${balanced ? "text-emerald-700" : "text-oo-status-rejected"}`}
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
