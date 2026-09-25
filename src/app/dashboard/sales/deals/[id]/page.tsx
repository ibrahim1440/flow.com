"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import {
  ArrowLeft, Phone, FileText, Package, CheckCircle2, Check, Circle, CircleDashed, Clock, Plus,
  Users2, Trophy, XCircle,
} from "lucide-react";
import {
  useLang, pick, ProvisionalBanner, PageHeader, Alert, Card, SectionTitle, EmptyState,
  Spinner, Button, Field, TextInput, Select, TextArea, Money, Pill, Modal, TableWrap, api,
  DealOutcomeBadge, QuoteStatusBadge, ROW_ACTION, num, formatDay, formatWhen,
} from "../../_components/ui";
import { CollectionsPanel, type CollectionRow, type Summary } from "./CollectionsPanel";

/**
 * Deal detail — the whole opportunity in one place.
 *
 * SC-04 in the Sales Screens design: the deal’s state and its one next action in the
 * header, the ordered stages as a stepper rather than a row of equal pills, and the
 * quotations and the activity log side by side beneath.
 *
 * The screen is organised around the question a salesperson opens it to answer: what is
 * the state of this deal and what happens next. So the lifecycle controls and the next
 * follow-up sit at the top, and the history — which is read occasionally and scanned
 * rarely — sits at the bottom.
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
  conversion: { leadId: string; convertedAt: string; lead: { companyName: string } } | null;
  quotes: {
    id: string; quoteNumber: string; revision: number; status: string; currency: string;
    validUntil: string | null; grandTotal: string; issuedAt: string | null; acceptedAt: string | null;
    _count: { lines: number; orderLinks: number };
  }[];
  samples: {
    id: string; description: string | null; quantity: string; unit: string; status: string;
    sentAt: string | null; feedbackScore: number | null; feedbackNotes: string | null;
    productSku: { id: string; skuCode: string; name: string | null } | null;
  }[];
  activities: {
    id: string; type: string; subject: string; body: string | null;
    dueAt: string | null; completedAt: string | null; createdAt: string;
    owner: { id: string; name: string } | null;
  }[];
  stageEvents: {
    id: string; reason: string | null; createdAt: string; toOutcome: string | null;
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

const ACTIVITY_LABELS: Record<string, { en: string; ar: string }> = {
  CALL: { en: "Call", ar: "اتصال" },
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
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [collectionSummary, setCollectionSummary] = useState<Summary | null>(null);
  const [can, setCan] = useState<Can | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  const [dialog, setDialog] = useState<"activity" | "sample" | "close" | "edit" | "splits" | null>(null);

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
      const res = await api<{
        deal: Deal; stages: Stage[]; can: Can;
        collections: CollectionRow[]; collectionSummary: Summary;
      }>(`/api/sales/opportunities/${id}`);
      if (cancelled) return;
      if (res.ok) {
        setDeal(res.data.deal);
        setStages(res.data.stages);
        setCan(res.data.can);
        setCollections(res.data.collections ?? []);
        setCollectionSummary(res.data.collectionSummary ?? null);
        setError("");
      } else {
        setError(res.data.error ?? (ar ? "تعذّر تحميل الصفقة." : "Could not load the deal."));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, ar, reloadToken]);


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

  if (loading) return <Spinner />;
  if (!deal || !can) {
    return (
      <div className="space-y-4">
        <Alert kind="error">{error || (ar ? "الصفقة غير موجودة." : "Deal not found.")}</Alert>
        <Link href="/dashboard/sales/pipeline" className="text-oo-action-primary font-bold text-sm">
          {ar ? "العودة إلى مسار الصفقات" : "Back to the pipeline"}
        </Link>
      </div>
    );
  }

  const open = deal.outcome === "OPEN";
  const acceptedQuote = deal.quotes.find((q) => q.status === "ACCEPTED");
  const openActivities = deal.activities.filter((a) => !a.completedAt);
  const overdue = openActivities.filter((a) => a.dueAt && new Date(a.dueAt) < new Date());

  return (
    <div className="space-y-6">
      <ProvisionalBanner />

      <Link
        href="/dashboard/sales/pipeline"
        className="inline-flex items-center gap-1.5 text-sm font-bold text-oo-text-secondary hover:text-oo-action-primary"
      >
        <ArrowLeft size={15} className="rtl:rotate-180" aria-hidden />
        {ar ? "مسار الصفقات" : "Pipeline"}
      </Link>

      <PageHeader
        title={deal.title}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap mt-1">
            {/* Outcome and stage are two different facts and now read as two.
                One pill used to carry both — the stage name while open, Won/Lost once
                closed — which made a closed deal look as though it had left the pipeline
                rather than finished somewhere in it. The stage is still shown after closing,
                because "lost at negotiation" and "lost at qualification" are not the same
                loss. */}
            <DealOutcomeBadge outcome={deal.outcome} testId="deal-outcome" />
            {[
              deal.customer ? (
                <Link key="c" href="/dashboard/customers" className="hover:text-oo-action-primary">
                  {ar ? (deal.customer.nameAr ?? deal.customer.name) : deal.customer.name}
                </Link>
              ) : null,
              <Money key="m" value={deal.amount} currency={deal.currency} />,
              deal.owner ? (
                <span key="o">
                  {ar ? "المالك " : "owner "}
                  {deal.owner.name}
                </span>
              ) : null,
              <span key="cr">
                {ar ? "أُنشئت " : "created "}
                {formatDay(deal.createdAt, lang)}
              </span>,
              <span key="p">
                {ar ? "احتمال " : "probability "}
                {num(deal.probability, lang)}%
              </span>,
            ]
              .filter(Boolean)
              .map((part, i) => (
                <span key={i} className="flex items-center gap-2">
                  {i > 0 && <span aria-hidden className="text-oo-border-strong">·</span>}
                  {part}
                </span>
              ))}
          </span>
        }
        actions={
          <>
            {can.write && open && (
              <Button variant="secondary" onClick={() => setDialog("edit")} testId="edit-deal">
                {ar ? "تعديل" : "Edit"}
              </Button>
            )}
            {can.assign && (
              <Button variant="secondary" onClick={() => setDialog("splits")} testId="edit-splits">
                <Users2 size={15} aria-hidden /> {ar ? "توزيع العمولة" : "Split"}
              </Button>
            )}
            {can.close && open && (
              <>
                <Button
                  variant="secondary"
                  onClick={() =>
                    transition({ toOutcome: "WON" }, ar ? "تم تسجيل الصفقة مكسوبة." : "Deal marked won.")
                  }
                  disabled={busy}
                  testId="win-deal"
                  title={
                    acceptedQuote
                      ? undefined
                      : ar
                        ? "تحتاج عرض سعر مقبول أولاً"
                        : "Needs an accepted quotation first"
                  }
                >
                  <Trophy size={15} aria-hidden /> {ar ? "تعليم رابح" : "Mark won"}
                </Button>
                {/* Outlined, not filled: losing a deal is ordinary work and a solid red
                    button next to a solid indigo one reads as the pair of choices being
                    equally weighted, which they are not. */}
                <button
                  onClick={() => setDialog("close")}
                  disabled={busy}
                  data-testid="lose-deal"
                  className="inline-flex items-center gap-2 rounded-[10px] border border-oo-status-rejected bg-oo-bg-default px-[18px] py-[10px] text-[14px] font-medium leading-[22px] text-oo-status-rejected transition-colors hover:bg-oo-status-rejected-bg disabled:opacity-50"
                >
                  <XCircle size={15} aria-hidden /> {ar ? "تعليم خاسر" : "Mark lost"}
                </button>
              </>
            )}
            {can.reopen && !open && (
              <Button
                variant="secondary"
                disabled={busy}
                testId="reopen-deal"
                onClick={() =>
                  transition({ toOutcome: "OPEN" }, ar ? "أُعيد فتح الصفقة." : "Deal reopened.")
                }
              >
                {ar ? "إعادة فتح الصفقة" : "Reopen the deal"}
              </Button>
            )}
            {/* The design's one primary action on this screen. Raising the quotation is what
                moves the deal forward; marking it won is what happens after the customer
                accepts one, which is why the server refuses the latter without the former. */}
            {can.quote && open && (
              <Link
                href={`/dashboard/sales/quotes/new?opportunityId=${deal.id}`}
                data-testid="new-quote-header"
                className="inline-flex items-center gap-2 rounded-[10px] bg-oo-action-primary px-[18px] py-[10px] text-[14px] font-medium leading-[22px] text-white transition-colors hover:bg-oo-action-primary-hover"
              >
                <FileText size={15} aria-hidden /> {ar ? "إنشاء عرض سعر" : "Raise a quotation"}
              </Link>
            )}
          </>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      {!open && deal.lostReason && (
        <Alert kind="info">
          {ar ? "سبب الخسارة: " : "Lost because: "}
          {deal.lostReason}
        </Alert>
      )}

      {open && !acceptedQuote && can.close && (
        <Alert kind="info">
          {ar
            ? "لا يمكن اعتبار الصفقة مكسوبة قبل قبول عرض سعر. أنشئ عرضاً وسجّل قبول العميل له."
            : "A deal is won when a quotation is accepted. Raise one and record the customer's acceptance."}
        </Alert>
      )}

      {/* ── Stage ────────────────────────────────────────────────────────────────────
          A stepper rather than a row of equal pills, because the stages are ordered and the
          row was not saying so: a passed stage, the current one and one still ahead all
          looked like three buttons. Each step is still the control that moves the deal
          there — the design's shape, the screen's existing behaviour. */}
      {open && can.write && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[12px] leading-[18px] text-oo-text-muted">
              {ar
                ? "المراحل تُهيَّأ من إعدادات المبيعات — ليست قائمة ثابتة"
                : "Stages come from Sales settings — this is not a fixed list"}
            </span>
            <SectionTitle>
              {ar ? "المرحلة الحالية: " : "Current stage: "}
              {ar ? deal.stage.nameAr : deal.stage.nameEn}
            </SectionTitle>
          </div>
          <ol className="flex flex-wrap items-center gap-1" role="group" aria-label={ar ? "المرحلة" : "Stage"}>
            {(() => {
              const shown = stages.filter((s) => s.isActive || s.id === deal.stage.id);
              const atIdx = shown.findIndex((s) => s.id === deal.stage.id);
              return shown.map((s, i) => {
                const passed = i < atIdx;
                const current = i === atIdx;
                return (
                  <li key={s.id} className="flex items-center gap-1">
                    {i > 0 && (
                      <span aria-hidden className="px-1 text-oo-text-muted">
                        {ar ? "←" : "→"}
                      </span>
                    )}
                    <button
                      data-testid={`stage-${s.code}`}
                      disabled={busy || current}
                      aria-current={current ? "step" : undefined}
                      onClick={() =>
                        transition(
                          { toStageId: s.id },
                          ar ? `نُقلت إلى ${s.nameAr}.` : `Moved to ${s.nameEn}.`,
                        )
                      }
                      className={`flex min-w-[130px] flex-col items-center gap-1 rounded-[10px] border px-4 py-2.5 transition-colors ${
                        current
                          ? "border-oo-action-primary bg-oo-bg-default"
                          : "border-transparent hover:border-oo-border-strong"
                      }`}
                    >
                      {/* Passed, current, still ahead — a tick, a filled ring, a dotted one. */}
                      {passed ? (
                        <Check size={16} aria-hidden className="text-oo-action-primary" />
                      ) : current ? (
                        <Circle size={16} aria-hidden className="text-oo-action-primary" />
                      ) : (
                        <CircleDashed size={16} aria-hidden className="text-oo-text-muted" />
                      )}
                      <span
                        className={`text-[14px] leading-[22px] ${
                          current
                            ? "font-medium text-oo-text-primary"
                            : passed
                              ? "text-oo-text-secondary"
                              : "text-oo-text-muted"
                        }`}
                      >
                        {ar ? s.nameAr : s.nameEn}
                      </span>
                    </button>
                  </li>
                );
              });
            })()}
          </ol>
        </Card>
      )}

      <div className="grid lg:grid-cols-3 gap-5 items-start">
        <div className="lg:col-span-2 space-y-5">
          {/* ── Quotations ─────────────────────────────────────────── */}
          <Card>
            <SectionTitle
              right={
                can.quote && open ? (
                  <Link
                    href={`/dashboard/sales/quotes/new?opportunityId=${deal.id}`}
                    className="text-xs font-bold text-oo-action-primary hover:underline"
                    data-testid="new-quote"
                  >
                    + {ar ? "عرض سعر جديد" : "New quotation"}
                  </Link>
                ) : null
              }
            >
              <span className="inline-flex items-center gap-1.5">
                <FileText size={14} aria-hidden /> {ar ? "عروض الأسعار" : "Quotations"}
              </span>
            </SectionTitle>

            {deal.quotes.length === 0 ? (
              <EmptyState>{ar ? "لا توجد عروض أسعار بعد." : "No quotations yet."}</EmptyState>
            ) : (
              <TableWrap>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-oo-bg-subtle text-[12px] font-medium leading-[18px] text-oo-text-muted">
                      <th className="pe-4 text-start py-2">{ar ? "الرقم" : "Number"}</th>
                      <th className="pe-4 text-start py-2">{ar ? "الحالة" : "Status"}</th>
                      <th className="pe-4 text-end py-2">{ar ? "الإجمالي" : "Total"}</th>
                      <th className="pe-4 text-start py-2">{ar ? "صالح حتى" : "Valid until"}</th>
                      <th className="pe-4 text-start py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {deal.quotes.map((q) => (
                      <tr key={q.id} className="border-t border-oo-border-default" data-testid={`quote-row-${q.quoteNumber}`}>
                        <td className="pe-4 py-2.5 font-bold">
                          <Link href={`/dashboard/sales/quotes/${q.id}`} className="hover:text-oo-action-primary">
                            {q.quoteNumber}
                          </Link>
                          {q.revision > 1 && (
                            <span className="text-[10px] text-oo-text-muted ps-1">r{q.revision}</span>
                          )}
                        </td>
                        <td className="pe-4 py-2.5">
                          <QuoteStatusBadge status={q.status} />
                        </td>
                        <td className="pe-4 py-2.5 text-end">
                          <Money value={q.grandTotal} currency={q.currency} />
                        </td>
                        <td className="pe-4 py-2.5 text-xs text-oo-text-secondary">
                          {q.validUntil ? formatDay(q.validUntil, lang) : "—"}
                        </td>
                        <td className="pe-4 py-2.5 text-xs">
                          {q._count.orderLinks > 0 && (
                            <Pill tone="accent">{ar ? "طلب مُنشأ" : "Ordered"}</Pill>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          {/* ── The money against this deal ──────────────────────────
              Directly under the quotations, because that is the order the work happens in:
              a quotation is accepted, and then it is paid for — possibly in pieces, possibly
              not at all. */}
          {collectionSummary && (
            <CollectionsPanel
              dealId={id}
              ar={ar}
              lang={lang}
              summary={collectionSummary}
              rows={collections}
              canSubmit={!!can.submitCollection}
              onChanged={reload}
            />
          )}

          {/* ── Activities ─────────────────────────────────────────── */}
          <Card>
            <SectionTitle
              right={
                can.write ? (
                  <button
                    onClick={() => setDialog("activity")}
                    className="text-xs font-bold text-oo-action-primary hover:underline"
                    data-testid="log-activity"
                  >
                    + {ar ? "تسجيل نشاط" : "Log activity"}
                  </button>
                ) : null
              }
            >
              <span className="inline-flex items-center gap-1.5">
                <Phone size={14} aria-hidden /> {ar ? "الأنشطة والمتابعات" : "Activities & follow-ups"}
                {overdue.length > 0 && (
                  <Pill tone="bad">
                    {overdue.length} {ar ? "متأخرة" : "overdue"}
                  </Pill>
                )}
              </span>
            </SectionTitle>

            {deal.activities.length === 0 ? (
              <EmptyState>{ar ? "لم يُسجَّل أي نشاط." : "Nothing logged yet."}</EmptyState>
            ) : (
              <ul className="space-y-2">
                {deal.activities.slice(0, 20).map((a) => {
                  const late = !a.completedAt && a.dueAt && new Date(a.dueAt) < new Date();
                  return (
                    <li
                      key={a.id}
                      data-testid={`activity-${a.id}`}
                      className={`flex items-start gap-3 p-3 rounded-xl border ${
                        late ? "border-oo-status-rejected bg-red-50/40" : "border-oo-border-default"
                      }`}
                    >
                      <span className="mt-0.5">
                        {a.completedAt ? (
                          <CheckCircle2 size={15} className="text-oo-status-success" aria-hidden />
                        ) : (
                          <Clock size={15} className={late ? "text-oo-status-rejected" : "text-oo-text-muted"} aria-hidden />
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Pill>{pick(ACTIVITY_LABELS, a.type, lang)}</Pill>
                          <span className="font-bold text-sm text-oo-text-primary">{a.subject}</span>
                        </div>
                        {a.body && <p className="text-xs text-oo-text-secondary mt-1 break-words">{a.body}</p>}
                        <p className="text-[11px] text-oo-text-muted mt-1">
                          {a.owner?.name}
                          {a.dueAt && ` · ${ar ? "الاستحقاق" : "due"} ${formatWhen(a.dueAt, lang)}`}
                          {a.completedAt && ` · ${ar ? "اكتمل" : "done"} ${formatWhen(a.completedAt, lang)}`}
                        </p>
                      </div>
                      {!a.completedAt && (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          testId={`complete-${a.id}`}
                          onClick={async () => {
                            setBusy(true);
                            const res = await api(`/api/sales/activities/${a.id}`, {
                              method: "PATCH",
                              body: { completed: true },
                            });
                            setBusy(false);
                            if (res.ok) reload();
                            else setError(res.data.error ?? "");
                          }}
                        >
                          {ar ? "تم" : "Done"}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* ── Samples ────────────────────────────────────────────── */}
          <Card>
            <SectionTitle
              right={
                can.write && open ? (
                  <button
                    onClick={() => setDialog("sample")}
                    className="text-xs font-bold text-oo-action-primary hover:underline"
                    data-testid="add-sample"
                  >
                    + {ar ? "عيّنة" : "Sample"}
                  </button>
                ) : null
              }
            >
              <span className="inline-flex items-center gap-1.5">
                <Package size={14} aria-hidden /> {ar ? "العيّنات" : "Samples"}
              </span>
            </SectionTitle>

            {deal.samples.length === 0 ? (
              <EmptyState>{ar ? "لا توجد عيّنات." : "No samples."}</EmptyState>
            ) : (
              <ul className="space-y-2">
                {deal.samples.map((s) => (
                  <li
                    key={s.id}
                    data-testid={`sample-${s.id}`}
                    className="flex items-center gap-3 p-3 rounded-xl border border-oo-border-default flex-wrap"
                  >
                    <Pill tone={s.status === "FEEDBACK_RECEIVED" ? "good" : s.status === "CANCELLED" ? "bad" : "info"}>
                      {pick(SAMPLE_LABELS, s.status, lang)}
                    </Pill>
                    <span className="font-bold text-sm flex-1 min-w-0 break-words">
                      {s.productSku?.name ?? s.productSku?.skuCode ?? s.description}
                    </span>
                    <span className="text-xs text-oo-text-secondary tabular-nums">
                      {s.quantity} {s.unit}
                    </span>
                    {s.feedbackScore !== null && (
                      <Pill tone="accent">{s.feedbackScore}/5</Pill>
                    )}
                    {s.status === "PREPARING" && can.write && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        testId={`send-sample-${s.id}`}
                        onClick={async () => {
                          setBusy(true);
                          const res = await api(`/api/sales/samples/${s.id}`, {
                            method: "PATCH",
                            body: { status: "SENT" },
                          });
                          setBusy(false);
                          if (res.ok) reload();
                          else setError(res.data.error ?? "");
                        }}
                      >
                        {ar ? "أُرسلت" : "Sent"}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-oo-text-muted mt-3 font-medium">
              {ar
                ? "تسجيل العيّنة لا يُحرّك المخزون. أصرف البن من مسار المخزون والشحن المعتاد."
                : "Recording a sample does not move stock. Issue the coffee through the normal inventory and dispatch path."}
            </p>
          </Card>
        </div>

        {/* ── Side column ──────────────────────────────────────────── */}
        <div className="space-y-5">
          <Card>
            <SectionTitle>{ar ? "التفاصيل" : "Details"}</SectionTitle>
            <dl className="space-y-2.5 text-sm">
              <Row label={ar ? "الاحتمال" : "Probability"}>{ar ? `${num(deal.probability, "ar")}%` : `${deal.probability}%`}</Row>
              <Row label={ar ? "الإغلاق المتوقع" : "Expected close"}>
                {deal.expectedCloseAt ? formatDay(deal.expectedCloseAt, lang) : "—"}
              </Row>
              <Row label={ar ? "المتابعة القادمة" : "Next follow-up"}>
                {deal.nextFollowUpAt ? formatWhen(deal.nextFollowUpAt, lang) : "—"}
              </Row>
              <Row label={ar ? "أُنشئت" : "Created"}>{formatDay(deal.createdAt, lang)}</Row>
              {deal.conversion && (
                <Row label={ar ? "من عميل محتمل" : "From lead"}>
                  <Link href={`/dashboard/sales/leads`} className="text-oo-action-primary hover:underline">
                    {deal.conversion.lead.companyName}
                  </Link>
                </Row>
              )}
            </dl>
          </Card>

          {deal.owners.length > 0 && (
            <Card>
              <SectionTitle>{ar ? "توزيع العمولة" : "Commission split"}</SectionTitle>
              <ul className="space-y-2 text-sm" data-testid="split-list">
                {deal.owners.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{o.employee.name}</span>
                    <Pill tone="accent">{o.sharePercent}%</Pill>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-oo-text-muted mt-3 font-medium">
                {ar
                  ? "التوزيع يقسّم الأساس، لا العمولة المحسوبة — وما استُحق سابقاً لا يتغيّر."
                  : "Splits divide the base, not the finished commission. What was already earned stays earned."}
              </p>
            </Card>
          )}

          {deal.orderLinks.length > 0 && (
            <Card>
              <SectionTitle>{ar ? "الطلبات" : "Orders"}</SectionTitle>
              <ul className="space-y-2 text-sm">
                {deal.orderLinks.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2">
                    <Link href="/dashboard/orders" className="font-bold hover:text-oo-action-primary">
                      #{l.order.orderNumber}
                    </Link>
                    <span className="flex items-center gap-1.5">
                      {l.isFirstOrder && <Pill tone="good">{ar ? "الأول" : "First"}</Pill>}
                      <Pill>{l.order.status}</Pill>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <SectionTitle>{ar ? "السجل" : "History"}</SectionTitle>
            {deal.stageEvents.length === 0 ? (
              <EmptyState>{ar ? "لا يوجد سجل." : "Nothing recorded."}</EmptyState>
            ) : (
              <ol className="space-y-2.5 text-xs">
                {deal.stageEvents.slice(0, 15).map((e) => (
                  <li key={e.id} className="border-s-2 border-oo-border-default ps-3">
                    <p className="font-bold text-oo-text-primary">
                      {e.toStage ? (ar ? e.toStage.nameAr : e.toStage.nameEn) : e.toOutcome ?? "—"}
                    </p>
                    {e.reason && <p className="text-oo-text-secondary break-words">{e.reason}</p>}
                    <p className="text-oo-text-muted">{formatWhen(e.createdAt, lang)}</p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>

      {dialog === "close" && (
        <LostDialog
          ar={ar}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(reason) =>
            transition(
              { toOutcome: "LOST", lostReason: reason },
              ar ? "سُجّلت الصفقة خسارة." : "Deal marked lost.",
            )
          }
        />
      )}
      {dialog === "activity" && (
        <ActivityDialog
          ar={ar}
          opportunityId={deal.id}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setSuccess(ar ? "سُجّل النشاط." : "Activity logged.");
            reload();
          }}
        />
      )}
      {dialog === "sample" && (
        <SampleDialog
          ar={ar}
          opportunityId={deal.id}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setSuccess(ar ? "سُجّلت العيّنة." : "Sample recorded.");
            reload();
          }}
        />
      )}
      {dialog === "edit" && (
        <EditDialog
          ar={ar}
          deal={deal}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setSuccess(ar ? "حُفظت التعديلات." : "Saved.");
            reload();
          }}
        />
      )}
      {dialog === "splits" && (
        <SplitDialog
          ar={ar}
          deal={deal}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setSuccess(ar ? "حُفظ التوزيع." : "Split saved.");
            reload();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs font-bold text-oo-text-secondary">{label}</dt>
      <dd className="font-semibold text-oo-text-primary text-end">{children}</dd>
    </div>
  );
}

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
            <option value="KG">KG</option>
            <option value="GRAM">GRAM</option>
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
