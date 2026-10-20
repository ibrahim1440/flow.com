/**
 * Guest evaluators (owner decision D4), pure helpers: the name a guest types, how two names are
 * the same person, and the WhatsApp invitation text. Used by src/lib/services/qc-invite.ts and the
 * guest evaluation API; asserted by tests/ops/unit/production-simplify.test.ts.
 */
export const GUEST_NAME_MAX = 120;

export function cleanGuestName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.normalize("NFKC").replace(/\s+/g, " ").trim();
  return t.length >= 1 && t.length <= GUEST_NAME_MAX ? t : null;
}

/** Same person? Compared trimmed, spaces collapsed, case-insensitive. Pure. */
export function sameGuestName(a: string, b: string): boolean {
  const n = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return n(a) === n(b);
}

/** The text sent to a guest by WhatsApp (Arabic: the guests are local tasters). */
export function guestInviteText(name: string, url: string): string {
  return `مرحبًا ${name}، يدعوك فريق الجودة في حقبة لتقييم عيّنة قهوة. افتح الرابط وسجّل تقييمك (دون حساب ولا تسجيل دخول): ${url}`;
}

