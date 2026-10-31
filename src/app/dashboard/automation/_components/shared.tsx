"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Mail, MessageCircle } from "lucide-react";
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

/** Plain statuses (batch 25, council seat 5): «انرسل / وصل / ارتدّ / ما انرسل». */
export const MESSAGE_STATUS: Record<string, { ar: string; en: string; tone: Tone }> = {
  QUEUED: { ar: "ينتظر الإرسال", en: "Queued", tone: "warning" },
  SENDING: { ar: "ينرسل الحين", en: "Sending", tone: "info" },
  SENT: { ar: "انرسل", en: "Sent", tone: "success" },
  DELIVERED: { ar: "وصل", en: "Delivered", tone: "success" },
  BOUNCED: { ar: "ارتدّ", en: "Bounced", tone: "danger" },
  COMPLAINED: { ar: "بلّغ عنه كسبام", en: "Marked as spam", tone: "danger" },
  FAILED: { ar: "فشل", en: "Failed", tone: "danger" },
  SKIPPED: { ar: "ما انرسل", en: "Not sent", tone: "neutral" },
  CANCELLED: { ar: "أُلغي", en: "Cancelled", tone: "neutral" },
};

/** The one status a person reads: «ما انرسل: ما له إيميل», «موقوف بطلب العميل» — the reason folded in. */
export function plainStatus(status: string, note: string | null | undefined, lang: "ar" | "en"): { text: string; tone: Tone } {
  const spec = MESSAGE_STATUS[status] ?? { ar: status, en: status, tone: "neutral" as Tone };
  const ar = lang === "ar";
  if (status === "SKIPPED" && note) {
    if (/^This customer asked not to receive/.test(note)) return { text: ar ? "موقوف بطلب العميل" : "Stopped at the customer's request", tone: "neutral" };
    if (/^Not sent: the system address/.test(note)) return { text: ar ? "ما انرسل: إعداد ناقص" : "Not sent: setup missing", tone: "danger" };
    if (/^No e-mail address on record|^The e-mail address on record is not valid/.test(note)) return { text: ar ? "ما انرسل: ما له إيميل" : "Not sent: no e-mail", tone: "neutral" };
    if (/^No phone number|^Not a valid|^A local number/.test(note)) return { text: ar ? "ما انرسل: ما له رقم صالح" : "Not sent: no usable number", tone: "neutral" };
    if (/^This address bounced or complained/.test(note)) return { text: ar ? "ما انرسل: العنوان مرفوض" : "Not sent: address refused", tone: "neutral" };
    if (/sending is turned off|Sending is turned off|not enabled on this deployment|needs a test e-mail/.test(note)) return { text: ar ? "ما انرسل: الإرسال متوقف" : "Not sent: sending is off", tone: "neutral" };
    if (/^Tax invoice e-mails are locked/.test(note)) return { text: ar ? "ما انرسل: الفاتورة مقفلة" : "Not sent: invoice locked", tone: "neutral" };
  }
  return { text: ar ? spec.ar : spec.en, tone: spec.tone };
}

export function MessageStatusBadge({ status, note, lang, testId }: { status: string; note?: string | null; lang: "ar" | "en"; testId?: string }) {
  if (!MESSAGE_STATUS[status]) return <span data-testid={testId}>{status}</span>;
  const p = plainStatus(status, note, lang);
  return <span data-testid={testId} data-status={status}><Dot tone={p.tone}>{p.text}</Dot></span>;
}

/** The channel of a message, as an icon with its name for screen readers. */
export function ChannelIcon({ channel, lang }: { channel: string; lang: "ar" | "en" }) {
  const email = channel === "email";
  const label = email ? (lang === "ar" ? "إيميل" : "E-mail") : lang === "ar" ? "واتساب" : "WhatsApp";
  const Ico = email ? Mail : MessageCircle;
  return (
    <span className={`tl-chan is-${email ? "email" : "wa"}`} title={label} data-testid={`chan-${email ? "email" : "whatsapp"}`}>
      <Ico size={15} strokeWidth={1.6} aria-hidden />
      <span className="hr-sr">{label}</span>
    </span>
  );
}

/** «تجربة» is used for the sending mode only (batch 25). */
export const SEND_MODE_LABELS: Record<string, { ar: string; en: string; tone: Tone }> = {
  OFF: { ar: "متوقف", en: "Off", tone: "neutral" },
  TEST: { ar: "تجربة", en: "Test", tone: "warning" },
  LIVE: { ar: "فعلي", en: "Live", tone: "success" },
};

/**
 * The server records why a message was skipped or failed in English, like every other
 * server message in this codebase. The known ones are shown in Arabic here; anything else
 * (a WhatsApp server's own error) is shown as received, isolated so its punctuation is not
 * reordered by the right-to-left page around it.
 */
const NOTE_AR: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Sending is turned off\./, () => "الإرسال متوقف: سجلت الرسالة ولم ترسل."],
  [/^Live sending is not enabled/, () => "الإرسال الفعلي مقفل على هذا الخادم. يفتحه الدعم الفني."],
  [/^Test mode has no test number\./, () => "وضع التجربة بلا رقم تجربة: سُجّلت الرسالة كما كانت ستُرسل، ولم تُرسل."],
  [/^No recipient for this event/, () => "لا يوجد مستلم لهذا الحدث (مثلا: الطلب بلا مسؤول بعد)."],
  // Per channel (fix round 1): each reason names its own channel.
  [/^This customer asked not to receive WhatsApp/, () => "العميل طلب عدم استقبال رسائل واتساب."],
  [/^No phone number\.$/, () => "لا يوجد رقم جوال."],
  [/^Not a valid Saudi mobile number\.$/, () => "رقم الجوال السعودي غير صالح."],
  [/^A local number that is not a Saudi mobile/, () => "رقم محلي ليس جوالا سعوديا. اكتبه مع مفتاح الدولة."],
  [/^Not a valid phone number\.$/, () => "رقم الجوال غير صالح."],
  [/^Test mode: sent to the test number only\. The recipient's own number is not usable: (.+)$/, (m) => `وضع التجربة: أُرسلت إلى رقم التجربة فقط. رقم المستلم الأصلي لا يصلح للإرسال: ${noteText(m[1], "ar")}`],
  [/^Test mode: refused to send to a number other than the test number\.$/, () => "وضع التجربة: رُفض الإرسال إلى رقم غير رقم التجربة."],
  [/^Expired: not sent within 24 hours of its time\.(?: \((.+)\))?$/, (m) => `انتهت صلاحيتها: ما انرسلت خلال 24 ساعة من موعدها${m[1] ? ` — السبب: ${noteText(m[1], "ar")}` : "."}`],
  // GX E-90 E-S8.
  [/^Too many requests\. Wait a few minutes\.$/, () => "طلبات كثيرة. انتظر بضع دقائق ثم أعد المحاولة. حدّ الاتصال 60 إجراء كل 10 دقائق، والرسائل التجريبية 10."],
  [/^Interrupted while sending/, () => "انقطع الإرسال: قد تكون وصلت وقد لا تكون. أعد المحاولة فقط إذا تأكدت أنها لم تصل."],
  [/^The rule was deleted before/, () => "حذفت القاعدة قبل إرسال الرسالة."],
  [/^Test message\.$/, () => "رسالة اختبار الاتصال."],
  // Batch 25: the e-mail channel.
  [/^E-mail sending is turned off\./, () => "الإيميل متوقف: سُجّلت الرسالة وما انرسلت."],
  [/^Live e-mail is not enabled on this deployment\./, () => "الإيميل الفعلي مقفل على هذا الخادم، فما انرسل شي."],
  [/^Live e-mail needs a test e-mail/, () => "الإيميل الفعلي يحتاج رسالة تجربة وصلت خلال آخر 30 يوم."],
  [/^Test mode has no test e-mail address\./, () => "وضع التجربة بلا إيميل تجربة: سُجّلت الرسالة وما انرسلت."],
  [/^This customer asked not to receive e-mails\./, () => "العميل طلب عدم استقبال الإيميلات."],
  [/^Not sent: the system address \(APP_BASE_URL\)/, () => "ما انرسل: عنوان النظام غير مضبوط على الخادم، فالإيميل بيطلع بدون رابط إيقاف. كلّم الدعم الفني."],
  [/^The text of this message was moved to the archive/, () => "نص الرسالة انتقل للأرشيف (أقدم من 180 يوم)، فما تنعاد."],
  [/^The quotation is no longer issued/, () => "عرض السعر ما عاد صادر (منتهي أو مرفوض أو مستبدل)، فما نرسل ملفه."],
  [/^This address bounced or complained before/, () => "هذا العنوان ارتدّ أو بلّغ عن سبام قبل، فما نرسل له أبدًا."],
  [/^No e-mail address on record\./, () => "العميل ما عنده إيميل مسجّل."],
  [/^The e-mail address on record is not valid\./, () => "إيميل العميل المسجّل غير صحيح."],
  [/^Test mode: sent to the test address only\. The recipient's own address is not usable: (.+)$/, (m) => `وضع التجربة: وصلت لإيميل التجربة فقط. إيميل العميل نفسه ما يصلح: ${noteText(m[1], "ar")}`],
  [/^Test mode: refused to send to an address other than the test address\.$/, () => "وضع التجربة: رُفض الإرسال لعنوان غير إيميل التجربة."],
  [/^Tax invoice e-mails are locked/, () => "إيميل الفواتير مقفل لين تعتمدها الزكاة (زاتكا)."],
  [/^The attachment does not belong to this recipient\.$/, () => "الملف المرفق ما يخص هذا العميل، فما انرسل."],
  [/^The document to attach no longer exists/, () => "عرض السعر المرفق ما عاد موجود أو ما هو صادر."],
  [/^No e-mail provider is configured/, () => "الإيميل غير مربوط على هذا الخادم. كلّم الدعم الفني."],
  [/^Only transactional e-mails/, () => "الإيميلات التلقائية للمعاملات فقط (طلب، عرض سعر، دفعة)، ما نرسل تسويق."],
  [/^Bounced: the receiving server refused this address\.$/, () => "ارتدّ: خادم المستلم رفض العنوان (غالبًا الإيميل غلط)."],
  [/^The recipient marked it as spam\.$/, () => "المستلم بلّغ عنه كسبام، فأوقفنا الإيميلات له."],
  [/^Delivery delayed/, () => "التسليم متأخر: خادم المستلم طلب المحاولة لاحقًا."],
  [/^Soft bounce/, () => "ما وصل الحين: خادم المستلم ما قبله مؤقتًا."],
  [/^This number is not on WhatsApp\.$/, () => "هذا الرقم غير مسجل في واتساب."],
  [/^The WhatsApp server could not be reached\.$/, () => "تعذر الوصول لخادم الواتساب."],
  [/^The WhatsApp (?:provider|server) did not answer\.?$/, () => "خادم الواتساب لم يرد."],
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the language no longer changes the format; kept for the callers
export function when(value: string | Date | null | undefined, _lang?: "ar" | "en"): string {
  // dd/mm/yyyy HH:mm, Riyadh, 24-hour, Latin digits: no ص/م and no bidi marks, so it reads the same inside Arabic text
  // (fix round 2). Show it inside <bdi dir="ltr">.
  if (!value) return "";
  const [d, t] = whenParts(value);
  return `${d} ${t}`;
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

/** Batch 25: both channels' modes, read by the header strip (GET /api/automation/settings). */
export type Channels = { whatsapp: { sendMode: string; effectiveMode: string; testPhone: string | null }; email: { sendMode: string; effectiveMode: string; testEmail: string | null } };

/**
 * The header strip: the WhatsApp connection, then each channel's sending mode («واتساب: تجربة · إيميل: متوقف») —
 * one line, so nobody switches WhatsApp to test and forgets that e-mail is live. «إعدادات الإرسال» opens the card.
 */
export function ConnectionStrip({ conn, channels, lang }: { conn: Connection; channels?: Channels | null; lang: "ar" | "en" }) {
  const ar = lang === "ar";
  const c = connectionLabel(conn.state, conn.configured);
  const wa = SEND_MODE_LABELS[channels?.whatsapp.effectiveMode ?? conn.effectiveMode];
  const em = channels ? SEND_MODE_LABELS[channels.email.effectiveMode] : null;
  // E-S5: LIVE was saved, but this deployment does not allow it — the system behaves as OFF.
  const liveBlocked = conn.sendMode === "LIVE" && conn.effectiveMode === "OFF";
  const emailLiveBlocked = channels?.email.sendMode === "LIVE" && channels.email.effectiveMode === "OFF";
  const anyTest = channels?.whatsapp.effectiveMode === "TEST" || channels?.email.effectiveMode === "TEST" || conn.effectiveMode === "TEST";
  return (
    <>
    <div className="tl-conn" data-testid="automation-connection">
      <div>
        <span className="tl-k">{ar ? "اتصال الواتساب" : "WhatsApp link"}</span>
        <Dot tone={c.tone}>{ar ? c.ar : c.en}</Dot>
        <span className="tl-d">
          {conn.state === "open"
            ? conn.linkedPhone
              ? <>{ar ? "الرقم " : "Number "}<Phone value={conn.linkedPhone} />{ar ? " مربوط بجوال" : " linked to a phone"}</>
              : ar ? "الرقم مربوط بجوال ويستطيع الإرسال." : "The number is linked to a phone and can send."
            : ar ? "لا جوال مربوط · رسائل الواتساب تنتظر" : "No phone linked · WhatsApp messages wait"}
        </span>
      </div>
      {wa ? (
        <div data-testid="strip-modes">
          <span className="tl-k">{ar ? "وضع الإرسال" : "Sending mode"}</span>
          <span className="tl-modes">
            <ChannelIcon channel="whatsapp" lang={lang} /><Dot tone={wa.tone}>{ar ? wa.ar : wa.en}</Dot>
            {em ? <><span aria-hidden>·</span><ChannelIcon channel="email" lang={lang} /><span data-testid="strip-email-mode"><Dot tone={em.tone}>{ar ? em.ar : em.en}</Dot></span></> : null}
          </span>
          {anyTest ? <span className="tl-d">{ar ? "«تجربة» = الرسائل تجيك أنت بس، ولا شي يوصل للعملاء" : "«Test» = messages reach you only, never customers"}</span> : null}
        </div>
      ) : null}
      <Link href="/dashboard/automation/whatsapp" className="hr-btn is-sm tl-end" style={{ textDecoration: "none" }}>
        {ar ? "إعدادات الإرسال" : "Sending settings"}
      </Link>
    </div>
    {liveBlocked || emailLiveBlocked ? (
      <div className="tl-note tone-warning" data-testid="automation-live-blocked">
        {ar
          ? "الوضع المحفوظ «فعلي» لكن الإرسال الفعلي مقفل على الخادم، فيعمل النظام كأنه «متوقف». ما يطلع شي."
          : "The saved mode is «Live» but live sending is locked on the server, so the system behaves as «Off». Nothing is sent."}
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
 * «رسائل العملاء التلقائية» (batch 25; was «الأتمتة والواتساب»): title, sub-title, the page tabs and (on the rules and the log) the
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
  const [channels, setChannels] = useState<Channels | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<Channels>("/api/automation/settings").then((r) => { if (!cancelled && r.ok) setChannels(r.data); });
    return () => { cancelled = true; };
  }, []);
  const onRules = pathname === "/dashboard/automation" || pathname.startsWith("/dashboard/automation/rules");
  // «إشعارات الحالات» (addition beyond Figma): the admin role only, as its API.
  const isAdmin = useUser()?.role === "admin";
  // Fix round 2: a manager / rep without the automation module reads the log and the archive only.
  const { canView } = useAutomationAbilities();
  return (
    <>
      <PageHeader title={ar ? "رسائل العملاء التلقائية" : "Automated customer messages"} actions={actions} />
      <p className="tl-sub">{ar ? "رسائل واتساب وإيميل تُرسل تلقائيًا عند أحداث النظام" : "WhatsApp and e-mail messages sent automatically on system events"}</p>
      <LinkTabs
        label={ar ? "صفحات الأتمتة" : "Automation pages"}
        items={[
          // GX E-01m / E-05m (390): the pills read «القواعد · السجل · الواتساب».
          ...(canView ? [{ href: "/dashboard/automation", label: <TabLabel full={ar ? "القواعد" : "Rules"} short={ar ? "القواعد" : "Rules"} />, count: ruleCount, current: onRules, testId: "tab-rules" }] : []),
          ...(isAdmin ? [{ href: "/dashboard/automation/statuses", label: <TabLabel full={ar ? "إشعارات الحالات" : "Status notifications"} short={ar ? "الحالات" : "Statuses"} />, current: pathname.startsWith("/dashboard/automation/statuses"), testId: "tab-statuses" }] : []),
          { href: "/dashboard/automation/messages", label: <TabLabel full={ar ? "سجل الرسائل" : "Message log"} short={ar ? "السجل" : "Log"} />, current: pathname.startsWith("/dashboard/automation/messages"), testId: "tab-messages" },
          ...(canView ? [{ href: "/dashboard/automation/whatsapp", label: <TabLabel full={ar ? "الإعدادات" : "Settings"} short={ar ? "الإعدادات" : "Settings"} />, current: pathname.startsWith("/dashboard/automation/whatsapp"), testId: "tab-whatsapp" }] : []),
          ...(isAdmin || !canView ? [{ href: "/dashboard/automation/archive", label: <TabLabel full={ar ? "الأرشيف" : "Archive"} short={ar ? "الأرشيف" : "Archive"} />, current: pathname.startsWith("/dashboard/automation/archive"), testId: "tab-archive" }] : []),
        ]}
      />
      {shown ? <ConnectionStrip conn={shown} channels={channels} lang={lang} /> : null}
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
