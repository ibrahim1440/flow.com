"use client";

import { Select } from "@/components/ui/Select";
import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { LogActivityPicker, targetName } from "./LogActivityPicker";
import type { Target } from "@/lib/services/sales/activity-targets";
import { useLang, pick, Spinner, api } from "../_components/ui";
import { Ico, type D21IconName } from "@/components/shell/icons";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import { initials } from "@/components/d21/labels";
import { dayCount, daysFromToday, dueText, shortDate } from "@/components/d21/format";

/**
 * Follow-ups, built to `crm-followups` 1440 (`184:2050`), 1024 (`186:2232`) and 390 (`183:2040`):
 * the header with its three counts, the tabs it shares with the pipeline, the filter segment
 * (late and today · open · done) with the owner and type chips, the list grouped by how urgent
 * it is, and «آخر النشاط» — the latest completed activities — beside it, or under it at 1024.
 *
 * A row's action marks it done. The frame's «تسجيل النتيجة» would record the outcome too; the
 * system records outcomes only when an activity is logged, so the action says what it does.
 */

type Activity = {
  id: string;
  type: string;
  subject: string;
  body: string | null;
  dueAt: string | null;
  completedAt: string | null;
  outcome?: string | null;
  createdAt: string;
  owner: { id: string; name: string } | null;
  lead: { id: string; companyName: string; status: string } | null;
  opportunity: { id: string; title: string; outcome: string } | null;
  customer: { id: string; name: string } | null;
};

const TYPE_LABELS: Record<string, { en: string; ar: string }> = {
  CALL: { en: "Call", ar: "مكالمة" },
  VISIT: { en: "Visit", ar: "زيارة" },
  MEETING: { en: "Meeting", ar: "اجتماع" },
  NOTE: { en: "Note", ar: "ملاحظة" },
  TASK: { en: "Task", ar: "مهمة" },
  SAMPLE_FOLLOW_UP: { en: "Sample follow-up", ar: "متابعة عيّنة" },
  WHATSAPP: { en: "WhatsApp", ar: "واتساب" },
  EMAIL: { en: "Email", ar: "بريد" },
};
const TYPE_ICON: Record<string, D21IconName> = {
  CALL: "phone", VISIT: "users", MEETING: "cal", NOTE: "note", TASK: "check", SAMPLE_FOLLOW_UP: "flask", WHATSAPP: "phone", EMAIL: "note",
};
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

const FILTERS = [
  { key: "due", en: "Overdue & today", ar: "متأخرة واليوم" },
  { key: "open", en: "Open", ar: "المفتوحة" },
  { key: "done", en: "Completed", ar: "المكتملة" },
] as const;

/** The page size asked of the API (its default; capped there at 200). */
const PER_PAGE = 50;

export default function ActivitiesPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();
  const user = useUser();
  const canWrite = hasSubPrivilege(user?.permissions ?? {}, "sales", "lead_write");
  const router = useRouter();
  // «+ تسجيل نشاط» (D6.3). On the phone the header's «+» links to `?log=1`, as the leads page's
  // does; the parameter is read once and cleared so a second tap opens it again.
  const requestedLog = useSearchParams().get("log") === "1";
  const [picker, setPicker] = useState(false);
  // Derived during render, as the leads page does with `?new=1`: a new request opens it.
  const [prevRequested, setPrevRequested] = useState(false);
  if (requestedLog !== prevRequested) {
    setPrevRequested(requestedLog);
    if (requestedLog && canWrite) setPicker(true);
  }
  useEffect(() => { if (requestedLog) router.replace("/dashboard/sales/activities"); }, [requestedLog, router]);
  useD21Phone({
    title: ar ? "المتابعات" : "Follow-ups",
    action: canWrite ? { href: "/dashboard/sales/activities?log=1", label: ar ? "تسجيل نشاط" : "Log an activity", icon: "plus" } : undefined,
  });

  const [rows, setRows] = useState<Activity[]>([]);
  const [counts, setCounts] = useState({ overdue: 0, dueToday: 0, open: 0 });
  const [filter, setFilter] = useState<string>("due");
  const [type, setType] = useState("");
  const [scope, setScope] = useState<"own" | "all">("own");
  const [canSeeTeam, setCanSeeTeam] = useState(false);
  // A manager starts on the team, as the frame does («المالك: الكل»); a rep only has their own.
  const [teamView, setTeamView] = useState(true);
  const [loading, setLoading] = useState(true);
  /** The row being completed. One at a time, so a double tap cannot complete twice. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [page, setPage] = useState(1);
  const [shownPage, setShownPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [feed, setFeed] = useState<Activity[] | null>(null);

  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams({ filter });
      if (type) params.set("type", type);
      if (!teamView) params.set("scope", "mine");
      params.set("page", String(page));
      params.set("perPage", String(PER_PAGE));
      const res = await api<{
        rows: Activity[]; total: number;
        counts: { overdue: number; dueToday: number; open: number };
        scope: "own" | "all"; canSeeTeam: boolean;
      }>(`/api/sales/activities?${params}`).catch(() => null);
      if (cancelled) return;
      if (res?.ok) {
        setRows(res.data.rows);
        setShownPage(page);
        setTotal(typeof res.data.total === "number" ? res.data.total : res.data.rows.length);
        setCounts(res.data.counts);
        setScope(res.data.scope);
        setCanSeeTeam(res.data.canSeeTeam);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [filter, type, teamView, ar, reloadToken, page]);

  // «آخر النشاط»: the five most recently completed, in the same scope as the list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams({ filter: "done", sort: "recent", perPage: "5" });
      if (!teamView) params.set("scope", "mine");
      const res = await api<{ rows: Activity[] }>(`/api/sales/activities?${params}`).catch(() => null);
      if (!cancelled && res?.ok) setFeed(res.data.rows);
    })();
    return () => { cancelled = true; };
  }, [teamView, reloadToken]);

  // A new filter is a new list; page 3 of the old one may not exist in it.
  function changeFilter(next: () => void) { next(); setPage(1); }

  async function complete(a: Activity) {
    if (busyId) return;
    setBusyId(a.id);
    setError(""); setSuccess("");
    const res = await api(`/api/sales/activities/${a.id}`, { method: "PATCH", body: { completed: true } }).catch(() => null);
    setBusyId(null);
    if (res?.ok) {
      setSuccess(ar ? `اكتملت المتابعة «${a.subject}».` : `Marked “${a.subject}” done.`);
      if (rows.length === 1 && page > 1 && filter !== "done") setPage(page - 1);
      else reload();
    } else {
      setError(res?.data.error ?? (ar ? "تعذّر الحفظ. لم يتغير شيء؛ حاول مرة أخرى." : "Could not save. Nothing changed; try again."));
    }
  }

  if (loading) return <div className="pg"><Spinner /></div>;

  const pickerEl = picker ? (
    <LogActivityPicker lang={lang} onClose={() => setPicker(false)}
      onDone={(t: Target) => {
        setPicker(false);
        setError("");
        setSuccess(ar ? `سُجّل النشاط على «${targetName(t, true)}».` : `Activity logged on “${targetName(t, false)}”.`);
        reload();
      }} />
  ) : null;

  const team = scope === "all";
  const target = (a: Activity) => a.customer?.name ?? a.lead?.companyName ?? null;
  /** What a row is attached to: the deal if there is one, otherwise the lead. */
  const linked = (a: Activity, short = false) => {
    if (a.opportunity) {
      const c = a.customer?.name;
      const title = c && !a.opportunity.title.startsWith(c) ? `${c} — ${a.opportunity.title}` : a.opportunity.title;
      return { href: `/dashboard/sales/deals/${a.opportunity.id}`, text: short ? title : `${ar ? "صفقة · " : "Deal · "}${title}` };
    }
    if (a.lead) {
      return { href: `/dashboard/sales/leads/${a.lead.id}`, text: short ? a.lead.companyName : `${ar ? "عميل محتمل · " : "Lead · "}${a.lead.companyName}` };
    }
    return null;
  };
  // «الأحد 4 أكتوبر 12:00», «اليوم 13:00»; the frame's flag says how late.
  const due = (a: Activity) => {
    if (!a.dueAt) return { text: ar ? "بلا موعد" : "No due date", flag: null as string | null };
    const late = !a.completedAt && new Date(a.dueAt) < new Date();
    const n = daysFromToday(a.dueAt);
    const flag = !late ? null : n === 0 ? (ar ? "متأخرة" : "Overdue")
      : ar ? `متأخرة ${n === -1 ? "يوم" : dayCount(-n, lang)}` : `${dayCount(-n, lang)} overdue`;
    // The phone frame drops the weekday: «4 أكتوبر 12:00».
    const d = new Date(a.dueAt);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return { text: phone && Math.abs(n) > 1 ? `${shortDate(d, lang)} ${hm}` : dueText(a.dueAt, lang), flag };
  };
  // Groups, as the frame draws them: late, today, then the rest of the open list.
  const groupOf = (a: Activity) => {
    if (a.completedAt || !a.dueAt) return a.completedAt ? "done" : "later";
    const d = new Date(a.dueAt);
    if (d < new Date()) return "late";
    return daysFromToday(d) === 0 ? "today" : "later";
  };
  const GROUP_LABEL: Record<string, string> = {
    late: ar ? "متأخرة" : "Overdue", today: ar ? "اليوم" : "Today", later: ar ? "لاحقًا" : "Later", done: ar ? "المكتملة" : "Completed",
  };
  const groups: { key: string; rows: Activity[] }[] = [];
  for (const a of rows) {
    const k = filter === "done" ? "done" : groupOf(a);
    let g = groups.find((x) => x.key === k);
    if (!g) { g = { key: k, rows: [] }; groups.push(g); }
    g.rows.push(a);
  }

  const filterCount: Record<string, number | null> = { due: counts.overdue + counts.dueToday, open: counts.open, done: null };
  const from = total === 0 ? 0 : (shownPage - 1) * PER_PAGE + 1;
  const to = Math.min(total, (shownPage - 1) * PER_PAGE + rows.length);
  const paging = shownPage !== page;
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE));

  const notices = (
    <>
      {error && <p className="notice er" role="alert" data-testid="alert-error" style={{ marginBottom: 16 }}>{error}<button type="button" onClick={() => setError("")} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button></p>}
      {success && <p className="notice ok" role="status" data-testid="alert-success" style={{ marginBottom: 16 }}>{success}<button type="button" onClick={() => setSuccess("")} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button></p>}
    </>
  );
  const segment = (
    <div role="group" aria-label={ar ? "تصفية" : "Filter"} className={phone ? "segs" : "seg"}>
      {FILTERS.map((f) => {
        const on = filter === f.key;
        const c = filterCount[f.key];
        return (
          <button key={f.key} type="button" data-testid={`filter-${f.key}`} aria-pressed={on} className={on ? "on" : undefined}
            onClick={() => changeFilter(() => setFilter(f.key))}>
            {ar ? f.ar : f.en}
            {c !== null && <span className="n" style={phone ? undefined : { color: "var(--text-muted)" }}>{c}</span>}
          </button>
        );
      })}
    </div>
  );
  const empty = (
    <div data-testid="activities-empty" style={{ padding: "48px 0", textAlign: "center" }} className="lbl">
      {filter === "due" ? (ar ? "لا شيء متأخر ولا مستحق اليوم." : "Nothing overdue or due today.")
        : filter === "done" ? (ar ? "لم تكتمل أي متابعة بعد." : "Nothing completed yet.")
          : (ar ? "لا متابعات مفتوحة." : "No open follow-ups.")}
    </div>
  );
  const failed = (
    <div className="notice er" role="alert" data-testid="activities-load-error">
      <span>{ar ? "تعذّر تحميل المتابعات. لم تتغير أي بيانات." : "Could not load follow-ups. Nothing was changed."}</span>
      <button type="button" className="btn sm" onClick={reload}>{ar ? "إعادة المحاولة" : "Try again"}</button>
    </div>
  );
  const pager = lastPage > 1 ? (
    <nav aria-label={ar ? "صفحات المتابعات" : "Follow-up pages"} className="pager">
      <span className="sm" data-testid="activities-range" aria-live="polite">
        <bdi dir="ltr" className="n">{from}–{to}</bdi> {ar ? "من" : "of"} <bdi className="n">{total}</bdi>
      </span>
      <span className="sp" />
      <button type="button" className="btn sm" data-testid="activities-prev" disabled={page <= 1} onClick={() => setPage(page - 1)}>{ar ? "السابق" : "Previous"}</button>
      <button type="button" className="btn sm" data-testid="activities-next" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>{ar ? "التالي" : "Next"}</button>
    </nav>
  ) : (
    <span className="sr-only" data-testid="activities-range"><bdi dir="ltr">{from}–{to}</bdi> {ar ? "من" : "of"} {total}</span>
  );

  // ── Phone (`183:2040`) ──
  if (phone) {
    return (
      <div className="pg">
        {pickerEl}
        {notices}
        {segment}
        {loadFailed ? failed : rows.length === 0 ? empty : (
          <div aria-busy={paging || undefined} data-testid="activities-table">
            {groups.map((g) => (
              <section key={g.key}>
                <div className={`grp-l${g.key === "late" ? " er" : ""}`}>{GROUP_LABEL[g.key]}</div>
                {g.rows.map((a) => {
                  const l = linked(a, true);
                  const d = due(a);
                  return (
                    <div key={a.id} className="mrow rowlink" data-testid={`activity-row-${a.id}`}>
                      <div style={{ minWidth: 0, display: "flex", gap: 6, alignItems: "center" }}>
                        <Ico name={TYPE_ICON[a.type] ?? "note"} small aria-label={pick(TYPE_LABELS, a.type, lang)} />
                        {l ? <Link href={l.href} className="who open" style={{ fontWeight: 600 }}><bdi>{a.subject}</bdi></Link>
                          : <span className="who" style={{ fontWeight: 600 }}><bdi>{a.subject}</bdi></span>}
                      </div>
                      <span className="sm">{a.completedAt ? shortDate(a.completedAt, lang) : d.text}</span>
                      <div className="r2">
                        <span style={{ flex: 1, minWidth: 0 }}>{l?.text}</span>
                        {d.flag && <span className="flag" data-testid={`late-${a.id}`}>{d.flag}</span>}
                      </div>
                    </div>
                  );
                })}
              </section>
            ))}
            {pager}
          </div>
        )}
      </div>
    );
  }

  const feedBlock = (
    <section className="feed" aria-label={ar ? "آخر النشاط" : "Latest activity"} data-testid="activity-feed">
      <div className="bh" style={{ marginBottom: 12 }}>
        <h2 className="bt">{ar ? "آخر النشاط" : "Latest activity"}</h2>
        <span className="sub">{team ? (ar ? "الفريق" : "Team") : (ar ? "أنشطتي" : "Mine")}</span>
      </div>
      {feed === null ? null : feed.length === 0 ? (
        <p className="lbl" style={{ fontWeight: 400 }}>{ar ? "لا نشاط مكتمل بعد." : "Nothing completed yet."}</p>
      ) : (
        <ol className="tl" style={{ fontSize: 13 }}>
          {/* Timeline 184:2103: activity lines are 13/22 (184:2107, 184:2108); the owner name is Bold (184:2107). */}
          {feed.map((a, i) => {
            const t = target(a);
            return (
              <li key={a.id}>
                <span className={`m${i === 0 ? " b" : ""}`} />
                {a.owner && <b className="d21-bold">{a.owner.name}</b>}{a.owner && " · "}
                {pick(TYPE_LABELS, a.type, lang)}{t && <> {ar ? "مع" : "with"} <bdi>{t}</bdi></>}
                <div style={{ color: "var(--text-secondary)" }}>
                  {[a.outcome ? pick(OUTCOME_LABELS, a.outcome, lang) : null, a.subject].filter(Boolean).join(" · ")}
                </div>
                <div className="when">{a.completedAt ? dueText(a.completedAt, lang) : ""}</div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );

  return (
    <div className="pg">
      {pickerEl}
      {notices}
      <div className="ph" style={{ marginBottom: 20 }}>
        <div>
          <h1>{ar ? "الأنشطة والمتابعات" : "Activities & follow-ups"}</h1>
          <div className="meta">
            <span data-testid="count-overdue">
              <span className="n">{counts.overdue}</span> {ar ? "متأخرة" : "overdue"}
            </span>
            <i /><span data-testid="count-today"><span className="n">{counts.dueToday}</span> {ar ? "اليوم" : "today"}</span>
            <i /><span data-testid="count-open"><span className="n">{counts.open}</span> {ar ? "مفتوحة" : "open"}</span>
            <span data-testid="count-scope">{team ? (ar ? "للفريق" : "for the team") : (ar ? "لي" : "for me")}</span>
          </div>
        </div>
        {canWrite && (
          <div className="act">
            <button type="button" className="btn p" onClick={() => setPicker(true)} data-testid="log-activity" aria-haspopup="dialog">
              <Ico name="plus" small /> {ar ? "تسجيل نشاط" : "Log an activity"}
            </button>
          </div>
        )}
      </div>

      <nav className="tabs" aria-label={ar ? "الصفقات" : "Deals"} data-testid="contextual-nav">
        <Link href="/dashboard/sales/pipeline" data-testid="ctx-sales.pipeline">{ar ? "مسار الصفقات" : "Deal pipeline"}</Link>
        <a className="on" aria-current="page" href="/dashboard/sales/activities" data-testid="ctx-sales.pipeline.activities">
          {ar ? "الأنشطة والمتابعات" : "Activities & follow-ups"}<span className="c">{counts.open}</span>
        </a>
      </nav>

      <div className="act-cols">
        <div style={{ minWidth: 0 }}>
          <div className="tool" style={{ marginBottom: 12 }}>
            {segment}
            {canSeeTeam && (
              <span className="chip">
                <label htmlFor="act-owner">{ar ? "المالك:" : "Owner:"}</label>
                <Select id="act-owner" value={teamView ? "team" : "mine"} data-testid="activities-owner"
                  onChange={(e) => changeFilter(() => setTeamView(e.target.value === "team"))}>
                  <option value="team">{ar ? "الكل" : "All"}</option>
                  <option value="mine">{ar ? "أنا" : "Me"}</option>
                </Select>
                <button type="button" className="x" onClick={() => changeFilter(() => setTeamView(true))} aria-label={ar ? "إزالة فلتر المالك" : "Clear owner"} data-testid="activities-owner-clear">
                  <Ico name="close" small />
                </button>
              </span>
            )}
            <span className="chip">
              <label htmlFor="act-type">{ar ? "النوع:" : "Type:"}</label>
              <Select id="act-type" value={type} data-testid="activities-type" onChange={(e) => changeFilter(() => setType(e.target.value))}>
                <option value="">{ar ? "الكل" : "All"}</option>
                {Object.keys(TYPE_LABELS).map((k) => <option key={k} value={k}>{pick(TYPE_LABELS, k, lang)}</option>)}
              </Select>
              <button type="button" className="x" onClick={() => changeFilter(() => setType(""))} aria-label={ar ? "إزالة فلتر النوع" : "Clear type"} data-testid="activities-type-clear">
                <Ico name="close" small />
              </button>
            </span>
          </div>

          {loadFailed ? failed : rows.length === 0 ? empty : (
            <div aria-busy={paging || undefined} style={paging ? { opacity: .6 } : undefined} data-testid="activity-list">
              <table className="t" data-testid="activities-table">
                <thead><tr>
                  <th scope="col">{ar ? "النوع" : "Type"}</th>
                  <th scope="col">{ar ? "الموضوع والارتباط" : "Subject and link"}</th>
                  <th scope="col" aria-sort="ascending">{ar ? "الموعد" : "Due"}</th>
                  <th scope="col">{ar ? "المالك" : "Owner"}</th>
                  <th scope="col"><span className="sr-only">{ar ? "الإجراء" : "Action"}</span></th>
                </tr></thead>
                {groups.map((g) => (
                  <tbody key={g.key}>
                    {filter !== "done" && (
                      <tr className="grp"><td colSpan={5}><b className={g.key === "late" ? "er" : undefined}>{GROUP_LABEL[g.key]}</b> <span className="n">{g.rows.length}</span></td></tr>
                    )}
                    {g.rows.map((a) => {
                      const l = linked(a);
                      const d = due(a);
                      const mine = busyId === a.id;
                      return (
                        <tr key={a.id} data-testid={`activity-row-${a.id}`}>
                          <td style={{ color: "var(--text-secondary)" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                              <Ico name={TYPE_ICON[a.type] ?? "note"} small />{pick(TYPE_LABELS, a.type, lang)}
                            </span>
                          </td>
                          <td style={{ whiteSpace: "normal" }}>
                            <span className="who" style={{ display: "block", fontWeight: 600 }}><bdi>{a.subject}</bdi></span>
                            {l ? <Link href={l.href} className="sm" style={{ display: "block", textDecoration: "none" }}><bdi>{l.text}</bdi></Link> : <span className="sm">—</span>}
                          </td>
                          <td>
                            {a.completedAt ? (
                              <span className="sm">{ar ? "اكتمل " : "done "}{dueText(a.completedAt, lang)}</span>
                            ) : (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                <span style={{ fontSize: 13.5 }}>{d.text}</span>
                                {d.flag && <span className="flag" data-testid={`late-${a.id}`}>{d.flag}</span>}
                              </span>
                            )}
                          </td>
                          <td>{a.owner ? <span className="av s" title={a.owner.name} aria-label={a.owner.name}>{initials(a.owner.name)}</span> : <span className="sm">{ar ? "غير مُسنَد" : "Unassigned"}</span>}</td>
                          <td style={{ textAlign: "end" }}>
                            {a.completedAt ? <span className="sm">{ar ? "مكتمل" : "Completed"}</span> : (
                              <button type="button" className="btn sm" disabled={busyId !== null} aria-busy={mine || undefined}
                                onClick={() => complete(a)} data-testid={`complete-${a.id}`} aria-label={`${ar ? "إكمال" : "Complete"}: ${a.subject}`}>
                                {mine ? (ar ? "جارٍ الحفظ…" : "Saving…") : ar ? "إكمال" : "Complete"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
              {pager}
            </div>
          )}
          <p className="sm" style={{ marginTop: 12 }}>
            {ar ? "المواعيد بتوقيت الرياض. الإكمال يوقف عدّاد التأخر ويحفظ وقت الإنجاز."
              : "Times are Riyadh time. Completing stops the overdue counter and records when it was done."}
          </p>
        </div>
        {feedBlock}
      </div>
    </div>
  );
}
