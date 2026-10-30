"use client";

import { useEffect, useId, useRef, useState } from "react";
import { pick, api, useModalFocus, Alert, Field, Select, TextInput } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { usePhone } from "@/components/shell/page-context";
import { ACTIVITY_LABELS, OUTCOME_LABELS } from "@/components/d21/labels";
import { dayCount, daysFromToday } from "@/components/d21/format";
import { ACTIVITY_OUTCOMES, qualifies } from "@/lib/services/sales/qualification";
import { EMPTY_QUALIFICATION, QualificationFields, missingText, qualificationPayload, type QualificationDraft } from "../_components/QualificationFields";
import type { Target } from "@/lib/services/sales/activity-targets";

/**
 * «+ تسجيل نشاط» on the follow-ups page (D6.3, `1532:2`): choose the record, then the fields
 * of the existing log-activity form.
 *
 * Step 1 (A–C, E, F): a search box with focus on open, the scope control (All / Leads /
 * Deals), and with an empty search the two default groups — «متأخرة أو مستحقة اليوم» (the
 * first four, then «عرض الكل») and «سجّلتَ عليها مؤخرًا». Both come from the read-only
 * `/api/sales/activities/targets`, which only returns records the caller may log on.
 *
 * Step 2 (D, `1548:2386`): the selected record with «تغيير», and the same fields and the same
 * POST as the deal page's dialog, drawn with the D21 field primitives (label 13/500 on a 19px
 * line, 36px control, radius 9). The type is not asked again. Nothing is written before «حفظ».
 *
 * Keyboard: Tab moves search → scope → list; ←/→ inside the scope control (a radiogroup with
 * roving tabindex); ↑↓ and ↵ in the list, with `aria-activedescendant`. «عرض الكل» is a button
 * between the two default lists, never an option. Esc on step 2 goes back to step 1 and keeps
 * the search and the selection; a second Esc closes. Focus returns to the opener on close
 * (`useModalFocus`).
 *
 * On a phone (`1549:1260`) it is a bottom sheet with one full-width «حفظ»; the close button
 * is the cancel.
 */

type Scope = "all" | "leads" | "deals";
type Group = { key: string; label: string; count: number | null; rows: Target[] };
type Data =
  | { mode: "default"; due: { total: number; rows: Target[] }; recent: { rows: Target[] } }
  | { mode: "search"; leads: { total: number; rows: Target[] }; deals: { total: number; rows: Target[] } };

const SCOPES: { key: Scope; en: string; ar: string }[] = [
  { key: "all", en: "All", ar: "الكل" },
  { key: "leads", en: "Leads", ar: "عملاء محتملون" },
  { key: "deals", en: "Deals", ar: "صفقات" },
];
const FIRST = 4;

/** The record's name as the row shows it: «محمصة النخبة — خلطة خاصة», or the lead's company. */
export function targetName(t: Target, ar: boolean): string {
  if (t.kind === "lead") return ar ? (t.nameAr ?? t.name) : t.name;
  const c = t.customer ? (ar ? (t.customer.nameAr ?? t.customer.name) : t.customer.name) : null;
  if (!c || t.name === c || t.name.startsWith(c)) return t.name;
  return `${c} — ${t.name}`;
}

/** «صفقة · عرض سعر · تأكيد الكميات بعد العيّنة», «عميل محتمل · متابعة بعد المعرض». */
function targetSub(t: Target, ar: boolean): string {
  const parts = [t.kind === "deal" ? (ar ? "صفقة" : "Deal") : (ar ? "عميل محتمل" : "Lead")];
  if (t.stage) parts.push(ar ? t.stage.nameAr : t.stage.nameEn);
  if (t.subject) parts.push(t.subject);
  return parts.join(" · ");
}

/** Overdue, stated in text: «متأخرة يومين», "1 day overdue", «متأخرة» for earlier today. */
function overdueFlag(t: Target, lang: "ar" | "en"): string | null {
  if (!t.dueAt || new Date(t.dueAt) >= new Date()) return null;
  const n = daysFromToday(t.dueAt);
  if (n === 0) return lang === "ar" ? "متأخرة" : "Overdue";
  return lang === "ar" ? `متأخرة ${n === -1 ? "يوم" : dayCount(-n, lang)}` : `${dayCount(-n, lang)} overdue`;
}

export function LogActivityPicker({
  lang, onClose, onDone, initial,
}: {
  lang: "ar" | "en";
  onClose: () => void;
  /** Called after a successful save with the record the activity was logged on. */
  onDone: (target: Target) => void;
  /** A record already chosen in context opens straight at step 2. */
  initial?: Target;
}) {
  const ar = lang === "ar";
  const phone = usePhone();
  const uid = useId();

  const [step, setStep] = useState<1 | 2>(initial ? 2 : 1);
  const [target, setTarget] = useState<Target | null>(initial ?? null);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  const search = useRef<HTMLInputElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);

  // Esc on step 2 is «back», on step 1 «close». The hook reads the latest handler.
  const box = useModalFocus(() => { if (step === 2) back(); else onClose(); });

  // The list follows the search and the scope, after a short pause so every keystroke is not
  // a request. A failed fetch shows F, never an empty list.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      params.set("scope", scope);
      const res = await api<Data>(`/api/sales/activities/targets?${params}`).catch(() => null);
      if (cancelled) return;
      if (res?.ok) { setData(res.data); setFailed(false); } else { setData(null); setFailed(true); }
      setLoading(false);
      setActive(0);
    }, q ? 180 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, scope, reloadToken]);

  // Focus follows the step: the first field on step 2, the search on the way back.
  useEffect(() => {
    if (step === 2) box.current?.querySelector<HTMLElement>("select, input")?.focus();
    else search.current?.focus();
  }, [step, box]);

  function back() { setStep(1); }
  function choose(t: Target) { setTarget(t); setStep(2); }

  // ── The groups, as displayed. In the default mode the two groups are two lists with the
  //    «عرض الكل» button between them; a search is one list of up to two groups. ──
  const dueGroup: Group | null = data?.mode === "default" && data.due.rows.length > 0 ? {
    key: "due", label: ar ? "متأخرة أو مستحقة اليوم" : "Overdue or due today", count: data.due.total,
    rows: showAll ? data.due.rows : data.due.rows.slice(0, FIRST),
  } : null;
  const showAllTotal = data?.mode === "default" && !showAll && data.due.rows.length > FIRST ? data.due.total : null;
  const recentGroup: Group | null = data?.mode === "default" && data.recent.rows.length > 0 ? {
    key: "recent", label: ar ? "سجّلتَ عليها مؤخرًا" : "Recently logged by you", count: null, rows: data.recent.rows,
  } : null;
  const searchGroups: Group[] = data?.mode === "search" ? [
    ...(data.leads.rows.length > 0 ? [{ key: "leads", label: ar ? "عملاء محتملون" : "Leads", count: data.leads.total, rows: data.leads.rows }] : []),
    ...(data.deals.rows.length > 0 ? [{ key: "deals", label: ar ? "صفقات" : "Deals", count: data.deals.total, rows: data.deals.rows }] : []),
  ] : [];
  const lists: Group[][] = data?.mode === "search" ? [searchGroups] : [dueGroup ? [dueGroup] : [], recentGroup ? [recentGroup] : []];
  const flat = lists.flat().flatMap((g) => g.rows);
  const sel = Math.min(active, Math.max(flat.length - 1, 0));
  const optionId = (i: number) => `${uid}-opt-${i}`;

  // Which of the (at most two) lists holds a row, so each listbox names only its own active row.
  const listOf = (i: number) => (lists[0]?.flatMap((g) => g.rows).length ?? 0) > i ? 0 : 1;
  function onListKey(e: React.KeyboardEvent) {
    let next: number | null = null;
    if (e.key === "ArrowDown") next = Math.min(sel + 1, flat.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(sel - 1, 0);
    else if (e.key === "Enter" && flat[sel]) { e.preventDefault(); choose(flat[sel]); return; }
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    // From a listbox, crossing into the other list moves focus with the active row; from the
    // search box focus stays where the person is typing.
    const el = e.currentTarget as HTMLElement;
    if (el.getAttribute("role") === "listbox" && listOf(next) !== listOf(sel)) {
      document.getElementById(`${uid}-list-${listOf(next)}`)?.focus();
    }
  }
  useEffect(() => {
    body.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // ←/→ move the scope selection; mirrored in RTL, so the arrow always points at the neighbour.
  function onScopeKey(e: React.KeyboardEvent) {
    const i = SCOPES.findIndex((s) => s.key === scope);
    const next = (ar ? e.key === "ArrowLeft" : e.key === "ArrowRight") ? i + 1
      : (ar ? e.key === "ArrowRight" : e.key === "ArrowLeft") ? i - 1
        : e.key === "Home" ? 0 : e.key === "End" ? SCOPES.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const s = SCOPES[(next + SCOPES.length) % SCOPES.length].key;
    setScope(s); setShowAll(false);
    (e.currentTarget.querySelector(`[data-scope="${s}"]`) as HTMLElement | null)?.focus();
  }

  const scopeLabel = ar ? SCOPES.find((s) => s.key === scope)!.ar : SCOPES.find((s) => s.key === scope)!.en;
  const noResults = !loading && !failed && q.trim() !== "" && flat.length === 0;
  const nothingDue = !loading && !failed && q.trim() === "" && flat.length === 0;

  const kbd = (k: string, label: string) => (
    <span className="hint"><span className="kbd">{k}</span> {label}</span>
  );
  const footNote = loading ? (ar ? "جارٍ تحميل السجلات…" : "Loading records…")
    : data?.mode === "search" && flat.length > 0 ? (ar ? "يتجاهل البحث التشكيل والهمزات والتاء المربوطة" : "Search ignores diacritics, hamza forms and taa marbuta")
      : (ar ? "تظهر السجلات التي تملك صلاحية الوصول إليها فقط" : "Only records you can access are shown");

  const renderList = (groups: Group[], id: string, index: number) => groups.length === 0 ? null : (
    <div id={id} role="listbox" tabIndex={0} aria-label={groups.map((g) => g.label).join(" · ")}
      aria-activedescendant={flat[sel] && listOf(sel) === index ? optionId(sel) : undefined} onKeyDown={onListKey}
      data-testid={`picker-list-${groups[0].key}`} aria-busy={loading || undefined} style={loading ? { opacity: .6 } : undefined}>
      {groups.map((g) => {
        const start = flat.indexOf(g.rows[0]);
        return (
          <div key={g.key} role="group" aria-labelledby={`${uid}-g-${g.key}`} data-testid={`picker-group-${g.key}`}>
            <div className="d63-grp" id={`${uid}-g-${g.key}`}>{g.label}{g.count !== null && <> · <span className="n">{g.count}</span></>}</div>
            {g.rows.map((t, j) => {
              const i = start + j;
              const flag = overdueFlag(t, lang);
              return (
                <div key={`${t.kind}:${t.id}`} id={optionId(i)} role="option" aria-selected={i === sel} data-idx={i}
                  className={`d63-row${i === sel ? " on" : ""}`} data-testid={`picker-row-${t.kind}-${t.id}`}
                  onMouseEnter={() => setActive(i)} onClick={() => choose(t)}>
                  <Ico name={t.kind === "deal" ? "deal" : "users"} />
                  <span className="t"><b><bdi>{targetName(t, ar)}</bdi></b><span className="s"><bdi>{targetSub(t, ar)}</bdi></span></span>
                  {flag && <span className="flag">{flag}</span>}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );

  // ── Step 1 ──
  const stepOne = (
    <>
      <div className="q">
        <Ico name="search" />
        <input ref={search} value={q} onChange={(e) => { setQ(e.target.value); setShowAll(false); }}
          placeholder={ar ? "ابحث باسم العميل المحتمل أو الصفقة" : "Search by lead or deal name"}
          aria-label={ar ? "ابحث باسم العميل المحتمل أو الصفقة" : "Search by lead or deal name"}
          data-testid="picker-search"
          role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={`${uid}-list-0`}
          aria-activedescendant={flat[sel] ? optionId(sel) : undefined}
          onKeyDown={onListKey} />
        {!phone && <span className="kbd">Esc</span>}
      </div>
      <div className="d63-scope">
        <div className="seg" role="radiogroup" aria-label={ar ? "النطاق" : "Scope"} onKeyDown={onScopeKey} data-testid="picker-scope">
          {SCOPES.map((s) => {
            const on = scope === s.key;
            return (
              <button key={s.key} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-scope={s.key}
                className={on ? "on" : undefined} data-testid={`picker-scope-${s.key}`}
                onClick={() => { setScope(s.key); setShowAll(false); }}>
                {ar ? s.ar : s.en}
              </button>
            );
          })}
        </div>
      </div>
      <div className="d63-body" ref={body}>
        {failed ? (
          <div className="d63-empty" role="alert" data-testid="picker-load-error">
            <b>{ar ? "تعذّر تحميل السجلات" : "Could not load records"}</b>
            <p>{ar ? "تحقق من الاتصال ثم أعد المحاولة. لم يُسجَّل أي نشاط." : "Check your connection and try again. Nothing was logged."}</p>
            <div className="d63-empty-acts">
              <button type="button" className="btn" onClick={() => setReloadToken((t) => t + 1)}>{ar ? "إعادة المحاولة" : "Try again"}</button>
            </div>
          </div>
        ) : loading && !data ? (
          <div aria-busy="true" data-testid="picker-loading">
            <div className="d63-grp">{ar ? "متأخرة أو مستحقة اليوم" : "Overdue or due today"}</div>
            {[62, 48, 70, 44].map((w, i) => (
              <div key={i} className="d63-row skel" aria-hidden="true">
                <span className="d63-skel ico" />
                <span className="t"><span className="d63-skel" style={{ width: `${w}%` }} /><span className="d63-skel s" style={{ width: `${w - 14}%` }} /></span>
              </div>
            ))}
          </div>
        ) : noResults ? (
          <div className="d63-empty" data-testid="picker-no-results">
            <Ico name="search" />
            <b>{ar ? `لا توجد ${scope === "all" ? "سجلات" : scopeLabel} تطابق «${q.trim()}»` : `No ${scope === "all" ? "records" : scopeLabel.toLowerCase()} match “${q.trim()}”`}</b>
            <p>{scope === "all"
              ? (ar ? "جرّب اسمًا أقصر أو كتابة مختلفة." : "Try a shorter name or a different spelling.")
              : (ar ? "جرّب اسمًا أقصر، أو وسّع النطاق إلى «الكل»." : "Try a shorter name, or widen the scope to “All”.")}</p>
            <div className="d63-empty-acts">
              {scope !== "all" && <button type="button" className="btn" onClick={() => setScope("all")} data-testid="picker-search-all">{ar ? "البحث في الكل" : "Search in All"}</button>}
              <button type="button" className="btn" onClick={() => { setQ(""); search.current?.focus(); }}>{ar ? "مسح البحث" : "Clear search"}</button>
            </div>
          </div>
        ) : nothingDue ? (
          <div className="d63-empty" data-testid="picker-nothing-due">
            <b>{ar ? "لا متابعات متأخرة أو مستحقة اليوم" : "Nothing overdue or due today"}</b>
            <p>{ar ? "ابحث باسم العميل المحتمل أو الصفقة لتسجيل نشاط عليه." : "Search by lead or deal name to log an activity on it."}</p>
          </div>
        ) : (
          <>
            {renderList(lists[0], `${uid}-list-0`, 0)}
            {showAllTotal !== null && (
              <button type="button" className="d63-more" onClick={() => setShowAll(true)} data-testid="picker-show-all">
                {ar ? "عرض الكل" : "Show all"} (<span className="n">{showAllTotal}</span>)
              </button>
            )}
            {lists[1] && renderList(lists[1], `${uid}-list-1`, 1)}
          </>
        )}
      </div>
      <div className="d63-ft">
        {!phone && <>{kbd("↑↓", ar ? "تنقّل" : "Navigate")}{kbd("↵", ar ? "اختيار" : "Select")}{kbd("Esc", ar ? "إغلاق" : "Close")}</>}
        <span className="note">{footNote}</span>
      </div>
    </>
  );

  return (
    <div className="d63-scrim" role="presentation" onClick={() => { if (step === 1) onClose(); }} data-testid="picker-scrim">
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`}
        className="d63" data-testid="activity-picker" data-step={step} onClick={(e) => e.stopPropagation()}>
        <div className="d63-hd">
          <div>
            <h2 id={`${uid}-title`}>{ar ? "تسجيل نشاط" : "Log an activity"}</h2>
            <div className="sub" data-testid="picker-step">
              {step === 1 ? (ar ? "الخطوة 1 من 2 · اختر السجل" : "Step 1 of 2 · Choose the record") : (ar ? "الخطوة 2 من 2 · تفاصيل النشاط" : "Step 2 of 2 · Activity details")}
            </div>
          </div>
          <button type="button" className="ib" onClick={onClose} aria-label={ar ? "إغلاق" : "Close"} data-testid="picker-close"><Ico name="close" small /></button>
        </div>
        {step === 1 ? stepOne : (
          <StepTwo ar={ar} lang={lang} target={target!} phone={phone} onChange={back} onCancel={onClose} onDone={onDone} />
        )}
      </div>
    </div>
  );
}

/** Step 2: the existing fields of the log-activity form, and the same POST as the deal page. */
function StepTwo({
  ar, lang, target, phone, onChange, onCancel, onDone,
}: {
  ar: boolean; lang: "ar" | "en"; target: Target; phone: boolean;
  onChange: () => void; onCancel: () => void; onDone: (t: Target) => void;
}) {
  const [type, setType] = useState("CALL");
  const [outcome, setOutcome] = useState("NOTE_ONLY");
  const [subject, setSubject] = useState(target.subject ?? "");
  const [body, setBody] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [completed, setCompleted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const isTask = type === "TASK";
  // A qualifying outcome on a lead converts it only with the qualification minimum known
  // (services/sales/needs.ts). The fields are offered with the outcome; if the server still reports
  // something missing, the same form asks for it and completes that activity (…/leads/[id]/qualify).
  const asksQualification = target.kind !== "deal" && !isTask && qualifies(outcome);
  const [qual, setQual] = useState<QualificationDraft>(EMPTY_QUALIFICATION);
  const [pending, setPending] = useState<{ activityId: string; missing: string[] } | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true); setErr("");
    if (pending) {
      const done = await api(`/api/sales/leads/${target.id}/qualify`, { method: "POST", body: { activityId: pending.activityId, qualification: qualificationPayload(qual) } }).catch(() => null);
      setBusy(false);
      if (done?.ok) { onDone(target); return; }
      setErr(done?.data?.error ?? (ar ? "تعذّر الحفظ. حاول مرة أخرى." : "Could not save. Try again."));
      return;
    }
    const res = await api<{ activity?: { id: string }; qualification?: { converted?: boolean; missing?: string[] } | null }>("/api/sales/activities", {
      method: "POST",
      body: {
        type, subject, body,
        ...(target.kind === "deal" ? { opportunityId: target.id } : { leadId: target.id }),
        outcome: isTask ? undefined : outcome,
        dueAt: dueAt || null,
        completed: isTask ? false : completed,
        ...(asksQualification && qualificationPayload(qual) ? { qualification: qualificationPayload(qual) } : {}),
      },
    }).catch(() => null);
    setBusy(false);
    const q = res?.ok ? res.data.qualification : null;
    if (res?.ok && q && q.converted === false && q.missing?.length && res.data.activity?.id) {
      setPending({ activityId: res.data.activity.id, missing: q.missing });
      return;
    }
    if (res?.ok) { onDone(target); return; }
    // The server's refusals are English strings; the dialog says what they mean in its own
    // language. 404 is «not yours (any more)» — the record was reassigned since the list loaded.
    if (res?.status === 404) setErr(ar ? "هذا السجل لم يعد متاحًا لك. لم يُسجَّل شيء." : "This record is no longer available to you. Nothing was logged.");
    else if (res?.status === 403) setErr(ar ? "ليست لديك صلاحية تسجيل نشاط. لم يُسجَّل شيء." : "You are not allowed to log an activity. Nothing was logged.");
    else setErr(ar ? "تعذّر الحفظ. لم يتغير شيء؛ حاول مرة أخرى." : (res?.data.error ?? "Could not save. Nothing changed; try again."));
  }
  const canSave = !busy && subject.trim().length >= 2 && (!isTask || !!dueAt);

  return (
    <>
      <div className="d63-body two" data-testid="picker-step-2">
        <div className="d63-card" data-testid="picker-selected">
          <Ico name={target.kind === "deal" ? "deal" : "users"} />
          <span className="t"><b><bdi>{targetName(target, ar)}</bdi></b><span className="s"><bdi>{targetSub(target, ar)}</bdi></span></span>
          <button type="button" className="lk-inline" onClick={onChange} data-testid="picker-change">{ar ? "تغيير" : "Change"}</button>
        </div>
        {err && <Alert kind="error">{err}</Alert>}
        <div className="d63-form">
          <div className="d63-grid2">
            <Field id="pk-type" label={ar ? "النوع" : "Type"}>
              <span className="d63-sel">
                <Select id="pk-type" value={type} onChange={setType}>
                  {Object.keys(ACTIVITY_LABELS).map((k) => <option key={k} value={k}>{pick(ACTIVITY_LABELS, k, lang)}</option>)}
                </Select>
                <Ico name="chevd" small />
              </span>
            </Field>
            {!isTask && (
              <Field id="pk-outcome" label={ar ? "ماذا حدث؟" : "What happened?"}>
                <span className="d63-sel">
                  <Select id="pk-outcome" value={outcome} onChange={setOutcome}>
                    {ACTIVITY_OUTCOMES.map((o) => <option key={o} value={o}>{pick(OUTCOME_LABELS, o, lang)}</option>)}
                  </Select>
                  <Ico name="chevd" small />
                </span>
              </Field>
            )}
          </div>
          {pending && <Alert kind="info">{ar ? "سُجّل النشاط. " : "Activity logged. "}{missingText(pending.missing, ar)}</Alert>}
          {(asksQualification || pending) && (
            <QualificationFields ar={ar} value={qual} onChange={setQual} missing={pending?.missing} idPrefix="pk-qual" />
          )}
          <Field id="pk-subject" label={ar ? "الموضوع" : "Subject"} required>
            <TextInput id="pk-subject" value={subject} onChange={setSubject} />
          </Field>
          <Field id="pk-body" label={ar ? "التفاصيل" : "Details"}>
            <TextInput id="pk-body" value={body} onChange={setBody} placeholder={ar ? "اختياري" : "Optional"} />
          </Field>
          <div className="d63-due">
            <Field id="pk-due" label={ar ? "تاريخ الاستحقاق" : "Due date"} required={isTask}
              hint={isTask ? (ar ? "المهمة بلا تاريخ لا تظهر في المتأخرات أبداً." : "A task with no due date never appears on an overdue list.") : undefined}>
              <span className="d63-date" data-empty={dueAt ? "false" : "true"}>
                <TextInput id="pk-due" type="date" value={dueAt} onChange={setDueAt} />
                <span className="ph" aria-hidden="true">{ar ? "اختياري" : "Optional"}</span>
                <Ico name="cal" small />
              </span>
            </Field>
            {!isTask && (
              <label className="d63-check">
                <input type="checkbox" checked={completed} onChange={(e) => setCompleted(e.target.checked)} data-testid="pk-completed" />
                <span className="box" aria-hidden="true"><Ico name="check" small /></span>
                {ar ? "حدث بالفعل" : "This already happened"}
              </label>
            )}
          </div>
          <p className="sm">{ar ? "هذا تسجيل لما حدث. لا يُرسل بريداً ولا رسالة." : "This records that contact happened. It does not send an email or a message."}</p>
        </div>
      </div>
      <div className="d63-acts">
        {!phone && <button type="button" className="btn" onClick={onCancel} data-testid="picker-cancel">{ar ? "إلغاء" : "Cancel"}</button>}
        <button type="button" className="btn p" disabled={!canSave} aria-busy={busy || undefined} onClick={save} data-testid="picker-save">
          {busy ? (ar ? "جارٍ الحفظ…" : "Saving…") : pending ? (ar ? "تحويل إلى فرصة" : "Make it an opportunity") : ar ? "حفظ" : "Save"}
        </button>
      </div>
    </>
  );
}
