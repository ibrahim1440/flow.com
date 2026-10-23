// Shared by the bell, the «التنبيهات» page and the preferences (feat/notifications). Client-safe.
import type { D21IconName } from "@/components/shell/icons";
import type { Category } from "@/lib/notifications/catalog";

export type Item = {
  id: string; kind: string; category: Category; severity: "info" | "success" | "warning" | "danger";
  titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; link: string | null;
  createdAt: string; readAt: string | null; emailState: string;
};
export type ListResponse = { items: Item[]; unread: number; unreadByCategory: Record<string, number>; next: string | null };

export const CATEGORY_ICON: Record<Category, D21IconName> = {
  sales: "deal", production: "flame", quality: "flask", finance: "wallet", hr: "users", me: "note", system: "settings",
};

/** «الآن» · «منذ 5 دقائق» · «منذ 3 ساعات» · then the date (Riyadh). */
export function relTime(iso: string, ar: boolean, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return ar ? "الآن" : "just now";
  const m = Math.round(s / 60);
  if (m < 60) return ar ? (m === 1 ? "منذ دقيقة" : m === 2 ? "منذ دقيقتين" : m <= 10 ? `منذ ${m} دقائق` : `منذ ${m} دقيقة`) : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return ar ? (h === 1 ? "منذ ساعة" : h === 2 ? "منذ ساعتين" : h <= 10 ? `منذ ${h} ساعات` : `منذ ${h} ساعة`) : `${h} h ago`;
  return new Intl.DateTimeFormat(ar ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { timeZone: "Asia/Riyadh", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export async function markRead(body: { ids?: string[]; all?: boolean; category?: string }) {
  await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  window.dispatchEvent(new Event("hq-notifications-changed"));
}
