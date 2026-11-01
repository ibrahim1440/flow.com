// «رابط تفعيل الحساب» — the pure half: the token's stored form, the link, the WhatsApp text, the masked number.
import { createHash } from "node:crypto";

export const ACTIVATION_HOURS = 72;

/** What is stored for a token: its SHA-256 (hex). The token itself is never stored. */
export const tokenHashOf = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export const activationLink = (base: string, token: string) => `${base.replace(/\/+$/, "")}/login/activate?t=${encodeURIComponent(token)}`;

/** 9665XXXXXXXX → •••• 8222 (the screens and the audit never hold the full number). */
export const maskPhone = (phone: string) => `•••• ${phone.slice(-4)}`;

export function activationMessage(i: { name: string; username: string; company: string; link: string; purpose: "INVITE" | "RESET" }): string {
  const first = i.name.trim().split(/\s+/)[0] || i.name.trim();
  return [
    `مرحبًا ${first}،`,
    i.purpose === "INVITE" ? `تم إنشاء حسابك في نظام ${i.company}.` : `طُلبت إعادة تعيين كلمة مرور حسابك في نظام ${i.company}.`,
    `اسم المستخدم: ${i.username}`,
    `اختر كلمة مرورك من هذا الرابط (صالح ${ACTIVATION_HOURS} ساعة ولمرة واحدة):`,
    i.link,
    "لا تشارك هذا الرابط مع أي أحد.",
  ].join("\n");
}
