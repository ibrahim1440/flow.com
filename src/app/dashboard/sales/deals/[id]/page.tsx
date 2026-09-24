"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import {
  ArrowLeft, Phone, FileText, Package, CheckCircle2, Clock, Plus, Users2, Trophy, XCircle,
} from "lucide-react";
import {
  useLang, pick, ProvisionalBanner, PageHeader, Alert, Card, SectionTitle, EmptyState,
  Spinner, Button, Field, TextInput, Select, TextArea, Money, Pill, Modal, TableWrap, api,
  DealOutcomeBadge, QuoteStatusBadge,
} from "../../_components/ui";
import { formatDate } from "@/lib/utils";

/**
 * Deal detail — the whole opportunity in one place.
 *
 * PROVISIONAL INTERFACE, as the banner says. Built from the existing ERP components and
 * the documented flow because the Figma design could not be produced in this session.
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
  const [can, setCan] = useState<Can | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  const [dialog, setDialog] = useState<"activity" | "sample" | "close" | "edit" | "splits" | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ deal: Deal; stages: Stage[]; can: Can }>(`/api/sales/opportunities/${id}`);
    if (res.ok) {
      setDeal(res.data.deal);
      setStages(res.data.stages);
      setCan(res.data.can);
      setError("");
    } else {
      setError(res.data.error ?? (ar ? "تعذّر تحميل الصفقة." : "Could not load the deal."));
    }
    setLoading(false);
  }, [id, ar]);

  useEffect(() => {
    load();
  }, [load]);

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
    await load();
    return true;
  }

  if (loading) return <Spinner />;
  if (!deal || !can) {
    return (
      <div className="space-y-4">
        <Alert kind="error">{error || (ar ? "الصفقة غير موجودة." : "Deal not found.")}</Alert>
        <Link href="/dashboard/sales/pipeline" className="text-orange font-bold text-sm">
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
        className="inline-flex items-center gap-1.5 text-sm font-bold text-brown hover:text-orange"
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
            <Pill tone="neutral" testId="deal-stage">
              {pick({ [deal.stage.code]: { en: deal.stage.nameEn, ar: deal.stage.nameAr } }, deal.stage.code, lang)}
            </Pill>
            {deal.customer && (
              <Link href={`/dashboard/customers`} className="font-bold text-charcoal hover:text-orange">
                {ar ? (deal.customer.nameAr ?? deal.customer.name) : deal.customer.name}
              </Link>
            )}
            <span className="text-brown/60">·</span>
            <Money value={deal.amount} currency={deal.currency} />
            {deal.owner && (
              <>
                <span className="text-brown/60">·</span>
                <span className="text-xs font-semibold">{deal.owner.name}</span>
              </>
            )}
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
                  <Trophy size={15} aria-hidden /> {ar ? "مكسوبة" : "Won"}
                </Button>
                <Button variant="danger" onClick={() => setDialog("close")} disabled={busy} testId="lose-deal">
                  <XCircle size={15} aria-hidden /> {ar ? "خسارة" : "Lost"}
                </Button>
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
                {ar ? "إعادة فتح" : "Reopen"}
              </Button>
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

      {/* ── Stage board ──────────────────────────────────────────────── */}
      {open && can.write && (
        <Card>
          <SectionTitle>{ar ? "المرحلة" : "Stage"}</SectionTitle>
          <div className="flex gap-2 flex-wrap" role="group" aria-label={ar ? "المرحلة" : "Stage"}>
            {stages
              .filter((s) => s.isActive || s.id === deal.stage.id)
              .map((s) => (
                <button
                  key={s.id}
                  data-testid={`stage-${s.code}`}
                  disabled={busy || s.id === deal.stage.id}
                  aria-pressed={s.id === deal.stage.id}
                  onClick={() =>
                    transition(
                      { toStageId: s.id },
                      ar ? `نُقلت إلى ${s.nameAr}.` : `Moved to ${s.nameEn}.`,
                    )
                  }
                  className={`px-3 py-2 rounded-xl text-xs font-bold border-2 transition-colors ${
                    s.id === deal.stage.id
                      ? "bg-orange text-white border-orange"
                      : "bg-white border-border text-brown hover:border-orange"
                  }`}
                >
                  {ar ? s.nameAr : s.nameEn}
                </button>
              ))}
          </div>
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
                    className="text-xs font-bold text-orange hover:underline"
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
                    <tr className="text-[11px] uppercase text-brown/60 font-bold">
                      <th className="text-start py-2">{ar ? "الرقم" : "Number"}</th>
                      <th className="text-start py-2">{ar ? "الحالة" : "Status"}</th>
                      <th className="text-end py-2">{ar ? "الإجمالي" : "Total"}</th>
                      <th className="text-start py-2">{ar ? "صالح حتى" : "Valid until"}</th>
                      <th className="text-start py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {deal.quotes.map((q) => (
                      <tr key={q.id} className="border-t border-border" data-testid={`quote-row-${q.quoteNumber}`}>
                        <td className="py-2.5 font-bold">
                          <Link href={`/dashboard/sales/quotes/${q.id}`} className="hover:text-orange">
                            {q.quoteNumber}
                          </Link>
                          {q.revision > 1 && (
                            <span className="text-[10px] text-brown/60 ps-1">r{q.revision}</span>
                          )}
                        </td>
                        <td className="py-2.5">
                          <QuoteStatusBadge status={q.status} />
                        </td>
                        <td className="py-2.5 text-end">
                          <Money value={q.grandTotal} currency={q.currency} />
                        </td>
                        <td className="py-2.5 text-xs text-brown">
                          {q.validUntil ? formatDate(q.validUntil) : "—"}
                        </td>
                        <td className="py-2.5 text-xs">
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

          {/* ── Activities ─────────────────────────────────────────── */}
          <Card>
            <SectionTitle
              right={
                can.write ? (
                  <button
                    onClick={() => setDialog("activity")}
                    className="text-xs font-bold text-orange hover:underline"
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
                        late ? "border-red-200 bg-red-50/40" : "border-border"
                      }`}
                    >
                      <span className="mt-0.5">
                        {a.completedAt ? (
                          <CheckCircle2 size={15} className="text-emerald-600" aria-hidden />
                        ) : (
                          <Clock size={15} className={late ? "text-red-600" : "text-brown/50"} aria-hidden />
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Pill>{pick(ACTIVITY_LABELS, a.type, lang)}</Pill>
                          <span className="font-bold text-sm text-charcoal">{a.subject}</span>
                        </div>
                        {a.body && <p className="text-xs text-brown mt-1 break-words">{a.body}</p>}
                        <p className="text-[11px] text-brown/60 mt-1">
                          {a.owner?.name}
                          {a.dueAt && ` · ${ar ? "الاستحقاق" : "due"} ${formatDate(a.dueAt)}`}
                          {a.completedAt && ` · ${ar ? "اكتمل" : "done"} ${formatDate(a.completedAt)}`}
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
                            if (res.ok) load();
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
                    className="text-xs font-bold text-orange hover:underline"
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
                    className="flex items-center gap-3 p-3 rounded-xl border border-border flex-wrap"
                  >
                    <Pill tone={s.status === "FEEDBACK_RECEIVED" ? "good" : s.status === "CANCELLED" ? "bad" : "info"}>
                      {pick(SAMPLE_LABELS, s.status, lang)}
                    </Pill>
                    <span className="font-bold text-sm flex-1 min-w-0 break-words">
                      {s.productSku?.name ?? s.productSku?.skuCode ?? s.description}
                    </span>
                    <span className="text-xs text-brown tabular-nums">
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
                          if (res.ok) load();
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
            <p className="text-[11px] text-brown/60 mt-3 font-medium">
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
              <Row label={ar ? "الاحتمال" : "Probability"}>{deal.probability}%</Row>
              <Row label={ar ? "الإغلاق المتوقع" : "Expected close"}>
                {deal.expectedCloseAt ? formatDate(deal.expectedCloseAt) : "—"}
              </Row>
              <Row label={ar ? "المتابعة القادمة" : "Next follow-up"}>
                {deal.nextFollowUpAt ? formatDate(deal.nextFollowUpAt) : "—"}
              </Row>
              <Row label={ar ? "أُنشئت" : "Created"}>{formatDate(deal.createdAt)}</Row>
              {deal.conversion && (
                <Row label={ar ? "من عميل محتمل" : "From lead"}>
                  <Link href={`/dashboard/sales/leads`} className="text-orange hover:underline">
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
              <p className="text-[11px] text-brown/60 mt-3 font-medium">
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
                    <Link href="/dashboard/orders" className="font-bold hover:text-orange">
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
                  <li key={e.id} className="border-s-2 border-border ps-3">
                    <p className="font-bold text-charcoal">
                      {e.toStage ? (ar ? e.toStage.nameAr : e.toStage.nameEn) : e.toOutcome ?? "—"}
                    </p>
                    {e.reason && <p className="text-brown break-words">{e.reason}</p>}
                    <p className="text-brown/50">{formatDate(e.createdAt)}</p>
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
            load();
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
            load();
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
            load();
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
            load();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs font-bold text-brown/70">{label}</dt>
      <dd className="font-semibold text-charcoal text-end">{children}</dd>
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
      <p className="text-[11px] text-brown/60 font-medium">
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
        className={`text-sm font-bold ${balanced ? "text-emerald-700" : "text-red-600"}`}
        data-testid="split-total"
        role="status"
      >
        {ar ? "الإجمالي" : "Total"}: {total.toFixed(2)}%
        {!balanced && ` — ${ar ? "يجب أن يساوي 100" : "must equal 100"}`}
      </div>
      <p className="text-[11px] text-brown/60 font-medium">
        {ar
          ? "التوزيع يقسّم الأساس قبل الشرائح، لا العمولة النهائية. والاستحقاقات السابقة لا تتغيّر."
          : "Splits divide the base before tiers, not the finished commission. Accruals already written do not change."}
      </p>
    </Modal>
  );
}
