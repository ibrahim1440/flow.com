"use client";

import { localizeApiError } from "@/lib/i18n/api-errors";
import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLang } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import { initials, splitTitle, openDealsText } from "@/components/d21/labels";
import { currencyLabel, dayCount, daysFromToday, shortDate, whole } from "@/components/d21/format";
import {
  AutoToast, Chip, MoveSheet, SkipSamplesSheet, autoWhy, cardChip, isAutoReason, type CardNextStep,
} from "../_components/pv2";

/**
 * «مسار الصفقات» — pipeline v2, built to Figma page 08: board 1440 (`1764:15`), phone list (`1765:517`,
 * empty `1765:598`), empty column (`1765:671`), no results (`1765:680`), annotations (`1773:1674`).
 *
 * Three stage columns (count + SAR total) and a collapsed «مغلقة»; «صفقاتي | الفريق», «يحتاج تصرّفي», search
 * and the order. A card shows its state chip (the quotation's sub-status in «عرض السعر والتفاوض», owner
 * decision 2) and its «التالي: …» line — both the server's `nextStep`. Moving a card (drag, or «نقل إلى…»)
 * needs lead_write; without `deal_stage_move` it becomes a request a supervisor approves (owner decision 3).
 * A deal that moved automatically since the last visit is announced once («انتقلت … تلقائيًا»).
 */

type Stage = { id: string; code: string; nameEn: string; nameAr: string; position: number; probability: number; purpose?: string | null };
type Quote = { id: string; quoteNumber: string; revision: number; status: string; acceptedAt: string | null };
type Deal = {
  id: string;
  title: string;
  stageId: string;
  outcome: "OPEN" | "WON" | "LOST";
  lostReason: string | null;
  amount: string;
  currency: string;
  probability?: number;
  expectedCloseAt: string | null;
  nextFollowUpAt: string | null;
  closedAt: string | null;
  createdAt?: string;
  customer: { id: string; name: string; nameAr: string | null } | null;
  owner: { id: string; name: string } | null;
  _count: { quotes: number; samples: number; activities: number; orderLinks?: number };
  latestQuote?: Quote | null;
  acceptedQuote?: Quote | null;
  nextActivity?: { type: string; subject: string; dueAt: string | null } | null;
  stageSince?: string;
  lastMove?: { at: string; reason: string | null; byMe: boolean } | null;
  nextStep?: CardNextStep;
  pendingMove?: { id: string; toStageId: string; mine: boolean; canDecide: boolean } | null;
  needsMe?: boolean;
};
type Payload = {
  stages: Stage[];
  deals: Deal[];
  me?: string;
  scope: "own" | "all";
  can: { close: boolean; reopen: boolean; createOrder?: boolean; createLead?: boolean; move?: boolean; moveDirectly?: boolean };
};

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** «تنتقل هنا تلقائيًا عندما…» (annotation 5): how a deal enters each stage. */
const EMPTY_BY_PURPOSE: Record<string, { ar: string; en: string }> = {
  QUALIFICATION: { ar: "لا صفقات هنا. تبدأ الصفقة هنا عند تحويل عميل محتمل.", en: "No deals. A deal starts here when a lead is converted." },
  SAMPLE_EVALUATION: { ar: "لا صفقات هنا. تنتقل الصفقة هنا تلقائيًا عند طلب عيّنة أو تسجيلها.", en: "No deals. A deal moves here when a sample is requested or recorded." },
  QUOTATION: { ar: "لا صفقات هنا. تنتقل الصفقة هنا تلقائيًا عند إصدار عرض السعر.", en: "No deals. A deal moves here when a quotation is issued." },
};
const SEEN_KEY = "pv2:board-seen";

export default function PipelinePage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();
  useD21Phone({ title: ar ? "الصفقات" : "Deals" });

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  // A failed load shows no figures (annotation 5): a «0» would be a wrong number.
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [followUps, setFollowUps] = useState<number | null>(null);

  const params = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState("");
  // «لوحة الأداء» opens the board on one rep's deals (`?owner=<employee id>`).
  const [owner, setOwner] = useState(params.get("owner") || "all");
  const [mine, setMine] = useState<boolean | null>(params.get("owner") ? false : null);
  const [needsMe, setNeedsMe] = useState(params.get("needs") === "1");
  const [sort, setSort] = useState<"waiting" | "value" | "close">("waiting");
  const [closedOpen, setClosedOpen] = useState(false);
  const [seg, setSeg] = useState<string | null>(null);

  const [moveFor, setMoveFor] = useState<{ deal: Deal; to?: string } | null>(null);
  const [skipFor, setSkipFor] = useState<Deal | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  const [toast, setToast] = useState<{ id: string; title: string; why: string } | null>(null);

  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/sales/opportunities").catch(() => null);
      if (cancelled) return;
      if (res?.ok) { setData(await res.json()); setLoadFailed(false); }
      else setLoadFailed(true);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [reloadToken]);

  // The count on «الأنشطة والمتابعات»: open follow-ups in the same scope the follow-ups page shows.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/sales/activities?filter=open&perPage=1").catch(() => null);
      if (cancelled || !res?.ok) return;
      const j = await res.json().catch(() => null);
      if (!cancelled && typeof j?.counts?.open === "number") setFollowUps(j.counts.open);
    })();
    return () => { cancelled = true; };
  }, [reloadToken]);

  const deals = useMemo(() => data?.deals ?? [], [data]);
  const stages = useMemo(() => data?.stages ?? [], [data]);
  const can = data?.can ?? { close: false, reopen: false };
  const me = data?.me;
  const teamView = data?.scope === "all";
  // «صفقاتي» is the default for a rep; a manager (scope all) opens on «الفريق».
  const onlyMine = mine ?? !teamView;
  const stageName = useCallback((id: string) => {
    const s = stages.find((x) => x.id === id);
    return s ? (ar ? s.nameAr : s.nameEn) : "";
  }, [stages, ar]);

  // «انتقلت … تلقائيًا» — once per move: the board remembers (per browser tab) where each deal was when last seen.
  useEffect(() => {
    if (!data) return;
    let seen: Record<string, string> = {};
    try { seen = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "{}"); } catch { /* private mode */ }
    try { sessionStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(data.deals.map((d) => [d.id, d.stageId])))); } catch { /* ignore */ }
    const moved = data.deals.find((d) => d.outcome === "OPEN" && seen[d.id] && seen[d.id] !== d.stageId
      && d.lastMove && isAutoReason(d.lastMove.reason) && (d.owner?.id === data.me || d.lastMove.byMe));
    if (!moved) return;
    const name = splitTitle(moved.title, moved.customer ? (ar ? moved.customer.nameAr ?? moved.customer.name : moved.customer.name) : null).top;
    const show = window.setTimeout(() => {
      setToast({ id: moved.id, title: ar ? `انتقلت «${name}» إلى ${stageName(moved.stageId)}` : `“${name}” moved to ${stageName(moved.stageId)}`, why: autoWhy(moved.lastMove!.reason, ar) ?? "" });
      setArrived(moved.id);
    }, 0);
    const fade = window.setTimeout(() => setArrived(null), 1200);
    return () => { window.clearTimeout(show); window.clearTimeout(fade); };
  }, [data, ar, stageName]);

  async function post(url: string, body: Record<string, unknown>) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const payload = (res ? await res.json().catch(() => ({})) : {}) as Record<string, unknown> & { code?: string; pending?: boolean };
    return { ok: !!res?.ok, status: res?.status ?? 0, payload };
  }

  async function reopen(deal: Deal) {
    if (busy) return;
    setBusy(deal.id); setError(""); setSuccess("");
    const r = await post(`/api/sales/opportunities/${deal.id}/transition`, { toOutcome: "OPEN" });
    setBusy(null);
    if (!r.ok) { setError(localizeApiError(r.payload) ?? (ar ? "تعذّر التنفيذ." : "Could not do that.")); return; }
    setSuccess(ar ? "أُعيد فتح الصفقة." : "Deal reopened.");
    reload();
  }

  /** A manual move: applied directly (deal_stage_move) or sent as a request (202 pending). */
  async function move(deal: Deal, toStageId: string, reason: string, fromDialog: boolean) {
    if (busy) return;
    setBusy(deal.id); setDialogError(""); setError(""); setSuccess("");
    const r = await post(`/api/sales/opportunities/${deal.id}/transition`, { toStageId, ...(reason ? { reason } : {}) });
    setBusy(null);
    if (!r.ok && r.payload.code === "SAMPLE_SKIP_REASON_REQUIRED") {
      // Passing the samples with none: the documented skip, asked for now (§2.4).
      setMoveFor(null); setDialogError(""); setSkipFor(deal); return;
    }
    if (!r.ok) {
      const msg = localizeApiError(r.payload) ?? (ar ? "تعذّر النقل." : "Could not move the deal.");
      if (fromDialog) setDialogError(msg); else setError(msg);
      return;
    }
    setMoveFor(null);
    if (r.status === 202 || r.payload.pending) {
      setSuccess(ar ? `أُرسل طلب نقل «${deal.title}» إلى ${stageName(toStageId)}؛ تبقى الصفقة مكانها حتى يعتمده المشرف.` : `Move request sent for “${deal.title}”; it stays put until a supervisor approves.`);
    } else {
      setSuccess(ar ? `نُقلت «${deal.title}» إلى ${stageName(toStageId)}.` : `Moved “${deal.title}” to ${stageName(toStageId)}.`);
      setArrived(deal.id); window.setTimeout(() => setArrived(null), 1200);
    }
    reload();
  }

  async function skip(deal: Deal, code: string, text: string) {
    setBusy(deal.id); setDialogError("");
    const r = await post(`/api/sales/opportunities/${deal.id}/transition`, { skipSamples: true, skipReasonCode: code, ...(text ? { skipReason: text } : {}) });
    setBusy(null);
    if (!r.ok) { setDialogError(localizeApiError(r.payload) ?? (ar ? "تعذّر التخطّي." : "Could not skip.")); return; }
    setSkipFor(null);
    setSuccess(ar ? "تُخطّيت العيّنات ونُقلت الصفقة إلى عرض السعر والتفاوض." : "Samples skipped; moved to the quotation stage.");
    reload();
  }

  const customerName = (d: Deal) => d.customer ? (ar ? (d.customer.nameAr ?? d.customer.name) : d.customer.name) : null;
  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of deals) if (d.owner) m.set(d.owner.id, d.owner.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "ar"));
  }, [deals]);

  const now = new Date();
  const scoped = deals.filter((d) => {
    if (owner !== "all") return d.owner?.id === owner;
    if (onlyMine && me) return d.owner?.id === me;
    return true;
  });
  const s = q.trim().toLowerCase();
  const matches = (d: Deal) => !s || [d.title, d.customer?.name ?? "", d.customer?.nameAr ?? "", d.latestQuote?.quoteNumber ?? ""].some((x) => x.toLowerCase().includes(s));
  const openScoped = scoped.filter((d) => d.outcome === "OPEN");
  const sinceMs = (d: Deal) => new Date(d.stageSince ?? d.createdAt ?? now).getTime();
  const board = openScoped
    .filter(matches)
    .filter((d) => !needsMe || d.needsMe)
    .sort((a, b) => sort === "value" ? Number(b.amount) - Number(a.amount)
      : sort === "close" ? (a.expectedCloseAt ? new Date(a.expectedCloseAt).getTime() : Infinity) - (b.expectedCloseAt ? new Date(b.expectedCloseAt).getTime() : Infinity)
        : sinceMs(a) - sinceMs(b));
  const closed = scoped.filter((d) => d.outcome !== "OPEN").filter(matches)
    .sort((a, b) => (b.closedAt ? new Date(b.closedAt).getTime() : 0) - (a.closedAt ? new Date(a.closedAt).getTime() : 0));
  // The collapsed «مغلقة» summarises the current month (1764:535).
  const thisMonth = closed.filter((d) => d.closedAt && new Date(d.closedAt).getMonth() === now.getMonth() && new Date(d.closedAt).getFullYear() === now.getFullYear());
  const wonM = thisMonth.filter((d) => d.outcome === "WON"), lostM = thisMonth.filter((d) => d.outcome === "LOST");
  const wonNoOrder = closed.filter((d) => d.outcome === "WON" && d.acceptedQuote && !(d._count.orderLinks ?? 0));
  const needCount = openScoped.filter((d) => d.needsMe).length;
  const total = openScoped.reduce((x, d) => x + Number(d.amount), 0);
  const sum = (rows: Deal[]) => rows.reduce((x, d) => x + Number(d.amount), 0);
  const cur = currencyLabel("SAR", lang);
  const money = (v: number) => ar ? <><span className="n">{whole(v)}</span> {cur}</> : <>{cur} <span className="n">{whole(v)}</span></>;
  const monthLabel = `${ar ? AR_MONTHS[now.getMonth()] : EN_MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  const filtered = !!s || needsMe;
  const canDrag = !phone && !!can.move;
  const dealsCount = (n: number) => (ar ? (n === 0 ? "لا صفقات" : n === 1 ? "صفقة واحدة" : n === 2 ? "صفقتان" : n <= 10 ? `${n} صفقات` : `${n} صفقة`) : `${n} deal${n === 1 ? "" : "s"}`);

  // «التالي: …» / «متأخرة يوم · …» — the server's next step, with the follow-up's lateness.
  const nextLine = (d: Deal) => {
    const ns = d.nextStep;
    const act = ns?.nextAction;
    if (d.pendingMove) return { text: ar ? "طلب نقل بانتظار اعتماد المشرف" : "Move request awaiting a supervisor", tone: "" };
    const due = d.nextFollowUpAt ?? d.nextActivity?.dueAt ?? null;
    const label = act ? (ar ? act.ar : act.en) : ns?.requiredNow ? (ar ? ns.requiredNow.ar : ns.requiredNow.en) : null;
    if (act?.disabled) return { text: ar ? `${act.ar} · لا شيء مطلوب منك` : `${act.en} · nothing for you now`, tone: "" };
    if (!label) return { text: ar ? "لا شيء مطلوب منك الآن" : "Nothing for you now", tone: "" };
    if (due) {
      const n = daysFromToday(due);
      if (n < 0) return { text: `${ar ? `متأخرة ${dayCount(-n, lang)}` : `${dayCount(-n, lang)} late`} · ${label}`, tone: "late" };
      if (n === 0) return { text: `${ar ? "اليوم" : "Today"} · ${label}`, tone: "today" };
    }
    return { text: `${ar ? "التالي: " : "Next: "}${label}`, tone: "" };
  };
  const sinceText = (d: Deal) => {
    const n = Math.max(0, -daysFromToday(d.stageSince ?? d.createdAt ?? now));
    if (n === 0) return ar ? "اليوم" : "today";
    return ar ? `${dayCount(n, lang)} في المرحلة` : `${dayCount(n, lang)} in stage`;
  };

  const card = (d: Deal, mobile = false) => {
    const { top, sub } = splitTitle(d.title, customerName(d));
    const chip = d.nextStep ? cardChip(d.nextStep, ar) : null;
    const nx = nextLine(d);
    const draggable = canDrag && !d.pendingMove && !busy;
    return (
      <article key={d.id} className={`pv2-card${dragId === d.id ? " dragging" : ""}${arrived === d.id ? " arrived" : ""}`}
        data-testid={mobile ? `m-deal-${d.id}` : `deal-${d.id}`} draggable={draggable || undefined}
        onDragStart={draggable ? (e) => { setDragId(d.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", d.id); } : undefined}
        onDragEnd={draggable ? () => { setDragId(null); setDropOn(null); } : undefined}>
        <div className="r1">
          <Link href={`/dashboard/sales/deals/${d.id}`} className="who" data-testid={mobile ? `m-open-deal-${d.id}` : `open-deal-${d.id}`}>{top}</Link>
          <span className="amt">{money(Number(d.amount))}</span>
        </div>
        {sub ? <div className="sub">{sub}</div> : null}
        <div className="r3">
          {d.pendingMove
            ? <Chip tone="warn" label={ar ? `طلب نقل إلى ${stageName(d.pendingMove.toStageId)}` : `Move to ${stageName(d.pendingMove.toStageId)} requested`} testId={`pending-move-${d.id}`} />
            : chip ? <Chip tone={chip.tone} label={chip.label} title={chip.label} testId={`chip-${d.id}`} /> : null}
          <span className="since">{sinceText(d)}</span>
        </div>
        <hr />
        <div className="r4">
          <span className={`nx${nx.tone ? ` ${nx.tone}` : ""}`} data-testid={`next-${d.id}`}>{nx.text}</span>
          {nx.tone ? <span className={`cue ${nx.tone}`} aria-hidden /> : null}
          {canDrag && !d.pendingMove && (
            <button type="button" className="mv" data-testid={`move-${d.id}`} onClick={() => { setDialogError(""); setMoveFor({ deal: d }); }}
              aria-label={ar ? `نقل «${top}» إلى…` : `Move “${top}” to…`}>{ar ? "نقل إلى…" : "Move to…"}</button>
          )}
          {d.owner && <span className="av" title={d.owner.name} aria-label={d.owner.name}>{initials(d.owner.name)}</span>}
        </div>
      </article>
    );
  };

  const notice = (error || success) ? (
    <p className={`notice ${error ? "er" : "ok"}`} role={error ? "alert" : "status"} style={{ marginBottom: 16 }}
      data-testid={error ? "alert-error" : "alert-success"}>
      {error || success}
      <button type="button" onClick={() => { setError(""); setSuccess(""); }} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
    </p>
  ) : null;
  const failed = (
    <div className="notice er" role="alert" data-testid="pipeline-load-error">
      <span><b>{ar ? "تعذّر تحميل الصفقات." : "Could not load the deals."}</b> {ar ? "لم نعرض أرقامًا حتى لا تكون خاطئة. تحقّق من الاتصال وأعد المحاولة." : "No figures are shown so none is wrong. Check the connection and try again."}</span>
      <button type="button" className="btn sm" onClick={() => { setLoading(true); reload(); }}>{ar ? "إعادة المحاولة" : "Try again"}</button>
    </div>
  );
  const noStages = (
    <p className="lbl" style={{ fontWeight: 400, padding: "32px 0", textAlign: "center" }}>
      {ar ? "لم يتم إعداد مراحل المسار بعد." : "No pipeline stages are configured yet."}
    </p>
  );
  const emptyCol = (st: Stage) => filtered
    ? <div className="pv2-empty" data-testid={`empty-${st.code}`}>{ar ? "لا نتائج تطابق البحث." : "Nothing matches."} <button type="button" className="pv2-lk" style={{ margin: 0 }} onClick={() => { setQ(""); setNeedsMe(false); }}>{ar ? "مسح البحث" : "Clear search"}</button></div>
    : <div className="pv2-empty" data-testid={`empty-${st.code}`}>{ar ? (EMPTY_BY_PURPOSE[st.purpose ?? ""]?.ar ?? "لا صفقات.") : (EMPTY_BY_PURPOSE[st.purpose ?? ""]?.en ?? "No deals.")}</div>;
  const quoteStage = stages.find((x) => x.purpose === "QUOTATION");
  const dialogs = (
    <>
      {moveFor && (
        <MoveSheet ar={ar} busy={!!busy} dealName={moveFor.deal.title} stages={stages} currentStageId={moveFor.deal.stageId} initialTo={moveFor.to}
          direct={!!can.moveDirectly} error={dialogError} onClose={() => setMoveFor(null)}
          onSubmit={(to, reason) => move(moveFor.deal, to, reason, true)} />
      )}
      {skipFor && (
        <SkipSamplesSheet ar={ar} busy={!!busy} dealName={skipFor.title} error={dialogError}
          targetName={quoteStage ? stageName(quoteStage.id) : (ar ? "عرض السعر والتفاوض" : "Quotation")}
          onClose={() => setSkipFor(null)} onSubmit={(code, text) => skip(skipFor, code, text)} />
      )}
      {toast && <AutoToast ar={ar} title={toast.title} why={toast.why} href={`/dashboard/sales/deals/${toast.id}`} onDone={() => setToast(null)} />}
    </>
  );

  if (loading) {
    // Skeleton cards inside the three columns (annotation 5).
    return (
      <div className="pg">
        <div className="pv2-board" aria-busy="true" aria-label={ar ? "جارٍ التحميل" : "Loading"} style={{ gridTemplateColumns: phone ? "minmax(0,1fr)" : undefined }}>
          {(phone ? [0] : [0, 1, 2]).map((i) => (
            <div key={i} className="pv2-col">
              {[0, 1].map((j) => (
                <div key={j} className="pv2-card"><div className="pv2-skel" style={{ width: 120 }} /><div className="pv2-skel" style={{ width: 70 }} /><div className="pv2-skel" style={{ width: 130 }} /></div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const scopeSeg = teamView && (
    <div className="seg" role="group" aria-label={ar ? "نطاق الصفقات" : "Scope"} data-testid="pipeline-scope-toggle">
      <button type="button" className={onlyMine && owner === "all" ? "on" : undefined} aria-pressed={onlyMine && owner === "all"} data-testid="pipeline-mine"
        onClick={() => { setMine(true); setOwner("all"); }}>{ar ? "صفقاتي" : "Mine"} <span className="n">{deals.filter((d) => d.outcome === "OPEN" && d.owner?.id === me).length}</span></button>
      <button type="button" className={!onlyMine || owner !== "all" ? "on" : undefined} aria-pressed={!onlyMine || owner !== "all"} data-testid="pipeline-team"
        onClick={() => { setMine(false); setOwner("all"); }}>{ar ? "الفريق" : "Team"} <span className="n">{deals.filter((d) => d.outcome === "OPEN").length}</span></button>
    </div>
  );

  // ── Phone (1765:517): stage tabs, the stage's count and total, a list of the same cards ──
  if (phone) {
    const current = seg ?? stages[0]?.id ?? null;
    const st = stages.find((x) => x.id === current);
    const rows = current === "closed" ? closed : board.filter((d) => d.stageId === current);
    // The phone tabs' short names (1765:517): «مؤهلة · العيّنات · عرض السعر · مغلقة».
    const SHORT: Record<string, { ar: string; en: string }> = { QUALIFICATION: { ar: "مؤهلة", en: "Qualified" }, SAMPLE_EVALUATION: { ar: "العيّنات", en: "Samples" }, QUOTATION: { ar: "عرض السعر", en: "Quotation" } };
    const short = (x: Stage) => (x.purpose && SHORT[x.purpose] ? (ar ? SHORT[x.purpose].ar : SHORT[x.purpose].en) : (ar ? x.nameAr : x.nameEn));
    return (
      <div className="pg">
        {notice}
        <div className="pv2-head" style={{ marginBottom: 12 }}>
          <div>
            <h1 style={{ fontSize: 24, lineHeight: "30px" }}>{ar ? "مسار الصفقات" : "Deal pipeline"}</h1>
            {data && !loadFailed && <div className="meta" data-testid="pipeline-scope">{onlyMine ? (ar ? "صفقاتي" : "Mine") : (ar ? "الفريق" : "Team")} · {openDealsText(openScoped.length, ar)}</div>}
          </div>
        </div>
        {loadFailed ? failed : stages.length === 0 ? noStages : (
          <>
            <div className="pv2-mtabs" role="tablist" aria-label={ar ? "المراحل" : "Stages"} data-testid="pipeline-segs">
              {stages.map((x) => (
                <button key={x.id} type="button" role="tab" aria-selected={x.id === current} data-testid={`seg-${x.code}`} onClick={() => setSeg(x.id)}>
                  {short(x)} <span className="n">{board.filter((d) => d.stageId === x.id).length}</span>
                </button>
              ))}
              <button type="button" role="tab" aria-selected={current === "closed"} data-testid="seg-closed" onClick={() => setSeg("closed")}>{ar ? "مغلقة" : "Closed"}</button>
            </div>
            {st && (
              <div className="pv2-mhead">
                <b>{ar ? st.nameAr : st.nameEn}</b>
                <span><span className="n">{rows.length}</span> · {money(sum(rows))}</span>
              </div>
            )}
            <div role="tabpanel" className="pv2-mlist" data-testid={current === "closed" ? "m-closed" : `m-stage-${st?.code}`}>
              {rows.length === 0 && (st ? emptyCol(st) : <div className="pv2-empty">{ar ? "لا صفقات مغلقة." : "No closed deals."}</div>)}
              {current === "closed"
                ? rows.map((d) => {
                  const { top } = splitTitle(d.title, customerName(d));
                  const won = d.outcome === "WON";
                  return (
                    <article key={d.id} className="pv2-card" data-testid={`m-deal-${d.id}`}>
                      <div className="r1"><Link href={`/dashboard/sales/deals/${d.id}`} className="who" data-testid={`m-open-deal-${d.id}`}>{top}</Link><span className="amt">{money(Number(d.amount))}</span></div>
                      <div className="r3">
                        <Chip tone={won ? "ok" : "neutral"} label={won ? (ar ? "رابحة" : "Won") : (ar ? "خاسرة" : "Lost")} />
                        <span className="since">{!won && d.lostReason ? <><bdi>{d.lostReason}</bdi> · </> : null}{d.closedAt ? shortDate(d.closedAt, lang) : ""}</span>
                      </div>
                      {!won && can.reopen && (
                        <div className="r4" style={{ position: "relative", zIndex: 1 }}>
                          <button type="button" className="btn sm g" disabled={busy === d.id} onClick={() => reopen(d)} data-testid={`reopen-${d.id}`}>{ar ? "إعادة فتح" : "Reopen"}</button>
                        </div>
                      )}
                    </article>
                  );
                })
                : rows.map((d) => card(d, true))}
            </div>
          </>
        )}
        {dialogs}
      </div>
    );
  }

  // ── Desktop (1764:15) ──
  return (
    <div className="pg">
      {notice}
      <div className="pv2-head">
        <div>
          <h1>{ar ? "مسار الصفقات" : "Deal pipeline"}</h1>
          {data && !loadFailed && (
            <div className="meta" data-testid="pipeline-scope">
              {openDealsText(openScoped.length, ar)} · {money(total)}
              {needCount > 0 && <> · <span data-testid="pipeline-needs-count">{ar ? `${needCount} تحتاج تصرّفك اليوم` : `${needCount} need you today`}</span></>}
            </div>
          )}
        </div>
        <div className="act">
          {can.createLead && (
            <Link className="btn p" href="/dashboard/sales/leads?new=1" data-testid="pipeline-new-lead">
              <Ico name="plus" small />{ar ? "صفقة جديدة" : "New deal"}
            </Link>
          )}
        </div>
      </div>

      <nav className="tabs" aria-label={ar ? "الصفقات" : "Deals"} data-testid="contextual-nav" style={{ marginBottom: 16 }}>
        <a className="on" aria-current="page" href="/dashboard/sales/pipeline" data-testid="ctx-sales.pipeline">{ar ? "مسار الصفقات" : "Deal pipeline"}</a>
        <Link href="/dashboard/sales/activities" data-testid="ctx-sales.pipeline.activities">
          {ar ? "الأنشطة والمتابعات" : "Activities & follow-ups"}
          {followUps !== null && <span className="c">{followUps}</span>}
        </Link>
      </nav>

      {loadFailed ? failed : stages.length === 0 ? noStages : (
        <>
          <div className="pv2-tool">
            {scopeSeg}
            {teamView && owner !== "all" && (
              <span className="chip" data-testid="pipeline-owner">
                {ar ? "المالك: " : "Owner: "}<b>{owners.find(([id]) => id === owner)?.[1] ?? "—"}</b>
                <button type="button" className="x" onClick={() => setOwner("all")} aria-label={ar ? "إزالة فلتر المالك" : "Clear owner"} data-testid="pipeline-owner-clear"><Ico name="close" small /></button>
              </span>
            )}
            <label className="search">
              <Ico name="search" small />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={ar ? "ابحث باسم العميل أو رقم العرض" : "Customer or quotation number"}
                aria-label={ar ? "بحث عن عميل أو صفقة أو عرض" : "Search customers, deals or quotations"} data-testid="pipeline-search" />
            </label>
            <button type="button" className="chip" aria-pressed={needsMe} data-testid="pipeline-needs-me"
              onClick={() => { const v = !needsMe; setNeedsMe(v); router.replace(v ? "/dashboard/sales/pipeline?needs=1" : "/dashboard/sales/pipeline"); }}>
              {ar ? "يحتاج تصرّفي" : "Needs me"}
              {needsMe && <Ico name="close" small />}
            </button>
            <span className="sp" />
            <label className="sort">
              {ar ? "ترتيب:" : "Order:"}
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} data-testid="pipeline-sort">
                <option value="waiting">{ar ? "الأطول انتظارًا" : "Longest waiting"}</option>
                <option value="value">{ar ? "القيمة الأعلى" : "Highest value"}</option>
                <option value="close">{ar ? "الإغلاق المتوقع" : "Expected close"}</option>
              </select>
              <Ico name="chevd" small />
            </label>
          </div>

          <div className="pv2-board-wrap">
            {/* Three v2 stages fill the width; a deployment with more active stages keeps every column readable
                (a minimum width) and scrolls sideways INSIDE the board, never the page (gate fix L3). */}
            <div className={`pv2-board${stages.length > 3 ? " many" : ""}`} style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(${stages.length > 3 ? 248 : 0}px, 1fr)) ${closedOpen ? "minmax(240px, 1fr)" : "196px"}` }}>
              {stages.map((st) => {
                const inStage = board.filter((d) => d.stageId === st.id);
                const dragged = dragId ? deals.find((d) => d.id === dragId) : null;
                const dropping = dropOn === st.id && !!dragged && dragged.stageId !== st.id;
                return (
                  <section key={st.id} className={`pv2-col${dropping ? " drop" : ""}`} aria-label={ar ? st.nameAr : st.nameEn} data-testid={`stage-${st.code}`}
                    onDragOver={canDrag ? (e) => { if (dragId) { e.preventDefault(); setDropOn(st.id); } } : undefined}
                    onDragLeave={canDrag ? () => setDropOn((v) => (v === st.id ? null : v)) : undefined}
                    onDrop={canDrag ? (e) => {
                      e.preventDefault();
                      const d = deals.find((x) => x.id === (dragId ?? e.dataTransfer.getData("text/plain")));
                      setDragId(null); setDropOn(null);
                      if (!d || d.stageId === st.id) return;
                      // A direct mover's drop moves; a rep's drop opens the request (a reason is asked for).
                      if (can.moveDirectly) move(d, st.id, "", false);
                      else { setDialogError(""); setMoveFor({ deal: d, to: st.id }); }
                    } : undefined}>
                    <div className="pv2-colh">
                      <b>{ar ? st.nameAr : st.nameEn}</b>
                      <span className="cnt">{inStage.length}</span>
                      <span className="tot">{money(sum(inStage))}</span>
                    </div>
                    {inStage.length === 0 ? emptyCol(st) : inStage.map((d) => card(d))}
                  </section>
                );
              })}

              {/* «مغلقة» — collapsed by default (1764:535); opened it lists the closed deals. */}
              <section className="pv2-closed" aria-label={ar ? "مغلقة" : "Closed"} data-testid="stage-closed">
                <div className="h">
                  <b>{ar ? "مغلقة" : "Closed"}</b>
                  <button type="button" aria-expanded={closedOpen} data-testid="closed-toggle" onClick={() => setClosedOpen((v) => !v)}
                    aria-label={closedOpen ? (ar ? "طيّ المغلقة" : "Collapse closed") : (ar ? "عرض المغلقة" : "Show closed")}>
                    <span style={{ display: "inline-flex", transform: closedOpen ? "rotate(90deg)" : ar ? "rotate(180deg)" : undefined }}><Ico name="chev" small /></span>
                  </button>
                </div>
                <div className="mo">{monthLabel}</div>
                <hr />
                <div className="o won"><span className="l">{ar ? "رابحة" : "Won"}</span><span className="v" data-testid="closed-won">{dealsCount(wonM.length)} · {money(sum(wonM))}</span></div>
                <div className="o"><span className="l">{ar ? "خاسرة" : "Lost"}</span><span className="v" data-testid="closed-lost">{dealsCount(lostM.length)} · {money(sum(lostM))}</span></div>
                {(wonNoOrder.length > 0 || !closedOpen) && <hr />}
                {wonNoOrder.length > 0 && <div className="wait">{ar ? `رابحة بانتظار إنشاء الطلب: ${wonNoOrder.length}` : `Won, order not yet created: ${wonNoOrder.length}`}</div>}
                {!closedOpen && <button type="button" className="lk" onClick={() => setClosedOpen(true)} data-testid="closed-show">{ar ? "عرض المغلقة" : "Show closed"}</button>}
                {closedOpen && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-testid="closed-list">
                    {closed.length === 0 && <div className="pv2-empty">{ar ? "لا صفقات مغلقة." : "No closed deals."}</div>}
                    {closed.map((d) => {
                      const { top } = splitTitle(d.title, customerName(d));
                      const won = d.outcome === "WON";
                      const acc = d.acceptedQuote;
                      return (
                        <div key={d.id} data-testid={`deal-${d.id}`} style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8, borderBottom: "1px solid var(--border-subtle)" }}>
                          <div className="row">
                            <Link href={`/dashboard/sales/deals/${d.id}`} data-testid={`open-deal-${d.id}`}>{top}</Link>
                            <span className="n">{whole(d.amount)}</span>
                          </div>
                          <div className="row">
                            <Chip tone={won ? "ok" : "neutral"} label={won ? (ar ? "رابحة" : "Won") : (ar ? "خاسرة" : "Lost")} />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                              {!won && d.lostReason ? <bdi>{d.lostReason}</bdi> : d.closedAt ? shortDate(d.closedAt, lang) : ""}
                            </span>
                          </div>
                          {won && acc && can.createOrder && !(d._count.orderLinks ?? 0) && (
                            <Link className="btn sm" style={{ alignSelf: "flex-start" }} href={`/dashboard/sales/quotes/${acc.id}`} data-testid={`create-order-${d.id}`}>{ar ? "إنشاء الطلب" : "Create order"}</Link>
                          )}
                          {!won && can.reopen && (
                            <button type="button" className="btn sm g" style={{ alignSelf: "flex-start" }} disabled={busy === d.id} onClick={() => reopen(d)} data-testid={`reopen-${d.id}`}>{ar ? "إعادة فتح" : "Reopen"}</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          </div>
        </>
      )}
      {dialogs}
    </div>
  );
}
