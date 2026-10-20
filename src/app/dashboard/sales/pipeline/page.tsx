"use client";

import { localizeApiError } from "@/lib/i18n/api-errors";
import { Select } from "@/components/ui/Select";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLang, pick, Spinner, QUOTE_STATUS_SPECS } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import { ACTIVITY_LABELS, initials, splitTitle, openDealsText } from "@/components/d21/labels";
import { currencyLabel, dayCount, daysFromToday, dueText, shortDate, whole } from "@/components/d21/format";

/**
 * Pipeline, built to its frames: `crm-pipeline` 1440 (`174:701`), 1024 (`175:876`) and 390
 * (`173:722`). Header with the open total and its weighted value, the tabs, the tool row,
 * one column per active stage, and the deals closed each month below the board.
 *
 * A card opens its deal; moving it, winning or losing it is done on the deal page (stage
 * tracker, «تعليم رابحة», «تعليم خاسرة»), which is where the frame puts those actions. The
 * search, owner, close-date and order controls work on the deals already loaded — the board
 * reads every deal in scope at once, so nothing is filtered on the server.
 */

type Stage = { id: string; code: string; nameEn: string; nameAr: string; position: number; probability: number };
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
  customer: { id: string; name: string; nameAr: string | null } | null;
  owner: { id: string; name: string } | null;
  _count: { quotes: number; samples: number; activities: number; orderLinks?: number };
  latestQuote?: Quote | null;
  acceptedQuote?: Quote | null;
  nextActivity?: { type: string; subject: string; dueAt: string | null } | null;
};
type Payload = {
  stages: Stage[];
  deals: Deal[];
  scope: "own" | "all";
  can: { close: boolean; reopen: boolean; createOrder?: boolean; createLead?: boolean };
};

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function PipelinePage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();
  useD21Phone({ title: ar ? "الصفقات" : "Deals" });

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  // A failed load is not "no stages configured" — that message would send a rep to settings
  // to fix something that is not broken.
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [followUps, setFollowUps] = useState<number | null>(null);

  const [q, setQ] = useState("");
  const params = useSearchParams();
  // «لوحة الأداء» opens the board on one rep's deals (`?owner=<employee id>`); the owner
  // control still offers everyone, and an id with no deal here simply shows none.
  const [owner, setOwner] = useState(params.get("owner") || "all");
  // D6.2 (owner, 15 Oct): «الكل» is the default; the choice lives in the URL (`?close=quarter`)
  // as the leads page keeps its `?new=1`, so a reload or a shared link keeps it.
  const router = useRouter();
  const closeParam = params.get("close");
  const [closing, setClosingState] = useState<"all" | "quarter">(closeParam === "quarter" ? "quarter" : "all");
  const setClosing = (v: "all" | "quarter") => {
    setClosingState(v);
    router.replace(v === "quarter" ? "/dashboard/sales/pipeline?close=quarter" : "/dashboard/sales/pipeline");
  };
  const [sort, setSort] = useState<"value" | "close">("value");
  const [seg, setSeg] = useState<string | null>(null);
  // The frame's «لوحة | جدول» segment (QA P2-3): the same deals as a table, same filters and order.
  const [view, setView] = useState<"board" | "table">("board");

  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

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

  async function reopen(deal: Deal) {
    if (busy) return;
    setBusy(deal.id);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(`/api/sales/opportunities/${deal.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toOutcome: "OPEN" }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) { setError(localizeApiError(payload) ?? (ar ? "تعذّر التنفيذ." : "Could not do that.")); return; }
      setSuccess(ar ? "أُعيد فتح الصفقة." : "Deal reopened.");
      reload();
    } finally {
      setBusy(null);
    }
  }

  const deals = useMemo(() => data?.deals ?? [], [data]);
  const stages = data?.stages ?? [];
  const can = data?.can ?? { close: false, reopen: false };
  const customerName = (d: Deal) => d.customer ? (ar ? (d.customer.nameAr ?? d.customer.name) : d.customer.name) : null;

  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of deals) if (d.owner) m.set(d.owner.id, d.owner.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "ar"));
  }, [deals]);

  // Search and owner apply to the board and the closed list; the close-date filter to the board.
  const matches = (d: Deal) => {
    if (owner !== "all" && d.owner?.id !== owner) return false;
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return [d.title, d.customer?.name ?? "", d.customer?.nameAr ?? ""].some((x) => x.toLowerCase().includes(s));
  };
  const inQuarter = (v: string | null) => {
    if (!v) return false;
    const d = new Date(v), now = new Date();
    return d.getFullYear() === now.getFullYear() && Math.floor(d.getMonth() / 3) === Math.floor(now.getMonth() / 3);
  };
  const allOpen = deals.filter((d) => d.outcome === "OPEN");
  const board = allOpen
    .filter(matches)
    .filter((d) => closing === "all" || inQuarter(d.expectedCloseAt))
    .sort((a, b) => sort === "value"
      ? Number(b.amount) - Number(a.amount)
      : (a.expectedCloseAt ? new Date(a.expectedCloseAt).getTime() : Infinity) - (b.expectedCloseAt ? new Date(b.expectedCloseAt).getTime() : Infinity));
  const closed = deals.filter((d) => d.outcome !== "OPEN").filter(matches)
    .sort((a, b) => (b.closedAt ? new Date(b.closedAt).getTime() : 0) - (a.closedAt ? new Date(a.closedAt).getTime() : 0));
  // «أُغلقت في أكتوبر»: one block per month, newest first, so no closed deal drops off the screen.
  const closedByMonth = useMemo(() => {
    const out: { key: string; label: string; rows: Deal[] }[] = [];
    for (const d of closed) {
      const at = d.closedAt ? new Date(d.closedAt) : null;
      const key = at ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}` : "none";
      let g = out.find((x) => x.key === key);
      if (!g) {
        const sameYear = at && at.getFullYear() === new Date().getFullYear();
        const month = at ? (ar ? AR_MONTHS[at.getMonth()] : EN_MONTHS[at.getMonth()]) + (sameYear ? "" : ` ${at.getFullYear()}`) : "";
        g = { key, label: at ? (ar ? `أُغلقت في ${month}` : `Closed in ${month}`) : (ar ? "أُغلقت" : "Closed"), rows: [] };
        out.push(g);
      }
      g.rows.push(d);
    }
    return out;
  }, [closed, ar]);

  const total = allOpen.reduce((s, d) => s + Number(d.amount), 0);
  const weighted = allOpen.reduce((s, d) => s + Number(d.amount) * (d.probability ?? 0) / 100, 0);
  const cur = currencyLabel("SAR", lang);

  // The next step on a card: its type and when — «مكالمة · 4 أكتوبر», «زيارة · اليوم 16:00».
  const nextLine = (d: Deal) => {
    const a = d.nextActivity;
    if (!a) return null;
    const type = pick(ACTIVITY_LABELS, a.type, lang);
    if (!a.dueAt) return { text: type, late: 0 };
    const n = daysFromToday(a.dueAt);
    const when = Math.abs(n) <= 1 ? dueText(a.dueAt, lang) : shortDate(a.dueAt, lang);
    const late = new Date(a.dueAt) < new Date() ? Math.max(1, -n) : 0;
    return { text: `${type} · ${when}`, late };
  };
  const quoteSuffix = (qt: Quote) =>
    qt.status === "DRAFT" ? ` · ${pick(QUOTE_STATUS_SPECS, "DRAFT", lang)}`
      : qt.revision > 1 ? ` · ${ar ? "المراجعة" : "revision"} ${qt.revision}` : "";
  const lateFlag = (n: number) => <span className="flag">{ar ? `متأخرة ${dayCount(n, lang)}` : `${dayCount(n, lang)} overdue`}</span>;
  // Money reads «422,900 ر.س» in Arabic and "SAR 422,900" in English (the code goes first).
  const money = (v: number) => ar
    ? <><span className="n">{whole(v)}</span> {cur}</>
    : <>{cur} <span className="n">{whole(v)}</span></>;

  const notice = (error || success) ? (
    <p className={`notice ${error ? "er" : "ok"}`} role={error ? "alert" : "status"} style={{ marginBottom: 16 }}
      data-testid={error ? "alert-error" : "alert-success"}>
      {error || success}
      <button type="button" onClick={() => { setError(""); setSuccess(""); }} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
    </p>
  ) : null;

  const failed = (
    <div className="notice er" role="alert" data-testid="pipeline-load-error">
      <span>{ar ? "تعذّر تحميل مسار الصفقات. لم تتغير أي بيانات." : "Could not load the pipeline. Nothing was changed."}</span>
      <button type="button" className="btn sm" onClick={() => { setLoading(true); reload(); }}>
        {ar ? "إعادة المحاولة" : "Try again"}
      </button>
    </div>
  );
  const noStages = (
    <p className="lbl" style={{ fontWeight: 400, padding: "32px 0", textAlign: "center" }}>
      {ar ? "لم يتم إعداد مراحل المسار بعد." : "No pipeline stages are configured yet."}
    </p>
  );

  if (loading) return <div className="pg"><Spinner /></div>;

  // ── Phone (`173:722`): stage segments, the stage's total, one row per deal ──
  if (phone) {
    const current = seg ?? stages[0]?.id ?? null;
    const st = stages.find((s) => s.id === current);
    const rows = current === "closed" ? closed : board.filter((d) => d.stageId === current);
    return (
      <div className="pg">
        {notice}
        {loadFailed ? failed : stages.length === 0 ? noStages : (
          <>
            <div className="segs" role="tablist" aria-label={ar ? "المراحل" : "Stages"} data-testid="pipeline-segs">
              {stages.map((s) => (
                <button key={s.id} type="button" role="tab" aria-selected={s.id === current}
                  className={s.id === current ? "on" : undefined} data-testid={`seg-${s.code}`} onClick={() => setSeg(s.id)}>
                  {ar ? s.nameAr : s.nameEn} <span className="n">{board.filter((d) => d.stageId === s.id).length}</span>
                </button>
              ))}
              <button type="button" role="tab" aria-selected={current === "closed"} className={current === "closed" ? "on" : undefined}
                data-testid="seg-closed" onClick={() => setSeg("closed")}>
                {ar ? "أُغلقت" : "Closed"}
              </button>
            </div>
            {st && (
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "2px 0 4px" }}>
                {money(rows.reduce((s, d) => s + Number(d.amount), 0))} · {ar ? "احتمال المرحلة " : "stage probability "}<span className="n">{st.probability}%</span>
              </div>
            )}
            <div role="tabpanel" data-testid={current === "closed" ? "m-closed" : `m-stage-${st?.code}`}>
              {rows.length === 0 && (
                <p className="lbl" style={{ fontWeight: 400, padding: "16px 0" }}>{ar ? "لا صفقات." : "No deals."}</p>
              )}
              {rows.map((d) => {
                const { top, sub } = splitTitle(d.title, customerName(d));
                const nx = d.outcome === "OPEN" ? nextLine(d) : null;
                const won = d.outcome === "WON";
                return (
                  <div key={d.id} className="mrow rowlink" data-testid={`m-deal-${d.id}`}>
                    <div style={{ minWidth: 0 }}>
                      <Link href={`/dashboard/sales/deals/${d.id}`} className="who open" data-testid={`m-open-deal-${d.id}`}>{top}</Link>
                    </div>
                    <span className="n" style={{ fontWeight: 500 }}>{whole(d.amount)}</span>
                    <div className="r2">
                      {d.outcome === "OPEN" ? (
                        <>
                          <span style={{ flex: 1, minWidth: 0 }}>{[sub, nx?.text].filter(Boolean).join(" · ")}</span>
                          {nx?.late ? lateFlag(nx.late) : null}
                        </>
                      ) : (
                        <>
                          <span className={`st${won ? " ok" : ""}`} style={{ fontSize: 12.5 }}>{won ? (ar ? "رابحة" : "Won") : (ar ? "خاسرة" : "Lost")}</span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            {!won && d.lostReason ? <><bdi>{d.lostReason}</bdi> · </> : null}{d.closedAt ? shortDate(d.closedAt, lang) : ""}
                          </span>
                          {!won && can.reopen && (
                            <button type="button" className="btn sm g" disabled={busy === d.id} onClick={() => reopen(d)}>
                              {ar ? "إعادة فتح" : "Reopen"}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Desktop and compact (`174:701`, `175:876`) ──
  return (
    <div className="pg">
      {notice}
      <div className="ph" style={{ marginBottom: 20 }}>
        <div>
          <h1>{ar ? "مسار الصفقات" : "Deal pipeline"}</h1>
          {data && (
            <div className="meta" data-testid="pipeline-scope">
              <span>{openDealsText(allOpen.length, ar)}</span>
              <i /><span>{money(total)}</span>
              <i /><span>{ar ? "مرجّحة بالاحتمال " : "Weighted by probability "}{money(weighted)}</span>
            </div>
          )}
        </div>
        <div className="act">
          <div className="seg" role="group" aria-label={ar ? "طريقة العرض" : "View"}>
            <button type="button" className={view === "board" ? "on" : undefined} aria-pressed={view === "board"}
              onClick={() => setView("board")} data-testid="pipeline-view-board">{ar ? "لوحة" : "Board"}</button>
            <button type="button" className={view === "table" ? "on" : undefined} aria-pressed={view === "table"}
              onClick={() => setView("table")} data-testid="pipeline-view-table">{ar ? "جدول" : "Table"}</button>
          </div>
          {can.createLead && (
            <Link className="btn" href="/dashboard/sales/leads?new=1" data-testid="pipeline-new-lead">
              <Ico name="plus" small />{ar ? "عميل محتمل" : "New lead"}
            </Link>
          )}
        </div>
      </div>

      <nav className="tabs" aria-label={ar ? "الصفقات" : "Deals"} data-testid="contextual-nav">
        <a className="on" aria-current="page" href="/dashboard/sales/pipeline" data-testid="ctx-sales.pipeline">
          {ar ? "مسار الصفقات" : "Deal pipeline"}
        </a>
        <Link href="/dashboard/sales/activities" data-testid="ctx-sales.pipeline.activities">
          {ar ? "الأنشطة والمتابعات" : "Activities & follow-ups"}
          {followUps !== null && <span className="c">{followUps}</span>}
        </Link>
      </nav>

      {loadFailed ? failed : stages.length === 0 ? noStages : (
        <>
          <div className="tool" style={{ marginBottom: 16 }}>
            <label className="search">
              <Ico name="search" small />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={ar ? "العميل أو الصفقة" : "Customer or deal"}
                aria-label={ar ? "بحث عن عميل أو صفقة" : "Search customers or deals"} data-testid="pipeline-search" />
            </label>
            {data?.scope === "all" && (
              <span className="chip">
                <label htmlFor="pl-owner">{ar ? "المالك:" : "Owner:"}</label>
                <Select id="pl-owner" value={owner} onChange={(e) => setOwner(e.target.value)} data-testid="pipeline-owner">
                  <option value="all">{ar ? "الكل" : "All"}</option>
                  {owners.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </Select>
                <button type="button" className="x" onClick={() => setOwner("all")} aria-label={ar ? "إزالة فلتر المالك" : "Clear owner"} data-testid="pipeline-owner-clear">
                  <Ico name="close" small />
                </button>
              </span>
            )}
            <span className="chip">
              <label htmlFor="pl-close">{ar ? "الإغلاق المتوقع:" : "Expected close:"}</label>
              <Select id="pl-close" value={closing} onChange={(e) => setClosing(e.target.value as "all" | "quarter")} data-testid="pipeline-close">
                <option value="all">{ar ? "الكل" : "Any time"}</option>
                <option value="quarter">{ar ? "هذا الربع" : "This quarter"}</option>
              </Select>
              <button type="button" className="x" onClick={() => setClosing("all")} aria-label={ar ? "إزالة فلتر الإغلاق" : "Clear close date"} data-testid="pipeline-close-clear">
                <Ico name="close" small />
              </button>
            </span>
            <span className="sp" />
            <button type="button" className="btn g sm" data-testid="pipeline-sort"
              onClick={() => setSort((s) => (s === "value" ? "close" : "value"))}
              aria-label={ar ? `الترتيب: ${sort === "value" ? "القيمة تنازليًا" : "الإغلاق المتوقع"}` : `Order: ${sort === "value" ? "value, highest first" : "expected close"}`}>
              {sort === "value" ? (ar ? "القيمة ↓" : "Value ↓") : (ar ? "الإغلاق ↑" : "Close ↑")}
            </button>
          </div>

          {view === "table" ? (
            <table className="t" data-testid="pipeline-table">
              <thead><tr>
                <th scope="col">{ar ? "الصفقة" : "Deal"}</th>
                <th scope="col">{ar ? "المرحلة" : "Stage"}</th>
                <th scope="col" style={{ textAlign: "end" }}>{ar ? `القيمة · ${cur}` : `Value · ${cur}`}</th>
                <th scope="col">{ar ? "النشاط القادم" : "Next activity"}</th>
                <th scope="col">{ar ? "آخر عرض" : "Latest quote"}</th>
                <th scope="col">{ar ? "المالك" : "Owner"}</th>
              </tr></thead>
              <tbody>
                {board.map((d) => {
                  const { top, sub } = splitTitle(d.title, customerName(d));
                  const st = stages.find((x) => x.id === d.stageId);
                  const nx = nextLine(d);
                  return (
                    <tr key={d.id} data-testid={`deal-${d.id}`}>
                      <td>
                        <Link href={`/dashboard/sales/deals/${d.id}`} className="who" data-testid={`open-deal-${d.id}`}>{top}</Link>
                        {sub && <div className="sm">{sub}</div>}
                      </td>
                      <td>{st ? (ar ? st.nameAr : st.nameEn) : ""}</td>
                      <td style={{ textAlign: "end" }}><span className="n">{whole(d.amount)}</span></td>
                      <td>{nx ? <>{nx.text}{nx.late ? <> {lateFlag(nx.late)}</> : null}</> : <span className="sm">{ar ? "لا نشاط مفتوح" : "Nothing open"}</span>}</td>
                      <td>{d.latestQuote ? <><bdi className="id" dir="ltr">{d.latestQuote.quoteNumber}</bdi> <span className="sm">{quoteSuffix(d.latestQuote)}</span></> : "—"}</td>
                      <td>{d.owner?.name ?? (ar ? "غير مُسنَد" : "Unassigned")}</td>
                    </tr>
                  );
                })}
                {board.length === 0 && (
                  <tr><td colSpan={6} className="sm">{ar ? "لا صفقات مفتوحة تطابق الفلاتر." : "No open deals match the filters."}</td></tr>
                )}
              </tbody>
            </table>
          ) : (
          <div className="board-wrap">
            <div className="board" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(var(--col-min), 1fr))` }}>
              {stages.map((s) => {
                const inStage = board.filter((d) => d.stageId === s.id);
                return (
                  <section key={s.id} className="col" aria-label={ar ? s.nameAr : s.nameEn} data-testid={`stage-${s.code}`}>
                    <div className="colh">
                      <b>{ar ? s.nameAr : s.nameEn}</b>
                      <span className="n">{inStage.length}</span>
                      <span className="tot">{money(inStage.reduce((x, d) => x + Number(d.amount), 0))} · <span className="n">{s.probability}%</span></span>
                    </div>
                    {inStage.map((d) => {
                      const { top, sub } = splitTitle(d.title, customerName(d));
                      const nx = nextLine(d);
                      return (
                        <article key={d.id} className="dcard" data-testid={`deal-${d.id}`}>
                          <div className="r1">
                            <Link href={`/dashboard/sales/deals/${d.id}`} className="who open" data-testid={`open-deal-${d.id}`}>{top}</Link>
                            <span className="n">{whole(d.amount)}</span>
                          </div>
                          {sub && <div className="sub">{sub}</div>}
                          {nx && (
                            <div className="nx">
                              {d.owner && <span className="av s" title={d.owner.name} aria-label={d.owner.name}>{initials(d.owner.name)}</span>}
                              <span>{nx.text}</span>
                              {nx.late ? lateFlag(nx.late) : null}
                            </div>
                          )}
                          {d.latestQuote && (
                            <div className="qt">
                              <Ico name="quote" small />
                              <bdi className="id" dir="ltr">{d.latestQuote.quoteNumber}</bdi>
                              <span>{quoteSuffix(d.latestQuote)}</span>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          </div>
          )}

          {closedByMonth.map((g) => (
            <section key={g.key} data-testid={`closed-${g.key}`}>
              <div className="bh" style={{ margin: "32px 0 10px" }}>
                <h2 className="bt">{g.label}</h2>
                <span className="sub">{ar ? "النتيجة منفصلة عن المرحلة" : "Outcome is separate from stage"}</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="t dense"><tbody>
                  {g.rows.map((d) => {
                    const { top, sub } = splitTitle(d.title, customerName(d));
                    const won = d.outcome === "WON";
                    const acc = d.acceptedQuote;
                    const date = d.closedAt ? shortDate(d.closedAt, lang) : "";
                    return (
                      <tr key={d.id} data-testid={`deal-${d.id}`}>
                        <td style={{ width: 96 }}><span className={`st${won ? " ok" : ""}`}>{won ? (ar ? "رابحة" : "Won") : (ar ? "خاسرة" : "Lost")}</span></td>
                        <td>
                          <Link href={`/dashboard/sales/deals/${d.id}`} className="who" style={{ textDecoration: "none" }} data-testid={`open-deal-${d.id}`}>{top}</Link>
                          {sub && <span className="sm"> · {sub}</span>}
                        </td>
                        <td className="num">{whole(d.amount)}</td>
                        <td className="sm">
                          {won
                            ? (acc ? <>{ar ? "قُبل العرض " : "Accepted "}<bdi className="id" dir="ltr">{acc.quoteNumber}</bdi>{date && ` · ${date}`}</> : date)
                            : <>{d.lostReason ? <>{ar ? "السبب: " : "Reason: "}<bdi>{d.lostReason}</bdi>{date && " · "}</> : null}{date}</>}
                        </td>
                        <td style={{ textAlign: "end" }}>
                          {won && acc && can.createOrder && !(d._count.orderLinks ?? 0) && (
                            // The order is made on the quotation, which confirms what it will contain.
                            <Link className="btn sm" href={`/dashboard/sales/quotes/${acc.id}`} data-testid={`create-order-${d.id}`}>
                              {ar ? "إنشاء طلب" : "Create order"}
                            </Link>
                          )}
                          {!won && can.reopen && (
                            <button type="button" className="btn sm g" disabled={busy === d.id} onClick={() => reopen(d)}
                              data-testid={`reopen-${d.id}`}>
                              {ar ? "إعادة فتح" : "Reopen"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody></table>
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
