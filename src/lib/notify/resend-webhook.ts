/**
 * Resend webhooks (batch 25): signature verification by hand, following Svix's documented scheme (Resend signs its
 * webhooks with Svix) — no dependency added.
 *
 *   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
 *   secret         = the endpoint's signing secret «whsec_<base64>»; the HMAC key is the base64-decoded part
 *   signature      = base64(HMAC-SHA256(key, signed content))
 *   svix-signature = space-separated «v1,<signature>» entries (several during a secret rotation); one must match
 *   svix-timestamp = Unix seconds; refused when more than 5 minutes away from now (replay window)
 *
 * Pure apart from node:crypto, so the unit tests assert it without a server.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_S = 5 * 60;

export type WebhookHeaders = { id: string | null; timestamp: string | null; signature: string | null };

export function signingKey(secret: string): Buffer | null {
  const s = secret.trim();
  const raw = s.startsWith("whsec_") ? s.slice(6) : s;
  if (!raw || !/^[A-Za-z0-9+/=]+$/.test(raw)) return null;
  const k = Buffer.from(raw, "base64");
  return k.length >= 16 ? k : null;
}

export function svixSignature(secret: string, id: string, timestamp: string, body: string): string {
  const k = signingKey(secret);
  if (!k) throw new Error("Invalid webhook secret.");
  return createHmac("sha256", k).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export type VerifyResult = { ok: true } | { ok: false; reason: "NO_SECRET" | "MISSING_HEADERS" | "STALE" | "BAD_SIGNATURE" };

export function verifySvix(secret: string | undefined, h: WebhookHeaders, body: string, now: Date = new Date()): VerifyResult {
  if (!secret || !signingKey(secret)) return { ok: false, reason: "NO_SECRET" };
  if (!h.id || !h.timestamp || !h.signature || h.id.length > 200 || !/^\d{1,12}$/.test(h.timestamp)) return { ok: false, reason: "MISSING_HEADERS" };
  const ts = Number(h.timestamp);
  if (Math.abs(now.getTime() / 1000 - ts) > WEBHOOK_TOLERANCE_S) return { ok: false, reason: "STALE" };
  const want = Buffer.from(svixSignature(secret, h.id, h.timestamp, body));
  for (const part of h.signature.split(" ")) {
    const [v, sig] = part.split(",");
    if (v !== "v1" || !sig) continue;
    const got = Buffer.from(sig);
    if (got.length === want.length && timingSafeEqual(got, want)) return { ok: true };
  }
  return { ok: false, reason: "BAD_SIGNATURE" };
}

/** The events this phase acts on, and what each does to the message and the address. */
export type ResendEventKind = "delivered" | "bounced_hard" | "bounced_soft" | "complained" | "delayed" | "other";

/** The tag every customer-automation send carries (fix round 2). Resend webhooks are account-wide: the alert, HR and
 * notification e-mails of the same account report here too, and only a tagged event is ours. */
export const AUTOMATION_TAG = { name: "hq", value: "automation" } as const;

/** Whether the event's e-mail carried our tag. Resend gives `data.tags` as an object ({hq:"automation"}) in webhooks; a
 * list of {name, value} is accepted too. */
function taggedOf(data: Record<string, unknown>): boolean {
  const t = data.tags;
  if (Array.isArray(t)) return t.some((x) => x && typeof x === "object" && (x as { name?: unknown }).name === AUTOMATION_TAG.name && (x as { value?: unknown }).value === AUTOMATION_TAG.value);
  if (t && typeof t === "object") return (t as Record<string, unknown>)[AUTOMATION_TAG.name] === AUTOMATION_TAG.value;
  return false;
}

export function classifyResendEvent(payload: unknown): { kind: ResendEventKind; providerMessageId: string | null; type: string; to: string[]; tagged: boolean; createdAt: Date | null } {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const type = typeof p.type === "string" ? p.type.slice(0, 60) : "";
  const data = p.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : {};
  const providerMessageId = typeof data.email_id === "string" ? data.email_id.slice(0, 200) : null;
  // The addresses the event is about (Resend: data.to, a list): a bounce / complaint suppresses them even before the
  // message itself is matched (fix round 1).
  const rawTo = Array.isArray(data.to) ? data.to : typeof data.to === "string" ? [data.to] : [];
  const tagged = taggedOf(data);
  const created = typeof data.created_at === "string" ? new Date(data.created_at) : typeof p.created_at === "string" ? new Date(p.created_at) : null;
  const createdAt = created && !Number.isNaN(created.getTime()) ? created : null;
  const to = rawTo.filter((x): x is string => typeof x === "string").map((x) => (x.match(/<([^>]+)>/)?.[1] ?? x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x) && x.length <= 254).slice(0, 10);
  if (type === "email.delivered") return { kind: "delivered", providerMessageId, type, to, tagged, createdAt };
  if (type === "email.complained") return { kind: "complained", providerMessageId, type, to, tagged, createdAt };
  if (type === "email.delivery_delayed") return { kind: "delayed", providerMessageId, type, to, tagged, createdAt };
  if (type === "email.bounced") {
    // Resend: data.bounce.type is "Permanent" (hard) or "Transient" / "Undetermined" (soft). Unknown → hard: never retry.
    const bounce = data.bounce && typeof data.bounce === "object" ? (data.bounce as Record<string, unknown>) : {};
    const bt = typeof bounce.type === "string" ? bounce.type.toLowerCase() : "";
    return { kind: bt === "transient" || bt === "undetermined" ? "bounced_soft" : "bounced_hard", providerMessageId, type, to, tagged, createdAt };
  }
  return { kind: "other", providerMessageId, type, to, tagged, createdAt };
}
