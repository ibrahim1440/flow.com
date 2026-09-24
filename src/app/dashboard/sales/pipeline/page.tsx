"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { AlertTriangle, KanbanSquare, Trophy, XCircle, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";
import { formatDate } from "@/lib/utils";

/**
 * Pipeline.
 *
 * PROVISIONAL INTERFACE — no Figma design exists yet; see docs/sales/FIGMA_UX_HANDOFF.md.
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

  const money = (v: string, ccy: string) =>
    `${Number(v).toLocaleString(rtl ? "ar-SA" : "en-GB", { maximumFractionDigits: 0 })} ${ccy}`;
  const stageName = (s: Stage) => (rtl ? s.nameAr : s.nameEn);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-orange border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const stages = data?.stages ?? [];
  const canClose = data?.can.close ?? false;
  const canReopen = data?.can.reopen ?? false;

  return (
    <div className="space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 flex items-start gap-2">
        <AlertTriangle size={15} className="text-amber-700 flex-shrink-0 mt-0.5" />
        <p className="text-xs font-bold text-amber-900">{t("provisionalUiBanner")}</p>
      </div>

      <div>
        <h1 className="text-2xl font-extrabold text-charcoal flex items-center gap-2">
          <KanbanSquare size={22} className="text-orange" /> {t("pipelineNav")}
        </h1>
        <p className="text-brown text-sm font-medium">
          {openDeals.length} {rtl ? "مفتوحة" : "open"} · {won.length} {rtl ? "رابحة" : "won"} · {lost.length} {rtl ? "خاسرة" : "lost"}
        </p>
        {data?.scope === "own" && (
          <p className="text-xs text-brown/60 font-semibold mt-1">
            {rtl ? "تُعرض صفقاتك فقط." : "Showing only your own deals."}
          </p>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm font-bold" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-success-bg border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm font-bold">
          {success}
        </div>
      )}

      {stages.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl border border-border text-brown/40">
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
                <div key={stage.id} className="w-[290px] flex-shrink-0" data-testid={`stage-${stage.code}`}>
                  <div className="flex items-baseline justify-between mb-2 px-1">
                    <p className="text-sm font-bold text-charcoal">{stageName(stage)}</p>
                    <span className="text-[11px] font-bold text-brown/60 tabular-nums">
                      {inStage.length} · {money(String(stageValue), "SAR")}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {inStage.length === 0 && (
                      <p className="text-xs text-brown/40 px-1 py-4 text-center border-2 border-dashed border-border rounded-xl">
                        {rtl ? "لا صفقات" : "No deals"}
                      </p>
                    )}
                    {inStage.map((deal) => (
                      <div
                        key={deal.id}
                        data-testid={`deal-${deal.id}`}
                        className="bg-white rounded-xl border border-border p-3 space-y-2"
                      >
<Link
                          href={`/dashboard/sales/deals/${deal.id}`}
                          data-testid={`open-deal-${deal.id}`}
                          className="block font-bold text-sm text-charcoal leading-snug hover:text-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/50 rounded"
                        >
                          {deal.title}
                        </Link>
                        {deal.customer && (
                          <p className="text-xs text-brown">
                            {rtl && deal.customer.nameAr ? deal.customer.nameAr : deal.customer.name}
                          </p>
                        )}
                        <p className="text-xs font-bold text-charcoal tabular-nums">
                          {money(deal.amount, deal.currency)}
                        </p>
                        <p className="text-[11px] text-brown/60">
                          {deal.owner?.name}
                          {deal.expectedCloseAt && <> · {formatDate(deal.expectedCloseAt)}</>}
                        </p>
                        {(deal._count.quotes > 0 || deal._count.samples > 0) && (
                          <p className="text-[11px] text-brown/60">
                            {deal._count.quotes > 0 && <>{rtl ? "عروض" : "quotes"}: {deal._count.quotes} </>}
                            {deal._count.samples > 0 && <>· {rtl ? "عينات" : "samples"}: {deal._count.samples}</>}
                          </p>
                        )}

                        {/* Movement, keyboard-reachable and touch-friendly. */}
                        <div className="flex items-center gap-1 pt-1 border-t border-border">
                          <button
                            type="button"
                            disabled={!prev || busy === deal.id}
                            onClick={() => prev && move(deal, { toStageId: prev.id })}
                            title={prev ? `${rtl ? "إلى" : "to"} ${stageName(prev)}` : undefined}
                            aria-label={prev ? `${rtl ? "إرجاع إلى" : "Move back to"} ${stageName(prev)}` : rtl ? "لا مرحلة قبلها" : "No earlier stage"}
                            className="p-1.5 rounded-lg text-brown/50 hover:text-orange hover:bg-orange/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          >
                            {rtl ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
                          </button>
                          <button
                            type="button"
                            disabled={!next || busy === deal.id}
                            onClick={() => next && move(deal, { toStageId: next.id })}
                            title={next ? `${rtl ? "إلى" : "to"} ${stageName(next)}` : undefined}
                            aria-label={next ? `${rtl ? "تقديم إلى" : "Move forward to"} ${stageName(next)}` : rtl ? "لا مرحلة بعدها" : "No later stage"}
                            className="p-1.5 rounded-lg text-brown/50 hover:text-orange hover:bg-orange/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          >
                            {rtl ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
                          </button>
                          <div className="flex-1" />
                          {canClose && (
                            <>
                              <button
                                type="button"
                                disabled={busy === deal.id}
                                onClick={() => move(deal, { toOutcome: "WON" })}
                                className="px-2 py-1 rounded-lg text-[11px] font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 transition-colors"
                              >
                                {rtl ? "ربح" : "Won"}
                              </button>
                              <button
                                type="button"
                                disabled={busy === deal.id}
                                onClick={() => { setLostFor(deal); setLostReason(""); }}
                                className="px-2 py-1 rounded-lg text-[11px] font-bold text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-50 transition-colors"
                              >
                                {rtl ? "خسارة" : "Lost"}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Terminal outcomes sit apart from the funnel, because they are not stages. */}
            {[
              { key: "won", list: won, label: rtl ? "رابحة" : "Won", Icon: Trophy, tone: "text-emerald-800" },
              { key: "lost", list: lost, label: rtl ? "خاسرة" : "Lost", Icon: XCircle, tone: "text-red-700" },
            ].map(({ key, list, label, Icon, tone }) => (
              <div key={key} className="w-[290px] flex-shrink-0 ps-3 border-s-2 border-rule border-dashed" data-testid={`outcome-${key}`}>
                <div className="flex items-baseline justify-between mb-2 px-1">
                  <p className={`text-sm font-bold flex items-center gap-1.5 ${tone}`}>
                    <Icon size={14} /> {label}
                  </p>
                  <span className="text-[11px] font-bold text-brown/60 tabular-nums">{list.length}</span>
                </div>
                <div className="space-y-2">
                  {list.slice(0, 30).map((deal) => (
                    <div key={deal.id} data-testid={`deal-${deal.id}`} className="bg-white rounded-xl border border-border p-3 space-y-1.5 opacity-90">
                      <Link
                        href={`/dashboard/sales/deals/${deal.id}`}
                        data-testid={`open-deal-${deal.id}`}
                        className="block font-bold text-sm text-charcoal leading-snug hover:text-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/50 rounded"
                      >
                        {deal.title}
                      </Link>
                      <p className="text-xs font-bold tabular-nums">{money(deal.amount, deal.currency)}</p>
                      {deal.lostReason && (
                        <p className="text-[11px] text-red-700">{rtl ? "السبب" : "Reason"}: {deal.lostReason}</p>
                      )}
                      {deal.closedAt && (
                        <p className="text-[11px] text-brown/50">{formatDate(deal.closedAt)}</p>
                      )}
                      {canReopen && (
                        <button
                          type="button"
                          disabled={busy === deal.id}
                          onClick={() => move(deal, { toOutcome: "OPEN" })}
                          className="px-2 py-1 rounded-lg text-[11px] font-bold border border-border text-brown hover:border-orange/60 hover:text-orange disabled:opacity-50 transition-colors"
                        >
                          {rtl ? "إعادة فتح" : "Reopen"}
                        </button>
                      )}
                    </div>
                  ))}
                  {list.length === 0 && (
                    <p className="text-xs text-brown/40 px-1 py-4 text-center border-2 border-dashed border-border rounded-xl">
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
                className="bg-white rounded-2xl border border-border overflow-hidden"
                data-testid={`m-stage-${stage.code}`}
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`m-stage-body-${stage.code}`}
                  onClick={() => setOpenStages((s) => ({ ...s, [stage.id]: !isOpen }))}
                  className="w-full flex items-center justify-between gap-2 px-4 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/50"
                >
                  <span className="min-w-0">
                    <span className="block font-bold text-sm text-charcoal truncate">
                      {stageName(stage)}
                    </span>
                    <span className="block text-[11px] text-brown/60 tabular-nums">
                      {inStage.length} · {money(String(stageValue), "SAR")}
                    </span>
                  </span>
                  <ChevronDown
                    size={18}
                    aria-hidden
                    className={`flex-shrink-0 text-brown/50 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>

                <div id={`m-stage-body-${stage.code}`} hidden={!isOpen} className="px-3 pb-3 space-y-2">
                  {inStage.length === 0 && (
                    <p className="text-xs text-brown/40 py-4 text-center border-2 border-dashed border-border rounded-xl">
                      {rtl ? "لا صفقات" : "No deals"}
                    </p>
                  )}
                  {inStage.map((deal) => (
                    <div
                      key={deal.id}
                      data-testid={`m-deal-${deal.id}`}
                      className="rounded-xl border border-border p-3 space-y-2"
                    >
                      <Link
                        href={`/dashboard/sales/deals/${deal.id}`}
                        data-testid={`m-open-deal-${deal.id}`}
                        className="block font-bold text-sm text-charcoal leading-snug break-words hover:text-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/50 rounded"
                      >
                        {deal.title}
                      </Link>
                      {deal.customer && (
                        <p className="text-xs text-brown break-words">
                          {rtl && deal.customer.nameAr ? deal.customer.nameAr : deal.customer.name}
                        </p>
                      )}
                      <p className="text-xs font-bold text-charcoal tabular-nums">
                        {money(deal.amount, deal.currency)}
                      </p>
                      {deal.owner?.name && (
                        <p className="text-[11px] text-brown/60 break-words">{deal.owner.name}</p>
                      )}

                      {/* Full-width targets: these are pressed with a thumb. */}
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <button
                          type="button"
                          disabled={!prev || busy === deal.id}
                          onClick={() => prev && move(deal, { toStageId: prev.id })}
                          aria-label={prev ? `${rtl ? "إرجاع إلى" : "Move back to"} ${stageName(prev)}` : rtl ? "لا مرحلة قبلها" : "No earlier stage"}
                          className="flex items-center justify-center gap-1 py-2 rounded-lg border border-border text-xs font-bold text-brown disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          {rtl ? <ChevronRight size={14} aria-hidden /> : <ChevronLeft size={14} aria-hidden />}
                          {rtl ? "السابقة" : "Back"}
                        </button>
                        <button
                          type="button"
                          disabled={!next || busy === deal.id}
                          onClick={() => next && move(deal, { toStageId: next.id })}
                          aria-label={next ? `${rtl ? "تقديم إلى" : "Move forward to"} ${stageName(next)}` : rtl ? "لا مرحلة بعدها" : "No later stage"}
                          className="flex items-center justify-center gap-1 py-2 rounded-lg border border-border text-xs font-bold text-brown disabled:opacity-30 disabled:cursor-not-allowed"
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
                            className="py-2 rounded-lg text-xs font-bold text-emerald-800 bg-emerald-50 disabled:opacity-50"
                          >
                            {rtl ? "ربح" : "Won"}
                          </button>
                          <button
                            type="button"
                            disabled={busy === deal.id}
                            onClick={() => { setLostFor(deal); setLostReason(""); }}
                            className="py-2 rounded-lg text-xs font-bold text-red-700 bg-red-50 disabled:opacity-50"
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
            { key: "won", list: won, label: rtl ? "رابحة" : "Won", Icon: Trophy, tone: "text-emerald-800" },
            { key: "lost", list: lost, label: rtl ? "خاسرة" : "Lost", Icon: XCircle, tone: "text-red-700" },
          ].map(({ key, list, label, Icon, tone }) => {
            const isOpen = openStages[`outcome-${key}`] ?? false;
            return (
              <div
                key={key}
                className="bg-white rounded-2xl border border-border border-dashed overflow-hidden"
                data-testid={`m-outcome-${key}`}
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`m-outcome-body-${key}`}
                  onClick={() => setOpenStages((s) => ({ ...s, [`outcome-${key}`]: !isOpen }))}
                  className="w-full flex items-center justify-between gap-2 px-4 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/50"
                >
                  <span className={`font-bold text-sm flex items-center gap-1.5 ${tone}`}>
                    <Icon size={14} aria-hidden /> {label}
                    <span className="text-[11px] text-brown/60 tabular-nums">({list.length})</span>
                  </span>
                  <ChevronDown
                    size={18}
                    aria-hidden
                    className={`flex-shrink-0 text-brown/50 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                <div id={`m-outcome-body-${key}`} hidden={!isOpen} className="px-3 pb-3 space-y-2">
                  {list.length === 0 && (
                    <p className="text-xs text-brown/40 py-4 text-center border-2 border-dashed border-border rounded-xl">
                      {rtl ? "لا صفقات" : "None"}
                    </p>
                  )}
                  {list.slice(0, 30).map((deal) => (
                    <div key={deal.id} data-testid={`m-deal-${deal.id}`} className="rounded-xl border border-border p-3 space-y-1.5">
                      <Link
                        href={`/dashboard/sales/deals/${deal.id}`}
                        className="block font-bold text-sm text-charcoal leading-snug break-words hover:text-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/50 rounded"
                      >
                        {deal.title}
                      </Link>
                      <p className="text-xs font-bold tabular-nums">{money(deal.amount, deal.currency)}</p>
                      {deal.lostReason && (
                        <p className="text-[11px] text-red-700 break-words">
                          {rtl ? "السبب" : "Reason"}: {deal.lostReason}
                        </p>
                      )}
                      {canReopen && (
                        <button
                          type="button"
                          disabled={busy === deal.id}
                          onClick={() => move(deal, { toOutcome: "OPEN" })}
                          className="w-full py-2 rounded-lg text-xs font-bold border border-border text-brown disabled:opacity-50"
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
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" data-testid="lost-dialog">
            <h2 className="font-extrabold text-charcoal">{rtl ? "سبب الخسارة" : "Reason for losing"}</h2>
            <p className="text-xs text-brown">{lostFor.title}</p>
            <textarea
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm"
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
                className="flex-1 py-2.5 border-2 border-border rounded-xl font-bold text-sm text-brown hover:bg-cream transition-colors"
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
