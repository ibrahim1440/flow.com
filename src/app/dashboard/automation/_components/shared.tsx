"use client";

import { Ban, Check, CircleDashed, Clock, Send, XCircle, type LucideIcon } from "lucide-react";
import { useUser } from "../../user-context";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";

/**
 * Pieces the three automation screens share. Layout primitives (cards, buttons, tables)
 * come from the sales UI kit so this module looks like the rest of the system.
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

type Tone = "waiting" | "preparing" | "success" | "blocked" | "cancelled" | "hold";

const TONES: Record<Tone, string> = {
  preparing: "bg-oo-status-preparing-bg border-oo-status-preparing text-oo-status-preparing",
  waiting: "bg-oo-status-waiting-bg border-oo-status-waiting text-oo-status-waiting",
  success: "bg-oo-status-success-bg border-oo-status-success text-oo-status-success",
  cancelled: "bg-oo-status-cancelled-bg border-oo-status-cancelled text-oo-status-cancelled",
  blocked: "bg-oo-status-blocked-bg border-oo-status-blocked text-oo-status-blocked",
  hold: "bg-oo-status-hold-bg border-oo-status-hold text-oo-status-hold",
};

export const MESSAGE_STATUS: Record<string, { ar: string; en: string; tone: Tone; Icon: LucideIcon }> = {
  QUEUED: { ar: "بانتظار الإرسال", en: "Queued", tone: "waiting", Icon: Clock },
  SENDING: { ar: "يرسل الآن", en: "Sending", tone: "preparing", Icon: Send },
  SENT: { ar: "أرسلت", en: "Sent", tone: "success", Icon: Check },
  FAILED: { ar: "فشلت", en: "Failed", tone: "blocked", Icon: XCircle },
  SKIPPED: { ar: "لم ترسل", en: "Skipped", tone: "hold", Icon: CircleDashed },
  CANCELLED: { ar: "ألغيت", en: "Cancelled", tone: "cancelled", Icon: Ban },
};

export function Badge({ tone, Icon, children, testId }: { tone: Tone; Icon?: LucideIcon; children: React.ReactNode; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex h-7 items-center gap-2 rounded-md border px-2.5 py-1 text-[12px] font-medium leading-[18px] whitespace-nowrap ${TONES[tone]}`}
    >
      {Icon && <Icon size={16} aria-hidden className="flex-shrink-0" />}
      {children}
    </span>
  );
}

export function MessageStatusBadge({ status, lang, testId }: { status: string; lang: "ar" | "en"; testId?: string }) {
  const spec = MESSAGE_STATUS[status];
  if (!spec) return <span>{status}</span>;
  return (
    <Badge tone={spec.tone} Icon={spec.Icon} testId={testId}>
      {lang === "ar" ? spec.ar : spec.en}
    </Badge>
  );
}

export const SEND_MODE_LABELS: Record<string, { ar: string; en: string; tone: Tone }> = {
  OFF: { ar: "الإرسال متوقف", en: "Sending off", tone: "hold" },
  TEST: { ar: "وضع التجربة", en: "Test mode", tone: "waiting" },
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

/** A WhatsApp-looking bubble for previews: what the recipient will see. */
export function Bubble({ text, lang, testId }: { text: string; lang: "ar" | "en"; testId?: string }) {
  return (
    <div className="rounded-xl bg-[#e7f6e7] p-3" data-testid={testId}>
      <div className="max-w-[420px] whitespace-pre-wrap break-words rounded-lg bg-white px-3 py-2 text-[14px] leading-[22px] text-oo-text-primary shadow-sm" dir="auto">
        {text || <span className="text-oo-text-muted">{lang === "ar" ? "(رسالة فارغة)" : "(empty message)"}</span>}
      </div>
    </div>
  );
}
