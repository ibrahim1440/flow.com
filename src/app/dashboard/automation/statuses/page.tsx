"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Btn, Dot, Empty, Field, Notice, OpsBanner, OpsLoading, OpsRoot, useL } from "@/components/ops/ui";
import { Dialog, Flag } from "@/components/hr/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { api, useLang } from "../../sales/_components/ui";
import { useUser } from "../../user-context";
import { sampleContext } from "@/lib/automation/catalog";
import { renderTemplate } from "@/lib/automation/template";
import {
  defaultTemplateOf, getStatusSource, statusEnglishDefault, sourceEventDef, sourceVariables, STATUS_RECIPIENT_LABELS, STATUS_SOURCES,
  type StatusRecipient, type StatusSource,
} from "@/lib/automation/status-rules/sources";
import { AutomationHeader, Bubble, LoadError, Phone, whenParts, type Connection } from "../_components/shared";
import { SettingsFrame } from "../../_components/tools-ui";

/**
 * «إشعارات الحالات» — for every status in the system, whether a WhatsApp message is sent when a
 * record enters it, to whom, and what it says (owner request, Oct 2026).
 *
 * Addition beyond Figma: the GX E pages (1086:8) draw no status-sync screen. This page is drawn
 * in the language of E-P01 «القواعد» (1219:92499 / 1024 1219:93946 / 390 1228:123991): the same
 * header, tabs and connection strip, a rules table per status group whose rows read «الحالة ·
 * تُرسل إلى · آخر 30 يومًا · الحالة · إيقاف/تفعيل», the E-04 segmented filter, and the E-02
 * editor's recipient / variable / preview pieces in a dialog. New: the «تحديث الحالات» header
 * button, the «آخر تحديث للحالات» line, and the «جديدة» chip on a status a sync just found.
 *
 * Opening the page syncs (GET); the button syncs explicitly (POST …/sync) and says what changed.
 * Admin role only, as the API.
 */

type Rule = {
  id: string;
  source: string;
  statusKey: string;
  labelAr: string;
  labelEn: string;
  position: number;
  enabled: boolean;
  recipients: StatusRecipient[];
  template: string;
  /** Owner language decision 3: the English text employees who receive English get. */
  templateEn: string;
  renotify: boolean;
  active: boolean;
  canFire: boolean;
  isNew: boolean;
  inactiveSince: string | null;
  last30Days: Record<string, number>;
};

type Payload = { rules: Rule[]; lastSyncedAt: string | null; sync?: { added: number; firstSync?: boolean }; message?: string; messageEn?: string };

type Filter = "all" | "on" | "new" | "inactive";

function RefreshIco() {
  return (
    <svg className="ico s" viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 0 0-14.9-3.9L4 9" />
      <path d="M4 4v5h5" />
      <path d="M4 13a8 8 0 0 0 14.9 3.9L20 15" />
      <path d="M20 20v-5h-5" />
    </svg>
  );
}

export default function StatusNotificationsPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const L = useL();
  const user = useUser();
  const isAdmin = user?.role === "admin";

  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<Rule | null>(null);
  const [reload, setReload] = useState(0);
  // The sending mode, read once for the header strip and the dialog's «where it goes» line.
  const [conn, setConn] = useState<Connection | null>(null);

  useD21Phone({ title: ar ? "إشعارات الحالات" : "Status notifications", sub: ar ? "الأتمتة والواتساب" : "Automation & WhatsApp" });

  // Opening the page is a sync too (GET): say so when it found something.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      const r = await api<Payload>("/api/automation/status-rules");
      if (cancelled) return;
      if (!r.ok) return setError(r.data.error ?? (ar ? "تعذر تحميل الحالات." : "Could not load the statuses."));
      setData(r.data);
      if (r.data.sync && r.data.sync.added > 0 && !r.data.sync.firstSync) {
        setSuccess(ar ? `وُجدت ${r.data.sync.added} حالة جديدة منذ آخر زيارة، وأُضيفت متوقفة.` : `${r.data.sync.added} new status(es) found since the last visit, added switched off.`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, ar, reload]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api<Connection>("/api/automation/whatsapp").then((r) => {
      if (!cancelled && r.ok) setConn(r.data);
    });
    return () => { cancelled = true; };
  }, [isAdmin]);

  async function syncNow() {
    setSyncing(true);
    setError("");
    setSuccess("");
    const r = await api<Payload>("/api/automation/status-rules/sync", { method: "POST" });
    setSyncing(false);
    if (!r.ok) return setError(r.data.error ?? L("تعذر تحديث الحالات.", "Could not refresh the statuses."));
    setData(r.data);
    setSuccess((ar ? r.data.message : r.data.messageEn) ?? "");
  }

  async function quickToggle(rule: Rule) {
    // Switching on a status that has never been set up opens the editor with a suggestion.
    if (!rule.enabled && (rule.recipients.length === 0 || !rule.template)) return setEditing(rule);
    setError("");
    const r = await api<{ rule: Partial<Rule> }>(`/api/automation/status-rules/${rule.id}`, { method: "PUT", body: { enabled: !rule.enabled } });
    if (!r.ok) return setError(r.data.error ?? "");
    setData((d) => (d ? { ...d, rules: d.rules.map((x) => (x.id === rule.id ? { ...x, ...r.data.rule } : x)) } : d));
  }

  const rules = useMemo(() => data?.rules ?? [], [data]);
  const counts = useMemo(() => ({
    all: rules.length,
    on: rules.filter((r) => r.enabled && r.active).length,
    new: rules.filter((r) => r.isNew).length,
    inactive: rules.filter((r) => !r.active).length,
  }), [rules]);
  const shown = rules.filter((r) => (filter === "on" ? r.enabled && r.active : filter === "new" ? r.isNew : filter === "inactive" ? !r.active : true));
  const groups = STATUS_SOURCES.map((s) => ({ source: s, rows: shown.filter((r) => r.source === s.key) })).filter((g) => g.rows.length > 0);
  const [syncDate, syncTime] = whenParts(data?.lastSyncedAt ?? null);

  if (user && !isAdmin) {
    return (
      <OpsRoot className="tl-root">
        <SettingsFrame>
          <AutomationHeader lang={lang} />
          <Notice tone="info">{L("إشعارات الحالات يضبطها مدير النظام فقط.", "Status notifications are set up by an administrator only.")}</Notice>
        </SettingsFrame>
      </OpsRoot>
    );
  }

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <AutomationHeader
          lang={lang}
          conn={conn}
          actions={
            <Btn onClick={syncNow} busy={syncing} disabled={!data} data-testid="status-sync">
              <RefreshIco /> {L("تحديث الحالات", "Refresh statuses")}
            </Btn>
          }
        />

        {error && data && <OpsBanner tone="danger" onClose={() => setError("")}>{error}</OpsBanner>}
        {success && <OpsBanner tone="success" onClose={() => setSuccess("")}><span data-testid="status-sync-result">{success}</span></OpsBanner>}

        {!data && error ? (
          <LoadError lang={lang} title={L("تعذّر تحميل الحالات", "Could not load the statuses")} onRetry={() => { setError(""); setReload((n) => n + 1); }} />
        ) : !data && !error ? <OpsLoading /> : data ? (
          <>
            <div className="tl-tool">
              <div className="tl-seg" role="group" aria-label={L("عرض", "Show")} data-testid="status-filter">
                {([
                  ["all", L("الكل", "All")],
                  ["on", L("مفعّلة", "On")],
                  ["new", L("جديدة", "New")],
                  ["inactive", L("لم تعد مستخدمة", "No longer used")],
                ] as const).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} data-testid={`status-filter-${k}`}>
                    {label}
                    {counts[k] ? <span className="hr-count">{counts[k]}</span> : null}
                  </button>
                ))}
              </div>
              <span className="tl-sp" />
              <span className="hr-caption" data-testid="status-last-sync">
                {data.lastSyncedAt
                  ? L(`آخر تحديث للحالات: ${syncDate} ${syncTime}`, `Statuses last refreshed: ${syncDate} ${syncTime}`)
                  : L("لم تُحدَّث الحالات بعد", "Not refreshed yet")}
              </span>
            </div>

            {groups.length === 0 ? (
              <div className="tl-empty">
              <Empty
                title={filter === "new" ? L("لا توجد حالات جديدة", "No new statuses") : L("لا توجد حالات", "No statuses")}
                body={filter === "new" ? L("كل الحالات في النظام موجودة في القائمة. اضغط «تحديث الحالات» بعد إضافة حالة أو مرحلة.", "Every status in the system is listed. Press «Refresh statuses» after adding a status or a stage.") : undefined}
              />
              </div>
            ) : (
              groups.map(({ source, rows }) => (
                <section key={source.key} className="tl-sgroup" aria-label={ar ? source.ar : source.en} data-testid={`status-group-${source.key}`}>
                  <div className="tl-h">
                    <h2>{ar ? source.ar : source.en}</h2>
                    <span>{ar ? source.description.ar : source.description.en}</span>
                  </div>
                  <div className="hr-tablewrap">
                    <table className="hr-table is-mrow" aria-label={ar ? source.ar : source.en}>
                      <thead>
                        <tr>
                          {/* Fixed widths so the groups' tables line up column for column. */}
                          <th style={{ width: "27%" }}>{L("الحالة", "Status")}</th>
                          <th className="hr-hide-compact" style={{ width: "14%" }}>{L("تُرسل إلى", "Sends to")}</th>
                          <th className="hr-hide-compact" style={{ width: "20%" }}>{L("الرسالة", "Message")}</th>
                          <th style={{ width: "11%" }}>{L("آخر 30 يومًا", "Last 30 days")}</th>
                          <th style={{ width: "11%" }}>{L("الإرسال", "Sending")}</th>
                          <th style={{ width: "17%" }}><span className="hr-sr">{L("إجراء", "Action")}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <StatusRow key={r.id} rule={r} source={source} lang={lang} onEdit={() => setEditing(r)} onToggle={() => quickToggle(r)} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))
            )}

            <p className="tl-foot tl-hide-phone">{L("الحالات الجديدة تُضاف متوقفة · الحالة التي تُحذف أو تُخفى تبقى مع إعدادها وتُعلَّم «لم تعد مستخدمة»", "New statuses arrive switched off · a status that is removed or hidden keeps its settings, marked «no longer used»")}</p>
            <div className="tl-note tl-hide-phone">
              {L(
                "تُرسل الرسالة مرة واحدة لكل سجل وحالة ومستلم، وتمر بوضع الإرسال نفسه (متوقف / تجربة / فعلي) وتظهر في سجل الرسائل.",
                "A message is sent once per record, status and recipient, follows the same sending mode (off / test / live) and appears in the message log.",
              )}
            </div>
          </>
        ) : null}
      </SettingsFrame>

      {editing ? (
        <RuleDialog
          key={editing.id}
          rule={editing}
          lang={lang}
          conn={conn}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setSuccess(L("حُفظ إعداد الحالة.", "Status saved."));
            setData((d) => (d ? { ...d, rules: d.rules.map((x) => (x.id === saved.id ? { ...x, ...saved } : x)) } : d));
          }}
        />
      ) : null}
    </OpsRoot>
  );
}

function recipientsText(list: StatusRecipient[], ar: boolean) {
  return list.map((k) => (ar ? STATUS_RECIPIENT_LABELS[k]?.ar : STATUS_RECIPIENT_LABELS[k]?.en) ?? k).join(ar ? "، " : ", ");
}

function StatusRow({ rule: r, source, lang, onEdit, onToggle }: { rule: Rule; source: StatusSource; lang: "ar" | "en"; onEdit: () => void; onToggle: () => void }) {
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const label = ar ? r.labelAr : r.labelEn;
  const to = recipientsText(r.recipients, ar);
  const sent = r.last30Days.SENT ?? 0;
  const failed = r.last30Days.FAILED ?? 0;
  const skipped = r.last30Days.SKIPPED ?? 0;
  const on = r.enabled && r.active;
  const state = !r.active
    ? <Dot tone="neutral">{L("لم تعد مستخدمة", "No longer used")}</Dot>
    : !r.canFire
      ? <Dot tone="neutral">{L("لا يُرسل لها", "Not announced")}</Dot>
      : <Dot tone={on ? "success" : "neutral"}>{on ? L("مفعّلة", "On") : L("متوقفة", "Off")}</Dot>;
  const canToggle = r.active && r.canFire;
  return (
    <tr data-testid={`status-row-${r.source}-${r.statusKey}`} className={r.isNew ? "tl-hl" : undefined}>
      <td className="m-title">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="tl-body-btn" style={{ width: "auto", fontWeight: 600, color: "var(--text-primary)" }} onClick={onEdit}>{label}</button>
          {r.isNew ? <span data-testid="status-new-chip"><Flag tone="warning">{L("جديدة", "New")}</Flag></span> : null}
        </span>
        <span className="stk-sub hr-desktop-only">
          {source.userDefined ? L("مرحلة يحددها المستخدم", "User-defined stage") : <bdi dir="ltr">{r.statusKey}</bdi>}
          {!r.canFire ? L(" · لا يوجد حدث في النظام يُعلن هذه الحالة", " · no event in the system announces this status") : null}
        </span>
        <span className="hr-msub">{(ar ? source.ar : source.en)}{to ? ` · ${to}` : ""}</span>
      </td>
      <td className="hr-hide-compact">{to || <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
      <td className="hr-hide-compact" style={{ maxWidth: 280 }}>
        {r.template ? <span className="tl-clamp" style={{ fontSize: 13, color: "var(--text-secondary)" }} dir="auto">{r.template}</span> : <span style={{ color: "var(--text-muted)" }}>—</span>}
      </td>
      <td>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
          {ar ? `أرسلت ${sent}` : `${sent} sent`}
          {failed > 0 && <span style={{ color: "var(--status-danger)" }}>{ar ? ` · ${failed} فشلت` : ` · ${failed} failed`}</span>}
          {skipped > 0 && <span>{ar ? ` · لم ترسل ${skipped}` : ` · ${skipped} skipped`}</span>}
        </span>
      </td>
      <td className="m-end" data-testid={`status-state-${r.source}-${r.statusKey}`}>{state}</td>
      <td style={{ textAlign: "end", whiteSpace: "nowrap" }}>
        <span style={{ display: "inline-flex", gap: 6 }}>
          <Btn size="sm" variant="ghost" onClick={onEdit} data-testid={`status-edit-${r.source}-${r.statusKey}`}>{L("تعديل", "Edit")}</Btn>
          {canToggle ? (
            <Btn size="sm" onClick={onToggle} data-testid={`status-toggle-${r.source}-${r.statusKey}`} aria-label={`${on ? L("إيقاف", "Turn off") : L("تفعيل", "Turn on")} — ${label}`}>
              {on ? L("إيقاف", "Turn off") : L("تفعيل", "Turn on")}
            </Btn>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

/**
 * Where a message of this status goes right now, under the preview (feat/wa-status-rules): the
 * sending mode decides, not the rule — the owner keeps WhatsApp in test mode until he switches it.
 */
function ModeLine({ conn, lang }: { conn: Connection | null; lang: "ar" | "en" }) {
  const ar = lang === "ar";
  if (!conn) return null;
  const m = conn.effectiveMode;
  const noTestPhone = conn.sendMode === "TEST" && m === "OFF";
  const text = m === "TEST"
    ? <>{ar ? "وضع التجربة: تذهب الرسالة إلى رقم التجربة " : "Test mode: the message goes to the test number "}<Phone value={conn.testPhone} />{ar ? " فقط، لا إلى المستلم." : " only, not to the recipient."}</>
    : m === "LIVE"
      ? ar ? "إرسال فعلي: تذهب الرسالة إلى المستلمين المختارين." : "Live: the message goes to the chosen recipients."
      : noTestPhone
        ? ar ? "وضع التجربة بلا رقم تجربة: تُسجَّل الرسالة في السجل كما كانت ستُرسل، ولا تصل لأحد." : "Test mode without a test number: the message is logged as it would be sent, and reaches no one."
        : ar ? "الإرسال متوقف: تُسجَّل الرسالة في السجل كما كانت ستُرسل، ولا تصل لأحد." : "Sending is off: the message is logged as it would be sent, and reaches no one.";
  return <span className="hr-caption" data-testid="status-mode-line" data-mode={m}>{text}</span>;
}

function RuleDialog({ rule, lang, conn, onClose, onSaved }: { rule: Rule; lang: "ar" | "en"; conn: Connection | null; onClose: () => void; onSaved: (r: Partial<Rule> & { id: string }) => void }) {
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const source = getStatusSource(rule.source);
  const firstUse = rule.recipients.length === 0 && !rule.template;
  const [enabled, setEnabled] = useState(rule.enabled || (firstUse && rule.active && rule.canFire));
  const [recipients, setRecipients] = useState<StatusRecipient[]>(
    rule.recipients.length ? rule.recipients : source ? [source.recipients[0]] : [],
  );
  const [template, setTemplate] = useState(rule.template || (source ? defaultTemplateOf(source, rule.statusKey) : ""));
  // Prefilled with the built-in English while the Arabic is the untouched built-in text.
  const [templateEn, setTemplateEn] = useState(rule.templateEn || (source ? statusEnglishDefault(source, rule.statusKey, rule.template || defaultTemplateOf(source, rule.statusKey)) ?? "" : ""));
  const [focus, setFocus] = useState<"ar" | "en">("ar");
  const areaEn = useRef<HTMLTextAreaElement>(null);
  const [renotify, setRenotify] = useState(rule.renotify);
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  if (!source) return null;
  const def = sourceEventDef(source);
  const preview = renderTemplate(def, template, { ...sampleContext(def), "status.name": rule.labelAr }, "ar");
  const previewEn = renderTemplate(def, templateEn, { ...sampleContext(def), "status.name": rule.labelEn || rule.labelAr }, "en");
  const locked = !rule.active || !rule.canFire;

  function insert(key: string) {
    const en = focus === "en";
    const el = en ? areaEn.current : area.current;
    const text = en ? templateEn : template;
    const set = en ? setTemplateEn : setTemplate;
    const token = `{{${key}}}`;
    if (!el) return set((t) => t + token);
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + token + text.slice(end);
    set(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  async function save() {
    setBusy("save");
    setError("");
    const r = await api<{ rule: Partial<Rule> }>(`/api/automation/status-rules/${rule.id}`, { method: "PUT", body: { enabled: locked ? false : enabled, recipients, template, templateEn, renotify } });
    setBusy("");
    if (!r.ok) return setError(r.data.error ?? "");
    onSaved({ id: rule.id, ...r.data.rule });
  }

  async function test() {
    setBusy("test");
    setError("");
    setInfo("");
    const r = await api<{ phone?: string }>(`/api/automation/status-rules/${rule.id}/test`, { method: "POST", body: { template } });
    setBusy("");
    if (!r.ok) return setError(r.data.error ?? "");
    setInfo(L("أُرسلت تجربة إلى رقم التجربة.", "A test was sent to the test number."));
  }

  return (
    <Dialog
      open
      title={ar ? rule.labelAr : rule.labelEn}
      sub={ar ? source.ar : source.en}
      onClose={onClose}
      testId="status-dialog"
      actions={
        <>
          <Btn variant="ghost" onClick={test} busy={busy === "test"} disabled={!!busy || !template.trim()} data-testid="status-test">{L("إرسال تجربة", "Send a test")}</Btn>
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
          <Btn variant="primary" onClick={save} busy={busy === "save"} disabled={!!busy} data-testid="status-save">{L("حفظ", "Save")}</Btn>
        </>
      }
    >
      <div className="hr-stack" style={{ gap: 14 }}>
        {error && <Notice tone="danger">{error}</Notice>}
        {info && <Notice tone="success">{info}</Notice>}
        {!rule.active ? (
          <Notice tone="warning">{L("هذه الحالة لم تعد موجودة أو أُخفيت في النظام. يبقى إعدادها محفوظًا ولا يُرسل شيء حتى تعود.", "This status is gone or hidden. Its settings are kept and nothing is sent until it returns.")}</Notice>
        ) : !rule.canFire ? (
          <Notice tone="info">{L("لا يوجد حدث في النظام يُعلن دخول سجل إلى هذه الحالة، فلا يمكن الإرسال عندها.", "No event in the system announces a record entering this status, so nothing can be sent for it.")}</Notice>
        ) : null}

        <label className="tl-check">
          <input type="checkbox" checked={enabled && !locked} disabled={locked} onChange={(e) => setEnabled(e.target.checked)} data-testid="status-enabled" />
          {L("أرسل رسالة واتساب عندما يدخل سجل هذه الحالة", "Send a WhatsApp message when a record enters this status")}
        </label>

        <label className="tl-check" style={{ alignItems: "flex-start" }}>
          <input type="checkbox" checked={renotify} onChange={(e) => setRenotify(e.target.checked)} data-testid="status-renotify" style={{ marginTop: 3 }} />
          <span>
            {L("إعادة الإرسال عند العودة لنفس الحالة", "Send again when a record returns to this status")}
            <span className="hr-caption" style={{ display: "block" }}>
              {renotify
                ? L("كل دخول جديد للحالة يُرسل رسالة. لا تتكرر الرسالة لنفس الدخول.", "Every new entry sends a message; never twice for the same entry.")
                : L("رسالة واحدة فقط لكل سجل في هذه الحالة، حتى لو خرج منها وعاد.", "One message per record in this status, even if it leaves and returns.")}
            </span>
          </span>
        </label>

        <fieldset className="hr-stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
          <legend className="hr-label" style={{ marginBottom: 8 }}>{L("المستلمون", "Recipients")}</legend>
          <div className="tl-chips">
            {source.recipients.map((k) => (
              <label key={k} className="tl-check" style={{ marginInlineEnd: 12 }}>
                <input
                  type="checkbox"
                  checked={recipients.includes(k)}
                  onChange={(e) => setRecipients((list) => (e.target.checked ? [...list, k] : list.filter((x) => x !== k)))}
                  data-testid={`status-recipient-${k}`}
                />
                {ar ? STATUS_RECIPIENT_LABELS[k].ar : STATUS_RECIPIENT_LABELS[k].en}
              </label>
            ))}
          </div>
        </fieldset>

        <Field label={L("نص الرسالة (العربية)", "Message (Arabic)")} help={L("يصل العميلَ دائمًا، والموظفين الذين يستقبلون بالعربية. اضغط متغيرًا لإدراجه. «اسم الحالة» يُكتب بالعربية.", "Always sent to the customer, and to employees who receive Arabic. Click a variable to insert it.")}>
          <textarea ref={area} id="status-template" className="hr-input" rows={4} value={template} onChange={(e) => setTemplate(e.target.value)} onFocus={() => setFocus("ar")} dir="auto" data-testid="status-template" style={{ minHeight: 96, resize: "vertical" }} />
        </Field>
        <Field label={L("نص الرسالة (الإنجليزية)", "Message (English)")} help={L("للموظفين الذين يستقبلون بالإنجليزية («ملفي الشخصي» أو لغة رسائل الموظفين) · فارغ = النص العربي", "For employees who receive English («My profile» or the employee message language) · empty = the Arabic text")}>
          <textarea ref={areaEn} id="status-template-en" className="hr-input" rows={3} value={templateEn} onChange={(e) => setTemplateEn(e.target.value)} onFocus={() => setFocus("en")} dir="ltr" lang="en" data-testid="status-template-en" style={{ minHeight: 72, resize: "vertical" }} />
        </Field>
        <div className="tl-vars" aria-label={L("المتغيرات", "Variables")}>
          {sourceVariables(source).map((v) => (
            <button key={v.key} type="button" className="tl-var" onClick={() => insert(v.key)}>
              {ar ? v.ar : v.en} <code dir="ltr">{`{{${v.key}}}`}</code>
            </button>
          ))}
        </div>
        <div className="hr-stack" style={{ gap: 6 }}>
          <span className="hr-label">{L("معاينة بالبيانات التجريبية", "Preview with sample data")}</span>
          <Bubble text={preview} lang={lang} testId="status-preview" />
          {templateEn.trim() ? <Bubble text={previewEn} lang={lang} testId="status-preview-en" /> : null}
          <ModeLine conn={conn} lang={lang} />
        </div>
      </div>
    </Dialog>
  );
}
