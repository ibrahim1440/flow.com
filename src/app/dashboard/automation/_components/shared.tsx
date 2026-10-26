"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "../../user-context";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { Dot, PageHeader, type Tone } from "@/components/ops/ui";
import { api } from "../../sales/_components/ui";
import { LinkTabs } from "../../_components/tools-ui";

/**
 * Pieces the automation screens share, on the Direction 2.1 operations scope (UI batch 2; GX
 * E-P01…E-P04). The page header «الأتمتة والواتساب» with its three page tabs and the connection
 * strip are drawn here; every request stays where it was.
 */

export function useAutomationAbilities() {
  const user = useUser();
  const perms = user?.permissions ?? {};
  return {
    canView: hasModuleAccess(perms, "automation"),
    canManageRules: hasSubPrivilege(perms, "automation", "manage_rules"),
    canManageConnection: hasSubPrivilege(perms, "automation", "manage_connection"),
    canManageMessages: hasSubPrivilege(perms, "automation", "manage_messages"),
  };
}

export const MESSAGE_STATUS: Record<string, { ar: string; en: string; tone: Tone }> = {
  QUEUED: { ar: "بانتظار الإرسال", en: "Queued", tone: "warning" },
  SENDING: { ar: "يرسل الآن", en: "Sending", tone: "info" },
  SENT: { ar: "أُرسلت", en: "Sent", tone: "success" },
  FAILED: { ar: "فشلت", en: "Failed", tone: "danger" },
  SKIPPED: { ar: "لم تُرسل", en: "Skipped", tone: "neutral" },
  CANCELLED: { ar: "أُلغيت", en: "Cancelled", tone: "neutral" },
};

export function MessageStatusBadge({ status, lang, testId }: { status: string; lang: "ar" | "en"; testId?: string }) {
  const spec = MESSAGE_STATUS[status];
  if (!spec) return <span data-testid={testId}>{status}</span>;
  return <span data-testid={testId}><Dot tone={spec.tone}>{lang === "ar" ? spec.ar : spec.en}</Dot></span>;
}

export const SEND_MODE_LABELS: Record<string, { ar: string; en: string; tone: Tone }> = {
  OFF: { ar: "الإرسال متوقف", en: "Sending off", tone: "neutral" },
  TEST: { ar: "وضع التجربة", en: "Test mode", tone: "warning" },
  LIVE: { ar: "إرسال فعلي", en: "Live", tone: "success" },
};

/**
 * The server records why a message was skipped or failed in English, like every other
 * server message in this codebase. The known ones are shown in Arabic here; anything else
 * (a WhatsApp server's own error) is shown as received, isolated so its punctuation is not
 * reordered by the right-to-left page around it.
 */
const NOTE_AR: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Sending is turned off\./, () => "الإرسال متوقف: سجلت الرسالة ولم ترسل."],
  [/^Live sending is not enabled/, () => "الإرسال الفعلي غير مفعل على هذا الخادم (WHATSAPP_LIVE_ENABLED)."],
  [/^Test mode has no test number\./, () => "وضع التجربة بلا رقم تجربة: سُجّلت الرسالة كما كانت ستُرسل، ولم تُرسل."],
  [/^No recipient for this event/, () => "لا يوجد مستلم لهذا الحدث (مثلا: الطلب بلا مسؤول بعد)."],
  [/^This customer asked not to receive/, () => "العميل طلب عدم استقبال رسائل واتساب."],
  [/^No phone number\.$/, () => "لا يوجد رقم جوال."],
  [/^Not a valid Saudi mobile number\.$/, () => "رقم الجوال السعودي غير صالح."],
  [/^A local number that is not a Saudi mobile/, () => "رقم محلي ليس جوالا سعوديا. اكتبه مع مفتاح الدولة."],
  [/^Not a valid phone number\.$/, () => "رقم الجوال غير صالح."],
  [/^Expired: not sent within 24 hours/, () => "انتهت صلاحيتها: لم تُرسل خلال 24 ساعة من موعدها."],
  // GX E-90 E-S8.
  [/^Too many requests\. Wait a few minutes\.$/, () => "طلبات كثيرة. انتظر بضع دقائق ثم أعد المحاولة. حدّ الاتصال 60 إجراء كل 10 دقائق، والرسائل التجريبية 10."],
  [/^Interrupted while sending/, () => "انقطع الإرسال: قد تكون وصلت وقد لا تكون. أعد المحاولة فقط إذا تأكدت أنها لم تصل."],
  [/^The rule was deleted before/, () => "حذفت القاعدة قبل إرسال الرسالة."],
  [/^Test message\.$/, () => "رسالة تجريبية."],
  [/^This number is not on WhatsApp\.$/, () => "هذا الرقم غير مسجل في واتساب."],
  [/^The WhatsApp server could not be reached\.$/, () => "تعذر الوصول لخادم الواتساب."],
  [/^The WhatsApp server did not answer in time\.$/, () => "خادم الواتساب لم يرد في الوقت المحدد."],
  [/^WhatsApp is not connected \(state: (\w+)\)\.$/, () => "الواتساب غير متصل."],
  [/^Cancelled by (.+)\.$/, (m) => `ألغاها ${m[1]}.`],
  [/^Retried by (.+)\.$/, (m) => `أعاد إرسالها ${m[1]}.`],
  [/^Gave up after (\d+) attempts: (.+)$/, (m) => `توقفت المحاولة بعد ${m[1]} محاولات: ${noteText(m[2], "ar")}`],
];

export function noteText(note: string | null | undefined, lang: "ar" | "en"): string {
  if (!note) return "";
  if (lang === "en") return note;
  for (const [re, fn] of NOTE_AR) {
    const m = note.match(re);
    if (m) return fn(m);
  }
  return note;
}

export function Note({ note, lang, className = "" }: { note: string | null | undefined; lang: "ar" | "en"; className?: string }) {
  const text = noteText(note, lang);
  if (!text) return null;
  return (
    <span className={className} dir="auto">
      {text}
    </span>
  );
}

/** 9665XXXXXXXX → +966 5X XXX XXXX, isolated so it reads left-to-right inside Arabic text. */
export function Phone({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  const m = /^966(5\d)(\d{3})(\d{4})$/.exec(value);
  return <bdi dir="ltr">{m ? `+966 ${m[1]} ${m[2]} ${m[3]}` : `+${value}`}</bdi>;
}

const AR_LATN = "ar-SA-u-nu-latn-ca-gregory";

export function when(value: string | Date | null | undefined, lang: "ar" | "en"): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString(lang === "ar" ? AR_LATN : "en-GB", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The same instant as `when`, split into the frame's two lines: dd/mm/yyyy, then HH:mm. */
export function whenParts(value: string | Date | null | undefined): [string, string] {
  if (!value) return ["", ""];
  const d = typeof value === "string" ? new Date(value) : value;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return [`${g("day")}/${g("month")}/${g("year")}`, `${g("hour")}:${g("minute")}`];
}

/** A WhatsApp-looking bubble for previews: what the recipient will see. */
export function Bubble({ text, lang, testId }: { text: string; lang: "ar" | "en"; testId?: string }) {
  return (
    <div className="tl-bubble" data-testid={testId} dir="auto">
      {text || <span style={{ color: "var(--text-muted)" }}>{lang === "ar" ? "(رسالة فارغة)" : "(empty message)"}</span>}
    </div>
  );
}

export type Connection = { sendMode: string; effectiveMode: string; effectiveNote: string | null; state: string | null; configured: boolean; testPhone?: string | null; linkedPhone?: string | null };

/** The connection state as the frames word it. */
export function connectionLabel(state: string | null | undefined, configured = true): { ar: string; en: string; tone: Tone } {
  if (!configured) return { ar: "غير مُعدّ", en: "Not configured", tone: "danger" };
  if (state === "open") return { ar: "متصل", en: "Connected", tone: "success" };
  if (state === "connecting") return { ar: "جار الاتصال", en: "Connecting", tone: "warning" };
  return { ar: "غير متصل", en: "Not connected", tone: "danger" };
}

/** E-P01 / E-P03 header strip: connection · sending mode · «إعدادات الإرسال». */
export function ConnectionStrip({ conn, lang }: { conn: Connection; lang: "ar" | "en" }) {
  const ar = lang === "ar";
  const c = connectionLabel(conn.state, conn.configured);
  const mode = SEND_MODE_LABELS[conn.effectiveMode];
  // Copy as GX E-90 E-S3 / E-S4 word it.
  const modeNote =
    conn.effectiveMode === "OFF"
      ? ar ? "القواعد تعمل وتسجّل ما كانت سترسله · لا يُرسل شيء" : "Rules run and record what they would send · nothing is sent"
      : conn.effectiveMode === "TEST"
        ? conn.testPhone
          ? <>{ar ? "كل الرسائل تذهب لرقم التجربة " : "Every message goes to the test number "}<Phone value={conn.testPhone} />{ar ? " فقط" : " only"}</>
          : ar ? "كل الرسائل تذهب لرقم التجربة فقط" : "Every message goes to the test number only"
        : ar ? "الرسائل تذهب للمستلمين الفعليين." : "Messages go to the real recipients.";
  // E-S5: LIVE was saved, but this deployment does not allow it — the system behaves as OFF.
  const liveBlocked = conn.sendMode === "LIVE" && conn.effectiveMode === "OFF";
  return (
    <>
    <div className="tl-conn" data-testid="automation-connection">
      <div>
        <span className="tl-k">{ar ? "الاتصال" : "Connection"}</span>
        <Dot tone={c.tone}>{ar ? c.ar : c.en}</Dot>
        <span className="tl-d">
          {conn.state === "open"
            ? conn.linkedPhone
              // GX E-01 / E-04: «الرقم +966 5X XXX XXXX مربوط بجوال».
              ? <>{ar ? "الرقم " : "Number "}<Phone value={conn.linkedPhone} />{ar ? " مربوط بجوال" : " linked to a phone"}</>
              : ar ? "الرقم مربوط بجوال ويستطيع الإرسال." : "The number is linked to a phone and can send."
            : ar ? "لا جوال مربوط · الرسائل تنتظر في الطابور" : "No phone linked · messages wait in the queue"}
        </span>
      </div>
      {mode ? (
        <div>
          <span className="tl-k">{ar ? "وضع الإرسال" : "Sending mode"}</span>
          <Dot tone={mode.tone}>{ar ? mode.ar : mode.en}</Dot>
          <span className="tl-d">{modeNote}</span>
        </div>
      ) : null}
      <Link href="/dashboard/automation/whatsapp" className="hr-btn is-sm tl-end" style={{ textDecoration: "none" }}>
        {ar ? "إعدادات الإرسال" : "Sending settings"}
      </Link>
    </div>
    {liveBlocked ? (
      <div className="tl-note tone-warning" data-testid="automation-live-blocked">
        {ar
          ? "الوضع المحفوظ «إرسال فعلي» لكن الإرسال الفعلي غير مفعّل على الخادم، فيعمل النظام كأنه «متوقف». لا يُرسل شيء."
          : "The saved mode is «Live» but live sending is not enabled on the server, so the system behaves as «Off». Nothing is sent."}
      </div>
    ) : null}
    </>
  );
}

/** GX E-90 E-S2: a list that could not be loaded — nothing changed, try again. */
export function LoadError({ title, onRetry, lang }: { title: string; onRetry: () => void; lang: "ar" | "en" }) {
  const ar = lang === "ar";
  return (
    <div className="tl-loaderr" role="alert" data-testid="automation-load-error">
      <strong>{title}</strong>
      <span>{ar ? "لم يتغيّر شيء. أعد المحاولة." : "Nothing changed. Try again."}</span>
      <button type="button" className="hr-btn" onClick={onRetry}>{ar ? "إعادة المحاولة" : "Try again"}</button>
    </div>
  );
}

/**
 * «الأتمتة والواتساب»: title, sub-title, the three page tabs and (on the rules and the log) the
 * connection strip. `conn` undefined → the header reads the connection itself (GET
 * /api/automation/whatsapp, the read the rules page already makes); null → no strip.
 */
export function AutomationHeader({ lang, actions, ruleCount, conn, children }: { lang: "ar" | "en"; actions?: ReactNode; ruleCount?: number; conn?: Connection | null; children?: ReactNode }) {
  const ar = lang === "ar";
  const pathname = usePathname() ?? "";
  const [own, setOwn] = useState<Connection | null>(null);
  const wantsOwn = conn === undefined;
  useEffect(() => {
    if (!wantsOwn) return;
    let cancelled = false;
    api<Connection>("/api/automation/whatsapp").then((r) => {
      if (!cancelled && r.ok) setOwn(r.data);
    });
    return () => { cancelled = true; };
  }, [wantsOwn]);
  const shown = wantsOwn ? own : conn;
  const onRules = pathname === "/dashboard/automation" || pathname.startsWith("/dashboard/automation/rules");
  // «إشعارات الحالات» (addition beyond Figma): the admin role only, as its API.
  const isAdmin = useUser()?.role === "admin";
  return (
    <>
      <PageHeader title={ar ? "الأتمتة والواتساب" : "Automation & WhatsApp"} actions={actions} />
      <p className="tl-sub">{ar ? "رسائل واتساب تُرسل تلقائيًا عند أحداث النظام" : "WhatsApp messages sent automatically on system events"}</p>
      <LinkTabs
        label={ar ? "صفحات الأتمتة" : "Automation pages"}
        items={[
          // GX E-01m / E-05m (390): the pills read «القواعد · السجل · الواتساب».
          { href: "/dashboard/automation", label: <TabLabel full={ar ? "القواعد" : "Rules"} short={ar ? "القواعد" : "Rules"} />, count: ruleCount, current: onRules, testId: "tab-rules" },
          ...(isAdmin ? [{ href: "/dashboard/automation/statuses", label: <TabLabel full={ar ? "إشعارات الحالات" : "Status notifications"} short={ar ? "الحالات" : "Statuses"} />, current: pathname.startsWith("/dashboard/automation/statuses"), testId: "tab-statuses" }] : []),
          { href: "/dashboard/automation/messages", label: <TabLabel full={ar ? "سجل الرسائل" : "Message log"} short={ar ? "السجل" : "Log"} />, current: pathname.startsWith("/dashboard/automation/messages"), testId: "tab-messages" },
          { href: "/dashboard/automation/whatsapp", label: <TabLabel full={ar ? "ربط الواتساب" : "WhatsApp connection"} short={ar ? "الواتساب" : "WhatsApp"} />, current: pathname.startsWith("/dashboard/automation/whatsapp"), testId: "tab-whatsapp" },
        ]}
      />
      {shown ? <ConnectionStrip conn={shown} lang={lang} /> : null}
      {children}
    </>
  );
}

function TabLabel({ full, short }: { full: string; short: string }) {
  return (
    <>
      <span className="tl-hide-phone">{full}</span>
      <span className="tl-only-phone">{short}</span>
    </>
  );
}

/**
 * «لغة رسائل الموظفين» (owner language decision 3): the language automation messages reach employees
 * in when they have not chosen one on their profile. GET / PUT /api/automation/settings/employee-language
 * (edit: automation › manage_rules; audited). Customers' messages are not affected.
 */
export function EmployeeLanguageSetting({ lang }: { lang: "ar" | "en" }) {
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const [s, setS] = useState<{ employeeMessageLang: "ar" | "en" | null; effective: "ar" | "en"; can: { edit: boolean } } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ employeeMessageLang: "ar" | "en" | null; effective: "ar" | "en"; can: { edit: boolean } }>("/api/automation/settings/employee-language").then((r) => {
      if (!cancelled && r.ok) setS(r.data);
    });
    return () => { cancelled = true; };
  }, []);
  if (!s) return null;
  async function choose(v: "ar" | "en") {
    if (busy || !s || v === s.effective) return;
    setBusy(true);
    setMsg(null);
    const r = await api<{ employeeMessageLang: "ar" | "en" | null; effective: "ar" | "en"; can: { edit: boolean } }>("/api/automation/settings/employee-language", { method: "PUT", body: { employeeMessageLang: v } });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: (ar ? r.data.error : (r.data as { errorEn?: string }).errorEn ?? r.data.error) ?? L("تعذّر الحفظ.", "Could not save.") });
    setS(r.data);
    setMsg({ ok: true, text: L("حُفظ. تصل رسائل الموظفين بهذه اللغة ما لم يختر الموظف غيرها في ملفه.", "Saved. Employee messages use this language unless the employee chose another on their profile.") });
  }
  return (
    <section className="tl-sec" data-testid="employee-lang-setting">
      <header>
        <h2>{L("لغة رسائل الموظفين", "Employee message language")}</h2>
        <p>{L("لغة رسائل واتساب التي تصل الموظفين من القواعد وإشعارات الحالات · لكل موظف أن يختار لغته في «ملفي الشخصي» · رسائل العملاء لا تتغير", "The language of the WhatsApp messages rules and status notifications send to employees · each employee may choose their own on «My profile» · customer messages do not change")}</p>
      </header>
      <div className="tl-body">
        <span className="ops-seg" role="group" aria-label={L("لغة رسائل الموظفين", "Employee message language")}>
          {(["ar", "en"] as const).map((v) => (
            <button key={v} type="button" lang={v} aria-pressed={s.effective === v} disabled={!s.can.edit || busy} onClick={() => void choose(v)} data-testid={`employee-lang-${v}`}>
              {v === "ar" ? "العربية" : "English"}
            </button>
          ))}
        </span>
        <p className="tl-foot" style={{ margin: "8px 0 0" }}>
          {s.employeeMessageLang === null ? L("المعمول به الآن: الافتراضي (العربية)", "In force now: the default (Arabic)") : L("المعمول به الآن: القيمة المحفوظة", "In force now: the saved value")}
        </p>
        {msg ? <div role={msg.ok ? "status" : "alert"} className={`hr-notice tone-${msg.ok ? "success" : "danger"}`} data-testid="employee-lang-msg">{msg.text}</div> : null}
      </div>
    </section>
  );
}
