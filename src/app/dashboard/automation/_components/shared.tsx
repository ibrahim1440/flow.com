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
  [/^Test mode has no test number\./, () => "وضع التجربة بلا رقم تجربة."],
  [/^No recipient for this event/, () => "لا يوجد مستلم لهذا الحدث (مثلا: الطلب بلا مسؤول بعد)."],
  [/^This customer asked not to receive/, () => "العميل طلب عدم استقبال رسائل واتساب."],
  [/^No phone number\.$/, () => "لا يوجد رقم جوال."],
  [/^Not a valid Saudi mobile number\.$/, () => "رقم الجوال السعودي غير صالح."],
  [/^A local number that is not a Saudi mobile/, () => "رقم محلي ليس جوالا سعوديا. اكتبه مع مفتاح الدولة."],
  [/^Not a valid phone number\.$/, () => "رقم الجوال غير صالح."],
  [/^Expired: not sent within 24 hours/, () => "انتهت صلاحيتها: لم ترسل خلال 24 ساعة من موعدها."],
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

export type Connection = { sendMode: string; effectiveMode: string; effectiveNote: string | null; state: string | null; configured: boolean; testPhone?: string | null };

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
  const modeNote =
    conn.effectiveMode === "OFF"
      ? ar ? "القواعد تعمل وتسجل ما كانت سترسله، لكن لا يرسل شيء." : "Rules run and record what they would send; nothing is sent."
      : conn.effectiveMode === "TEST"
        ? ar ? "كل الرسائل تذهب لرقم التجربة فقط." : "Every message goes to the test number only."
        : ar ? "الرسائل تذهب للمستلمين الفعليين." : "Messages go to the real recipients.";
  return (
    <div className="tl-conn" data-testid="automation-connection">
      <div>
        <span className="tl-k">{ar ? "الاتصال" : "Connection"}</span>
        <Dot tone={c.tone}>{ar ? c.ar : c.en}</Dot>
        <span className="tl-d">
          {conn.state === "open"
            ? ar ? "الرقم مربوط بجوال ويستطيع الإرسال." : "The number is linked to a phone and can send."
            : ar ? "الواتساب غير متصل الآن." : "WhatsApp is not connected."}
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
  return (
    <>
      <PageHeader title={ar ? "الأتمتة والواتساب" : "Automation & WhatsApp"} actions={actions} />
      <p className="tl-sub">{ar ? "رسائل واتساب تُرسل تلقائيًا عند أحداث النظام" : "WhatsApp messages sent automatically on system events"}</p>
      <LinkTabs
        label={ar ? "صفحات الأتمتة" : "Automation pages"}
        items={[
          { href: "/dashboard/automation", label: ar ? "القواعد" : "Rules", count: ruleCount, current: onRules, testId: "tab-rules" },
          { href: "/dashboard/automation/messages", label: ar ? "سجل الرسائل" : "Message log", current: pathname.startsWith("/dashboard/automation/messages"), testId: "tab-messages" },
          { href: "/dashboard/automation/whatsapp", label: ar ? "ربط الواتساب" : "WhatsApp connection", current: pathname.startsWith("/dashboard/automation/whatsapp"), testId: "tab-whatsapp" },
        ]}
      />
      {shown ? <ConnectionStrip conn={shown} lang={lang} /> : null}
      {children}
    </>
  );
}
