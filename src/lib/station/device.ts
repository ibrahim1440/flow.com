// Workstations W2 — the pure pieces of station devices and station sessions: the codes, their
// hashes, the cookies and the policy defaults. No database, no Next.js (node:crypto only), so the
// routes, the services and the unit tests share one definition.
//
// · Device code («رمز هذا الجهاز», WS-XXXX): shown by an unregistered device on S1. The administrator
//   types it when registering the device (UR-14), so the one-time activation code only works on the
//   browser that showed it. Not a secret.
// · Activation code (UR-14b, 6 characters): random, stored only as a keyed hash, single use, short
//   lived (policy, ≤ 15 min), its wrong attempts counted per device and per address.
// · Device token (hq_station cookie): 32 random bytes, base64url; the database keeps SHA-256 of it.
//   It identifies the device only — it opens nothing by itself (H1).
// · Station session (hq_station_session cookie): the same signed session pointer an ERP sign-in
//   uses (sid), naming an AuthSession row with scope STATION. The ERP APIs refuse it.
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { CODE_ALPHABET } from "./codes";

export { CODE_ALPHABET };
export const DEVICE_CODE_RE = /^WS-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
export const ACTIVATION_CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;

export const STATION_DEVICE_COOKIE = "hq_station";
export const STATION_SESSION_COOKIE = "hq_station_session";
/** The device cookie lasts as long as browsers keep one (≈ 400 days); revocation ends it at once. */
export const STATION_DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
/** A station session ends at most this long after sign-in (H2: shift length, 8 h). */
export const STATION_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

export const STATION_TYPES = ["ROASTING", "QUALITY", "PACKAGING"] as const;
export type StationType = (typeof STATION_TYPES)[number];

/** The module privilege a station's work needs (the same guard the ERP uses; never a privileged key). */
/** sub = null: the module at edit (packaging has no sub-privileges). */
export const STATION_PRIVILEGE: Record<StationType, { module: string; sub: string | null }> = {
  ROASTING: { module: "production", sub: "start_batch" },
  QUALITY: { module: "qc", sub: "create_record" },
  PACKAGING: { module: "packaging", sub: null },
};
/**
 * Workstations W4: the packaging station has two tabs that never share a queue, each with its own
 * module privilege (the same key the ERP checks): «التعبئة» packs released batches (packaging at
 * edit, as POST /api/roasting-batches/[id]/pack), «تجهيز الطلبات» picks reserved lots and hands the
 * order to dispatch (dispatch at edit — the dispatch duty; no new key). Signing in at a packaging
 * station needs either one; each tab's APIs need their own.
 */
export type StationTab = "packaging" | "preparation";
export const STATION_TAB_PRIVILEGE: Record<StationTab, { module: string; sub: string | null }> = {
  packaging: { module: "packaging", sub: null },
  preparation: { module: "dispatch", sub: null },
};
export const STATION_TYPE_TABS: Record<StationType, StationTab[]> = { ROASTING: [], QUALITY: [], PACKAGING: ["packaging", "preparation"] };
/** Where a signed-in employee works, per station type (the QC station is not built yet). */
export const STATION_HOME: Record<StationType, string | null> = { ROASTING: "/station/roasting", QUALITY: null, PACKAGING: "/station/packaging" };

// ── Policy (owner decision D7, 22 Oct 2026): configurable, these are the approved defaults ──
export const POLICY_DEFAULTS = { idleMinutes: 5, pinMaxAttempts: 5, activationMinutes: 15 } as const;
export const POLICY_LIMITS = { idleMinutes: [1, 60], pinMaxAttempts: [3, 10], activationMinutes: [1, 15] } as const;
export type StationPolicyValues = { idleMinutes: number; pinMaxAttempts: number; activationMinutes: number };
export function effectivePolicy(row: { idleMinutes: number | null; pinMaxAttempts: number | null; activationMinutes: number | null } | null | undefined): StationPolicyValues {
  return {
    idleMinutes: row?.idleMinutes ?? POLICY_DEFAULTS.idleMinutes,
    pinMaxAttempts: row?.pinMaxAttempts ?? POLICY_DEFAULTS.pinMaxAttempts,
    activationMinutes: row?.activationMinutes ?? POLICY_DEFAULTS.activationMinutes,
  };
}
/** A policy value from a form: an integer within its limits, null to return to the default, or an error. */
export function policyValue(key: keyof typeof POLICY_LIMITS, raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === "" || raw === undefined) return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const [lo, hi] = POLICY_LIMITS[key];
  if (!Number.isInteger(n) || n < lo || n > hi) return { ok: false };
  return { ok: true, value: n };
}

// ── Codes ──────────────────────────────────────────────────────────────────────────────────────
function code(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
export const newDeviceCode = () => `WS-${code(4)}`;
export const newActivationCode = () => code(6);

/** «ws-7f3k», «WS 7F3K», «7F3K» → «WS-7F3K»; null when it is not a device code. */
export function normalizeDeviceCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.toUpperCase().replace(/[\s_]/g, "").replace(/^WS-?/, "");
  s = `WS-${s}`;
  return DEVICE_CODE_RE.test(s) ? s : null;
}
/** «4m7q2k», «4M7 Q2K» → «4M7Q2K»; null when it is not an activation code. */
export function normalizeActivationCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, "");
  return ACTIVATION_CODE_RE.test(s) ? s : null;
}

/** Keyed hash of an activation code, bound to the device code it was issued for. */
export function activationCodeHash(activationCode: string, deviceCode: string, secret: string): string {
  return createHmac("sha256", secret).update(`hiqbah:station-activation:v1:${deviceCode}:${activationCode}`).digest("base64url");
}

export const newDeviceToken = () => randomBytes(32).toString("base64url");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const validDeviceToken = (v: unknown): v is string => typeof v === "string" && TOKEN_RE.test(v);
/** SHA-256 of the device token: what the database keeps (the token is 256 random bits, so no key is needed). */
export const deviceTokenHash = (token: string) => createHash("sha256").update(`hiqbah:station-device:v1:${token}`).digest("base64url");

/** The value of one cookie from a Cookie header (null when absent). */
export function cookieFrom(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// ── The station PIN verifier (its own domain; never the ERP PIN's) ─────────────────────────────
/** What bcrypt hashes for a station PIN: a keyed HMAC, so a stolen row cannot be tested offline. */
export function stationPinVerifierInput(pin: string, secret: string): string {
  return createHmac("sha384", secret).update(`station-pin:verify:v1:${pin}`).digest("base64");
}

/** «نورة السبيعي» → «نس» (the station avatar: the article «ال» is not an initial). */
export function stationInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "؟";
  const second = parts[1] ? parts[1].replace(/^ال(?=.)/, "") : "";
  return (parts[0][0] + (second[0] ?? "")).toUpperCase();
}
