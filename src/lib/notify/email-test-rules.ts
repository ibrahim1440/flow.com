// The pure rules of the e-mail demo run (feature/email-demo) — no database, so the unit tests import them.
import { isValidEmail } from "@/lib/notify/recipients";

export const EMAIL_TEST_ENTITY = "EmailTest";
export const EMAIL_TEST_REASON = "EMAIL_TEST_SENT";
export const EMAIL_TEST_LIMIT = { runs: 3, windowMs: 60 * 60 * 1000 } as const;

export function deploymentEnvironment(env: Record<string, string | undefined> = process.env): "production" | "preview" | "development" {
  return env.VERCEL_ENV === "production" ? "production" : env.VERCEL_ENV === "preview" ? "preview" : "development";
}

/** One address, trimmed and lower-cased, or null (a list, a display name or anything else is refused). */
export function parseTestRecipient(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (!t || /[\s,;<>"'()]/.test(t) || (t.match(/@/g) ?? []).length !== 1) return null;
  if (!isValidEmail(t)) return null;
  const domain = t.split("@")[1];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) ? t : null;
}

export const recipientDomain = (email: string) => email.split("@")[1] ?? "";

