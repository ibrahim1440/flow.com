"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { KanbanSquare, Trophy, XCircle, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";
import {
  ProvisionalBanner, PageHeader, Alert, SectionTitle, ROW_ACTION, Num, num, formatDay, moneyText,
} from "../_components/ui";

/**
 * Pipeline.
 *
 * SC-03 in the Sales Screens design: numbered stage columns, and the two outcomes in their
 * own section BELOW the board rather than as two more columns beside it.
 *
 * Stage movement is buttons, not drag-and-drop, and that is deliberate rather than a
 * shortcut: this screen is used on a phone and a tablet as much as a desktop, drag needs a
 * keyboard-accessible alternative anyway, and every move has to survive the server refusing
 * it. Buttons give one code path that works with touch, mouse and keyboard, and that visibly
 * reverts when the server says no.
 */

type Stage = { id: string; code: string; nameEn: string; nameAr: string; position: number; probability: number };
type Deal = {
  id: string;
  title: string;
  stageId: string;
  outcome: "OPEN" | "WON" | "LOST";
  lostReason: string | null;
  amount: string;
  currency: string;
  expectedCloseAt: string | null;
  nextFollowUpAt: string | null;
  closedAt: string | null;
  customer: { id: string; name: string; nameAr: string | null } | null;
  owner: { id: string; name: string } | null;
  _count: { quotes: number; samples: number; activities: number };
  quotes: { id: string }[];
};
type Payload = {
  stages: Stage[];
  deals: Deal[];
  scope: "own" | "all";
  can: { close: boolean; reopen: boolean };
};

export default function PipelinePage() {
  const user = useUser();
  const { t } = useI18n();
  const lang = user?.preferredLanguage ?? "ar";
  const rtl = lang === "ar";

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lostFor, setLostFor] = useState<Deal | null>(null);
  const [lostReason, setLostReason] = useState("");

  /**
   * Which stage sections are open on narrow screens. Empty means "not chosen yet", and the
   * first stage opens by default — an accordion where everything is shut shows the operator
   * a list of headings and no work.
   */
  const [openStages, setOpenStages] = useState<Record<string, boolean>>({});

  /**
   * Reload counter. The fetch lives in the effect rather than a `load()` the effect calls, so
   * the first `await` precedes any state write. Moving a deal bumps this to refresh.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/sales/opportunities");
      if (cancelled) return;
      if (res.ok) setData(await res.json());
      else setError(lang === "ar" ? "تعذّر تحميل مسار الصفقات." : "Could not load the pipeline.");
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [lang, reloadToken]);

  async function move(deal: Deal, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(deal.id);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(`/api/sales/opportunities/${deal.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The server refused. Nothing was moved optimistically, so there is nothing to put
        // back — the board simply still shows the truth.
        setError(payload.error ?? (lang === "ar" ? "تعذّر النقل." : "Could not move the deal."));
        return;
      }
      setSuccess(lang === "ar" ? "تم التحديث." : "Updated.");
      reload();
    } finally {
      setBusy(null);
    }
  }

  const openDeals = useMemo(() => (data?.deals ?? []).filter((d) => d.outcome === "OPEN"), [data]);
  const won = useMemo(() => (data?.deals ?? []).filter((d) => d.outcome === "WON"), [data]);
  const lost = useMemo(() => (data?.deals ?? []).filter((d) => d.outcome === "LOST"), [data]);

  // Whole riyals on a board — the decimals are noise at card size — but through the module's
  // one formatter, so the numerals and the currency word match every other screen.
  const money = (v: string, ccy: string) => moneyText(v, ccy, lang, 0);
  const stageName = (s: Stage) => (rtl ? s.nameAr : s.nameEn);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-oo-action-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const stages = data?.stages ?? [];
  const canClose = data?.can.close ?? false;
  const canReopen = data?.can.reopen ?? false;

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <PageHeader
        title={t("pipelineNav")}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{rtl ? "المراحل تُهيَّأ من إعدادات المبيعات" : "Stages are configured in Sales settings"}</span>
            <span aria-hidden className="text-oo-border-strong">·</span>
            <span>
              {rtl ? "«رابح» و«خاسر» نتيجتان لا مرحلتان" : "Won and Lost are outcomes, not stages"}
            </span>
          </span>
        }
      />

      {/* What this line says — whose deals these are, and that the outcomes below are NOT
          inside the total — is the difference between reading this board right and reading
          it wrong, so it is a sentence rather than a chip.

          Each clause is its own element: joined into one string, the bidi algorithm moves a
          "·" that falls between two Arabic-Indic numerals and the sentence ends up stating a
          count it was never given. */}
      <p
        className="flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-oo-text-secondary"
        data-testid="pipeline-scope"
      >
        {[
          `${rtl ? "النطاق: " : "Scope: "}${
            data?.scope === "own"
              ? (rtl ? "صفقاتك المفتوحة أنت" : "your own open deals")
              : (rtl ? "الصفقات المفتوحة للفريق" : "the team's open deals")
          }`,
          `${num(openDeals.length, lang)} ${rtl ? "صفقة بقيمة" : "deals, worth"} ${money(
            String(openDeals.reduce((s, d) => s + Number(d.amount), 0)),
            "SAR",
          )}`,
          rtl
            ? `«رابح» و«خاسر» خارج الأعمدة أدناه ولا يدخلان في هذا المجموع`
            : `Won and Lost sit outside the columns below and are not in that total`,
        ].map((part, i) => (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden className="text-oo-border-strong">·</span>}
            <span>{part}</span>
          </span>
        ))}
      </p>

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      {stages.length === 0 ? (
        <div className="text-center py-16 bg-oo-bg-default rounded-2xl border border-oo-border-default text-oo-text-muted">
          <KanbanSquare size={40} className="mx-auto mb-3 opacity-50" />
          <p className="font-semibold text-lg">
            {rtl ? "لم يتم إعداد مراحل المسار بعد." : "No pipeline stages are configured yet."}
          </p>
        </div>
      ) : (
        <>
        {/* Columns scroll horizontally in their own container so the page body never does.
            Desktop only: below lg the same data is an accordion, because sideways scrolling
            to find a column is the worst way to use a phone. */}
        <div className="hidden lg:block overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {stages.map((stage, stageIdx) => {
              const inStage = openDeals.filter((d) => d.stageId === stage.id);
              const stageValue = inStage.reduce((s, d) => s + Number(d.amount), 0);
              const prev = stages[stageIdx - 1];
              const next = stages[stageIdx + 1];
              return (
                <div
                  key={stage.id}
                  className="w-[290px] flex-shrink-0 rounded-2xl border border-oo-border-default bg-oo-bg-default p-3"
                  data-testid={`stage-${stage.code}`}
                >
                  {/* The design numbers the columns, because "which stage comes next" is the
                      question this board exists to answer and the order is otherwise only
                      implied by position. */}
                  <div className="mb-2 flex items-baseline justify-between px-1">
                    <span className="text-[12px] leading-[18px] tabular-nums text-oo-text-muted">
                      {num(inStage.length, lang)}
                    </span>
                    <span className="text-end">
                      <span className="block text-[14px] font-medium leading-[22px] text-oo-text-primary">
                        <Num>{String(stageIdx + 1).padStart(2, "0")}</Num>{" "}
                        {stageName(stage)}
                      </span>
                      <span className="block text-[12px] leading-[18px] tabular-nums text-oo-text-muted">
                        {money(String(stageValue), "SAR")}
                      </span>
                    </span>
                  </div>

                  <div className="space-y-2">
                    {inStage.length === 0 && (
                      <p className="rounded-xl border border-dashed border-oo-border-strong px-1 py-4 text-center text-[12px] leading-[18px] text-oo-text-muted">
                        {rtl ? "لا صفقات" : "No deals"}
                      </p>
                    )}
                    {inStage.map((deal) => (
                      <div
                        key={deal.id}
                        data-testid={`deal-${deal.id}`}
                        className="rounded-xl border border-oo-border-default bg-oo-bg-default p-3"
                      >
                        <Link
                          href={`/dashboard/sales/deals/${deal.id}`}
                          data-testid={`open-deal-${deal.id}`}
                          className="block rounded text-[14px] font-medium leading-[22px] text-oo-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-action-primary/40"
                        >
                          {deal.title}
                        </Link>
                        <p className="mt-1 text-[18px] font-semibold leading-[28px] tabular-nums text-oo-text-primary">
                          {money(deal.amount, deal.currency)}
                        </p>
                        <p className="text-[12px] leading-[18px] text-oo-text-muted">
                          {[
                            deal.customer
                              ? (rtl && deal.customer.nameAr ? deal.customer.nameAr : deal.customer.name)
                              : null,
                            `${rtl ? "احتمال" : "probability"} ${num(stage.probability, lang)}%`,
                            deal._count.quotes > 0
                              ? `${rtl ? "عروض" : "quotes"} ${num(deal._count.quotes, lang)}`
                              : null,
                            deal._count.samples > 0
                              ? `${rtl ? "عيّنات" : "samples"} ${num(deal._count.samples, lang)}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>

                        {/* Movement, keyboard-reachable and touch-friendly. The design labels
                            the two buttons rather than leaving bare chevrons, because on a
                            right-to-left board "forward" is the direction people get wrong. */}
                        <div className="mt-2 flex items-center gap-1.5 border-t border-oo-border-default pt-2">
                          <button
                            type="button"
                            disabled={!next || busy === deal.id}
                            onClick={() => next && move(deal, { toStageId: next.id })}
                            title={next ? `${rtl ? "إلى" : "to"} ${stageName(next)}` : undefined}
                            aria-label={next ? `${rtl ? "تقديم إلى" : "Move forward to"} ${stageName(next)}` : rtl ? "لا مرحلة بعدها" : "No later stage"}
                            className={`${ROW_ACTION} gap-1 text-oo-action-primary hover:border-oo-action-primary disabled:opacity-30`}
                          >
                            {rtl ? <ChevronLeft size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                            {rtl ? "التالية" : "Next"}
                          </button>
                          <button
                            type="button"
                            disabled={!prev || busy === deal.id}
                            onClick={() => prev && move(deal, { toStageId: prev.id })}
                            title={prev ? `${rtl ? "إلى" : "to"} ${stageName(prev)}` : undefined}
                            aria-label={prev ? `${rtl ? "إرجاع إلى" : "Move back to"} ${stageName(prev)}` : rtl ? "لا مرحلة قبلها" : "No earlier stage"}
                            className={`${ROW_ACTION} gap-1 text-oo-text-secondary hover:border-oo-action-primary disabled:opacity-30`}
                          >
                            {rtl ? <ChevronRight size={14} aria-hidden /> : <ChevronLeft size={14} aria-hidden />}
                            {rtl ? "السابقة" : "Back"}
                          </button>
                        </div>
                        {/* Closing a deal is not a move along the board, so it is not on the
                            same row as the two that are. */}
                        {canClose && (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy === deal.id}
                              onClick={() => move(deal, { toOutcome: "WON" })}
                              className="rounded-[10px] border border-oo-status-success bg-oo-status-success-bg px-2.5 py-1 text-[12px] leading-[18px] text-oo-status-success transition-colors hover:bg-oo-status-success/10 disabled:opacity-50"
                            >
                              {rtl ? "رابح" : "Won"}
                            </button>
                            <button
                              type="button"
                              disabled={busy === deal.id}
                              onClick={() => { setLostFor(deal); setLostReason(""); }}
                              className="rounded-[10px] border border-oo-status-rejected bg-oo-status-rejected-bg px-2.5 py-1 text-[12px] leading-[18px] text-oo-status-rejected transition-colors hover:bg-oo-status-rejected/10 disabled:opacity-50"
                            >
                              {rtl ? "خاسر" : "Lost"}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── The outcomes, below the board rather than beside it ──────────────────────
            They were a fifth and sixth column separated by a dashed rule, which reads as
            two more stages however the rule is drawn. A deal that is won has left the
            funnel; the design says so with a heading instead of a divider. */}
        <div className="hidden lg:block">
          <SectionTitle>
            {rtl
              ? "النتائج — خارج الأعمدة، لأن «رابح» و«خاسر» ليستا مرحلتين"
              : "Outcomes — outside the columns, because Won and Lost are not stages"}
          </SectionTitle>
          <div className="grid gap-3 lg:grid-cols-2">
            {[
              { key: "won", list: won, label: rtl ? "رابح" : "Won", Icon: Trophy, tone: "success" as const },
              { key: "lost", list: lost, label: rtl ? "خاسر" : "Lost", Icon: XCircle, tone: "rejected" as const },
            ].map(({ key, list, label, Icon, tone }) => (
              <div
                key={key}
                className="rounded-2xl border border-oo-border-default bg-oo-bg-default p-3"
                data-testid={`outcome-${key}`}
              >
                <div className="mb-2 flex items-baseline justify-between px-1">
                  <span className="text-[12px] leading-[18px] tabular-nums text-oo-text-muted">
                    {num(list.length, lang)}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium leading-[18px] ${
                      tone === "success"
                        ? "border-oo-status-success bg-oo-status-success-bg text-oo-status-success"
                        : "border-oo-status-rejected bg-oo-status-rejected-bg text-oo-status-rejected"
                    }`}
                  >
                    {label} <Icon size={14} aria-hidden />
                  </span>
                </div>
                <div className="space-y-2">
                  {list.slice(0, 30).map((deal) => (
                    <div
                      key={deal.id}
                      data-testid={`deal-${deal.id}`}
                      className={`rounded-xl border p-3 ${
                        tone === "success" ? "border-oo-status-success" : "border-oo-border-default"
                      }`}
                    >
                      <Link
                        href={`/dashboard/sales/deals/${deal.id}`}
                        data-testid={`open-deal-${deal.id}`}
                        className="block rounded text-[14px] font-medium leading-[22px] text-oo-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-action-primary/40"
                      >
                        {deal.title}
                      </Link>
                      <p className="text-[18px] font-semibold leading-[28px] tabular-nums text-oo-text-primary">
                        {money(deal.amount, deal.currency)}
                      </p>
                      <p className="text-[12px] leading-[18px] text-oo-text-muted">
                        {[
                          deal.closedAt
                            ? `${tone === "success" ? (rtl ? "رُبحت" : "won") : (rtl ? "أُغلقت" : "closed")} ${formatDay(deal.closedAt, lang)}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {deal.lostReason && (
                        <p className="mt-1.5 rounded-[10px] bg-oo-bg-subtle px-3 py-[9px] text-[12px] leading-[18px] text-oo-text-secondary">
                          {rtl ? "السبب" : "Reason"}: {deal.lostReason}
                        </p>
                      )}
                      {canReopen && (
                        <button
                          type="button"
                          disabled={busy === deal.id}
                          onClick={() => move(deal, { toOutcome: "OPEN" })}
                          className={`${ROW_ACTION} mt-1.5 text-oo-text-secondary hover:border-oo-action-primary disabled:opacity-50`}
                        >
                          {rtl ? "إعادة فتح" : "Reopen"}
                        </button>
                      )}
                    </div>
                  ))}
                  {list.length === 0 && (
                    <p className="rounded-xl border border-dashed border-oo-border-strong px-1 py-4 text-center text-[12px] leading-[18px] text-oo-text-muted">
                      {rtl ? "لا صفقات" : "None"}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Narrow screens: the same board as stacked, collapsible sections ──────────
            Same stages, same outcomes, same `move` handler, same permission flags. Nothing
            here is a second source of truth; it is one layout swapped for another, so a
            stage renamed in settings renames in both without anyone remembering to look.
            Vertical order needs no RTL reversal — top-to-bottom reads the same in Arabic —
            but the move buttons keep the direction-aware icons the board uses. */}
        <div className="lg:hidden space-y-3" data-testid="pipeline-accordion">
          {stages.map((stage, stageIdx) => {
            const inStage = openDeals.filter((d) => d.stageId === stage.id);
            const stageValue = inStage.reduce((s, d) => s + Number(d.amount), 0);
            const prev = stages[stageIdx - 1];
            const next = stages[stageIdx + 1];
            // Nothing chosen yet: the first stage is open, so the screen opens on work.
            const isOpen = openStages[stage.id] ?? stageIdx === 0;
            return (
              <div
                key={stage.id}
                className="bg-oo-bg-default rounded-2xl border border-oo-border-default overflow-hidden"
                data-testid={`m-stage-${stage.code}`}
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`m-stage-body-${stage.code}`}
                  onClick={() => setOpenStages((s) => ({ ...s, [stage.id]: !isOpen }))}
                  className="w-full flex items-center justify-between gap-2 px-4 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-action-primary/40"
                >
                  <span className="min-w-0">
                    <span className="block font-bold text-sm text-oo-text-primary truncate">
                      {stageName(stage)}
                    </span>
                    <span className="block text-[11px] text-oo-text-muted tabular-nums">
                      {inStage.length} · {money(String(stageValue), "SAR")}
                    </span>
                  </span>
                  <ChevronDown
                    size={18}
                    aria-hidden
                    className={`flex-shrink-0 text-oo-text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>

                <div id={`m-stage-body-${stage.code}`} hidden={!isOpen} className="px-3 pb-3 space-y-2">
                  {inStage.length === 0 && (
                    <p className="text-xs text-oo-text-muted py-4 text-center border border-dashed border-oo-border-strong rounded-xl">
                      {rtl ? "لا صفقات" : "No deals"}
                    </p>
                  )}
                  {inStage.map((deal) => (
                    <div
                      key={deal.id}
                      data-testid={`m-deal-${deal.id}`}
                      className="rounded-xl border border-oo-border-default p-3 space-y-2"
                    >
                      <Link
                        href={`/dashboard/sales/deals/${deal.id}`}
                        data-testid={`m-open-deal-${deal.id}`}
                        className="block font-bold text-sm text-oo-text-primary leading-snug break-words hover:text-oo-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-action-primary/40 rounded"
                      >
                        {deal.title}
                      </Link>
                      {deal.customer && (
                        <p className="text-xs text-oo-text-secondary break-words">
                          {rtl && deal.customer.nameAr ? deal.customer.nameAr : deal.customer.name}
                        </p>
                      )}
                      <p className="text-xs font-bold text-oo-text-primary tabular-nums">
                        {money(deal.amount, deal.currency)}
                      </p>
                      {deal.owner?.name && (
                        <p className="text-[11px] text-oo-text-muted break-words">{deal.owner.name}</p>
                      )}

                      {/* Full-width targets: these are pressed with a thumb. */}
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <button
                          type="button"
                          disabled={!prev || busy === deal.id}
                          onClick={() => prev && move(deal, { toStageId: prev.id })}
                          aria-label={prev ? `${rtl ? "إرجاع إلى" : "Move back to"} ${stageName(prev)}` : rtl ? "لا مرحلة قبلها" : "No earlier stage"}
                          className="flex items-center justify-center gap-1 py-2 rounded-lg border border-oo-border-default text-xs font-bold text-oo-text-secondary disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          {rtl ? <ChevronRight size={14} aria-hidden /> : <ChevronLeft size={14} aria-hidden />}
                          {rtl ? "السابقة" : "Back"}
                        </button>
                        <button
                          type="button"
                          disabled={!next || busy === deal.id}
                          onClick={() => next && move(deal, { toStageId: next.id })}
                          aria-label={next ? `${rtl ? "تقديم إلى" : "Move forward to"} ${stageName(next)}` : rtl ? "لا مرحلة بعدها" : "No later stage"}
                          className="flex items-center justify-center gap-1 py-2 rounded-lg border border-oo-border-default text-xs font-bold text-oo-text-secondary disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          {rtl ? "التالية" : "Next"}
                          {rtl ? <ChevronLeft size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                        </button>
                      </div>
                      {canClose && (
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            disabled={busy === deal.id}
                            onClick={() => move(deal, { toOutcome: "WON" })}
                            className="py-2 rounded-lg text-xs font-bold text-oo-status-success bg-oo-status-success-bg disabled:opacity-50"
                          >
                            {rtl ? "ربح" : "Won"}
                          </button>
                          <button
                            type="button"
                            disabled={busy === deal.id}
                            onClick={() => { setLostFor(deal); setLostReason(""); }}
                            className="py-2 rounded-lg text-xs font-bold text-oo-status-rejected bg-oo-status-rejected-bg disabled:opacity-50"
                          >
                            {rtl ? "خسارة" : "Lost"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Outcomes stay outside the stage list here too — they are results, not stages. */}
          {[
            { key: "won", list: won, label: rtl ? "رابحة" : "Won", Icon: Trophy, tone: "text-oo-status-success" },
            { key: "lost", list: lost, label: rtl ? "خاسرة" : "Lost", Icon: XCircle, tone: "text-oo-status-rejected" },
          ].map(({ key, list, label, Icon, tone }) => {
            const isOpen = openStages[`outcome-${key}`] ?? false;
            return (
              <div
                key={key}
                className="bg-oo-bg-default rounded-2xl border border-oo-border-default border-dashed overflow-hidden"
                data-testid={`m-outcome-${key}`}
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`m-outcome-body-${key}`}
                  onClick={() => setOpenStages((s) => ({ ...s, [`outcome-${key}`]: !isOpen }))}
                  className="w-full flex items-center justify-between gap-2 px-4 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-action-primary/40"
                >
                  <span className={`font-bold text-sm flex items-center gap-1.5 ${tone}`}>
                    <Icon size={14} aria-hidden /> {label}
                    <span className="text-[11px] text-oo-text-muted tabular-nums">({list.length})</span>
                  </span>
                  <ChevronDown
                    size={18}
                    aria-hidden
                    className={`flex-shrink-0 text-oo-text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                <div id={`m-outcome-body-${key}`} hidden={!isOpen} className="px-3 pb-3 space-y-2">
                  {list.length === 0 && (
                    <p className="text-xs text-oo-text-muted py-4 text-center border border-dashed border-oo-border-strong rounded-xl">
                      {rtl ? "لا صفقات" : "None"}
                    </p>
                  )}
                  {list.slice(0, 30).map((deal) => (
                    <div key={deal.id} data-testid={`m-deal-${deal.id}`} className="rounded-xl border border-oo-border-default p-3 space-y-1.5">
                      <Link
                        href={`/dashboard/sales/deals/${deal.id}`}
                        className="block font-bold text-sm text-oo-text-primary leading-snug break-words hover:text-oo-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-action-primary/40 rounded"
                      >
                        {deal.title}
                      </Link>
                      <p className="text-xs font-bold tabular-nums">{money(deal.amount, deal.currency)}</p>
                      {deal.lostReason && (
                        <p className="text-[11px] text-oo-status-rejected break-words">
                          {rtl ? "السبب" : "Reason"}: {deal.lostReason}
                        </p>
                      )}
                      {canReopen && (
                        <button
                          type="button"
                          disabled={busy === deal.id}
                          onClick={() => move(deal, { toOutcome: "OPEN" })}
                          className="w-full py-2 rounded-lg text-xs font-bold border border-oo-border-default text-oo-text-secondary disabled:opacity-50"
                        >
                          {rtl ? "إعادة فتح" : "Reopen"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {/* Lost needs a reason. Asked for here rather than accepted as optional, because a
          lost-reason report with half its rows blank answers nothing. */}
      {lostFor && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-oo-bg-default rounded-2xl w-full max-w-md p-5 space-y-3" data-testid="lost-dialog">
            <h2 className="font-extrabold text-oo-text-primary">{rtl ? "سبب الخسارة" : "Reason for losing"}</h2>
            <p className="text-xs text-oo-text-secondary">{lostFor.title}</p>
            <textarea
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-xl border border-oo-border-strong text-sm"
              placeholder={rtl ? "مثال: السعر أعلى من المنافس" : "e.g. price higher than a competitor"}
            />
            <div className="flex gap-3">
              <button
                type="button"
                disabled={lostReason.trim().length < 3 || busy === lostFor.id}
                onClick={async () => {
                  const d = lostFor;
                  setLostFor(null);
                  await move(d, { toOutcome: "LOST", lostReason });
                }}
                className="flex-1 py-2.5 rounded-xl bg-red-700 text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {rtl ? "تأكيد الخسارة" : "Confirm lost"}
              </button>
              <button
                type="button"
                onClick={() => setLostFor(null)}
                className="flex-1 py-2.5 border border-oo-border-strong rounded-xl font-bold text-sm text-oo-text-secondary hover:bg-oo-bg-subtle transition-colors"
              >
                {rtl ? "إلغاء" : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
