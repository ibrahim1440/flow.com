// The browser behind a session, for the signed-in user's own profile («ملفي الشخصي», Figma TD-11
// «أجهزتي» 556:4350 and UR-02d «الأجهزة والجلسات» 598:966).
//
// No database, no Next.js (node:crypto only) — importable by the routes and the unit tests; the page
// imports its types only.
//
// · DEVICE_COOKIE holds an opaque random id (24 random bytes, base64url) that each sign-in records on
//   its AuthSession row (deviceId), so the profile can group sessions into devices and mark «هذا
//   الجهاز». It is not a credential: it authenticates nothing and grants nothing. It is httpOnly and
//   first-party; a value that is not of the expected shape is ignored and replaced.
// · P2-B gate N2: the cookie is ISSUED and SIGNED by the server — `<id>.<HMAC-SHA256(pepper, id)>` — because it decides
//   the SEC-09 known-device exemption from the sign-in lock. A value whose signature does not verify (a planted id, or an
//   unsigned cookie from before this change) is ignored: the sign-in gets a new, signed id.
// · Session and device REFS are what the page sees: a one-way digest, never the session id itself
//   (the session id is the server-side pointer a token names) nor the raw device id.
// · describeUserAgent reads only the family of browser and operating system, for the labels.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEVICE_COOKIE = "hq_device";
/** About 400 days, the longest cookie lifetime browsers keep. */
export const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function newDeviceId(): string {
  return randomBytes(24).toString("base64url");
}

export function validDeviceId(v: unknown): v is string {
  return typeof v === "string" && DEVICE_ID.test(v);
}

/** The server secret the cookie is signed with: the same pepper as the rate limiter (RATE_LIMIT_SECRET, else JWT_SECRET). */
export function deviceSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.RATE_LIMIT_SECRET ?? env.JWT_SECRET;
  return s && s.length >= 32 ? s : null;
}
const mac = (id: string, secret: string) => createHmac("sha256", secret).update(`hiqbah:hq_device:v1:${id}`).digest("base64url").slice(0, 32);

/** The cookie value for a device id: `<id>.<signature>`. */
export function signDeviceId(id: string, secret: string): string {
  return `${id}.${mac(id, secret)}`;
}

/** The device id a cookie value carries, only when its signature verifies; null for an unsigned, forged or malformed value. */
export function verifyDeviceCookie(value: string | null | undefined, secret: string | null): string | null {
  if (!value || !secret) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!validDeviceId(id)) return null;
  const want = Buffer.from(mac(id, secret));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
}

/** The VERIFIED hq_device id from a Cookie header, or null when absent, malformed, unsigned or forged. */
export function deviceIdFromCookieHeader(header: string | null | undefined, secret: string | null = deviceSecret()): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== DEVICE_COOKIE) continue;
    return verifyDeviceCookie(part.slice(i + 1).trim(), secret);
  }
  return null;
}

const digest = (kind: string, v: string) => createHash("sha256").update(`hiqbah:${kind}:v1:${v}`).digest("base64url").slice(0, 22);
/** The public reference of a session (what the page and the end-session request carry). */
export const sessionRef = (sessionId: string) => digest("session-ref", sessionId);
/** The public reference of a device group (a recorded device id, or the user agent of older sessions). */
export const deviceRef = (key: string) => digest("device-ref", key);
/** The grouping key of a session: its recorded device id, else its user agent (sessions before deviceId). */
export const deviceKey = (s: { deviceId: string | null; userAgent: string | null }) => (s.deviceId ? `id:${s.deviceId}` : `ua:${s.userAgent ?? ""}`);

export type DeviceCategory = "desktop" | "phone" | "tablet";
export type DeviceInfo = { browser: string | null; os: string | null; category: DeviceCategory };

/** Browser and operating-system family from a User-Agent string (labels only; never a decision). */
export function describeUserAgent(ua: string | null | undefined): DeviceInfo {
  const s = ua ?? "";
  let os: string | null = null;
  if (/iPad/.test(s) || (/Macintosh/.test(s) && /Mobile\//.test(s))) os = "iPadOS";
  else if (/iPhone|iPod/.test(s)) os = "iOS";
  else if (/Android/.test(s)) os = "Android";
  else if (/Windows/.test(s)) os = "Windows";
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Mac OS X|Macintosh/.test(s)) os = "macOS";
  else if (/Linux/.test(s)) os = "Linux";

  let browser: string | null = null;
  if (/Edg(e|A|iOS)?\//.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/.test(s)) browser = "Opera";
  else if (/SamsungBrowser\//.test(s)) browser = "Samsung Internet";
  else if (/Firefox\/|FxiOS\//.test(s)) browser = "Firefox";
  else if (/Chrome\/|CriOS\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "Safari";

  const tablet = os === "iPadOS" || (os === "Android" && !/Mobile/.test(s)) || /Tablet/.test(s);
  const phone = !tablet && (os === "iOS" || (os === "Android" && /Mobile/.test(s)) || /Mobile/.test(s));
  return { browser, os, category: tablet ? "tablet" : phone ? "phone" : "desktop" };
}
