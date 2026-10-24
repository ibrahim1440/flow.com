// ZATCA Phase 2 (A4) — the Fatoora HTTP client: one function per API, every call logged (ZatcaLog) with its
// secrets taken out, every answer classified the same way. Never called inside a database transaction.
//
// Classification of a clearance / reporting answer (Developer Portal manual; RUNBOOK §6):
//   200 → CLEARED / REPORTED (…_WITH_WARNINGS when warnings came back) · 202 → accepted with warnings
//   400 → REJECTED (validation errors; final — the fix is a credit note + a new invoice)
//   401 / 403 → ERROR (the CSID is not accepted: renew / onboard; not retried on its own)
//   303 → ERROR (clearance switched off for the taxpayer: ZATCA asks for reporting instead — needs a decision)
//   409 → ERROR (ZATCA says this document conflicts with one already received: reconcile on the Fatoora portal,
//          never resend blindly)
//   429 / 5xx / timeout / network → RETRY (same signed bytes, same UUID / hash / ICV; exponential backoff)
import { baseUrl } from "./config";
import type { ZatcaEnvironment } from "./crypto";

export type FatooraAction = "COMPLIANCE_CSID" | "COMPLIANCE_CHECK" | "PRODUCTION_CSID" | "RENEW_CSID" | "CLEARANCE" | "REPORTING";

export type FatooraCall = {
  action: FatooraAction; environment: ZatcaEnvironment; method: "POST" | "PATCH"; path: string;
  body: Record<string, unknown>; otp?: string; auth?: { token: string; secret: string }; clearanceStatus?: "0" | "1";
};

export type FatooraResult = {
  status: number | null; json: Record<string, unknown> | null; durationMs: number; networkError: string | null;
  /** The request and response with secrets removed — what goes into ZatcaLog. */
  logRequest: Record<string, unknown>; logResponse: Record<string, unknown> | null; url: string;
};

const SECRET_KEYS = new Set(["binarySecurityToken", "secret", "csr", "otp", "OTP", "privateKey"]);

/** Remove secrets and bulky documents (kept elsewhere, byte for byte) from what is logged. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) out[k] = x ? "[redacted]" : x;
      else if ((k === "invoice" || k === "clearedInvoice") && typeof x === "string") out[k] = `[xml base64, ${x.length} chars]`;
      else out[k] = redact(x, depth + 1);
    }
    return out;
  }
  if (typeof v === "string" && v.length > 2000) return `${v.slice(0, 2000)}…`;
  return v;
}

export async function callFatoora(c: FatooraCall, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<FatooraResult> {
  const url = `${baseUrl(c.environment)}${c.path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", "Accept-Language": "en", "Accept-Version": "V2" };
  if (c.otp) headers.OTP = c.otp;
  if (c.auth) headers.Authorization = `Basic ${Buffer.from(`${c.auth.token}:${c.auth.secret}`, "utf8").toString("base64")}`;
  if (c.clearanceStatus) headers["Clearance-Status"] = c.clearanceStatus;
  const logRequest = { headers: { "Accept-Version": "V2", ...(c.clearanceStatus ? { "Clearance-Status": c.clearanceStatus } : {}), ...(c.otp ? { OTP: "[redacted]" } : {}), ...(c.auth ? { Authorization: "[redacted]" } : {}) }, body: redact(c.body) as Record<string, unknown> };
  const t0 = Date.now();
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { method: c.method, headers, body: JSON.stringify(c.body), signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000), cache: "no-store" });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { json = { raw: text.slice(0, 2000) }; }
    return { status: res.status, json, durationMs: Date.now() - t0, networkError: null, logRequest, logResponse: json ? (redact(json) as Record<string, unknown>) : null, url };
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string } };
    const reason = err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : err.cause?.code ?? err.name ?? "network";
    return { status: null, json: null, durationMs: Date.now() - t0, networkError: String(reason).slice(0, 100), logRequest, logResponse: null, url };
  }
}

// ── answers ──────────────────────────────────────────────────────────────────────────────────────────

export type Messages = { type?: string; code?: string; category?: string; message?: string; status?: string }[];
export type Validation = { status: string | null; warnings: Messages; errors: Messages; info: Messages };

export function validationOf(json: Record<string, unknown> | null): Validation {
  const v = (json?.validationResults ?? {}) as Record<string, unknown>;
  const list = (x: unknown): Messages => (Array.isArray(x) ? (x as Messages).slice(0, 50) : []);
  const errors = list(v.errorMessages);
  // A 4xx body with a top-level `errors` (e.g. the CSID APIs) counts as errors too.
  if (!errors.length && Array.isArray(json?.errors)) errors.push(...list(json!.errors));
  return { status: typeof v.status === "string" ? v.status : null, warnings: list(v.warningMessages), errors, info: list(v.infoMessages) };
}

export type SubmissionOutcome =
  | { kind: "ACCEPTED"; status: "CLEARED" | "CLEARED_WITH_WARNINGS" | "REPORTED" | "REPORTED_WITH_WARNINGS"; clearedXmlB64: string | null; validation: Validation }
  | { kind: "REJECTED"; validation: Validation }
  | { kind: "ERROR"; reason: string; validation: Validation }
  | { kind: "RETRY"; reason: string };

/** What a clearance / reporting answer means for the document. */
export function classify(flow: "CLEARANCE" | "REPORTING", r: Pick<FatooraResult, "status" | "json" | "networkError">): SubmissionOutcome {
  const validation = validationOf(r.json);
  if (r.status === null) return { kind: "RETRY", reason: r.networkError ?? "network" };
  if (r.status === 200 || r.status === 202) {
    const cleared = flow === "CLEARANCE" ? String(r.json?.clearanceStatus ?? "") : String(r.json?.reportingStatus ?? "");
    const ok = flow === "CLEARANCE" ? cleared === "CLEARED" : cleared === "REPORTED";
    if (!ok) return { kind: "REJECTED", validation };
    const warn = r.status === 202 || validation.warnings.length > 0;
    const xml = flow === "CLEARANCE" && typeof r.json?.clearedInvoice === "string" ? (r.json.clearedInvoice as string) : null;
    if (flow === "CLEARANCE" && !xml) return { kind: "ERROR", reason: "CLEARED_WITHOUT_XML", validation };
    return { kind: "ACCEPTED", status: flow === "CLEARANCE" ? (warn ? "CLEARED_WITH_WARNINGS" : "CLEARED") : (warn ? "REPORTED_WITH_WARNINGS" : "REPORTED"), clearedXmlB64: xml, validation };
  }
  if (r.status === 400) return { kind: "REJECTED", validation };
  if (r.status === 401 || r.status === 403) return { kind: "ERROR", reason: `UNAUTHORIZED_${r.status}`, validation };
  if (r.status === 303) return { kind: "ERROR", reason: "CLEARANCE_SWITCHED_OFF", validation };
  if (r.status === 409) return { kind: "ERROR", reason: "CONFLICT_ALREADY_SUBMITTED", validation };
  if (r.status === 429 || r.status >= 500) return { kind: "RETRY", reason: `HTTP_${r.status}` };
  return { kind: "ERROR", reason: `HTTP_${r.status}`, validation };
}

/** Exponential backoff for the next attempt: 1, 2, 4 … minutes, capped at 60. */
export function backoffMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

/** A CSID answer: { requestID, dispositionMessage, binarySecurityToken, secret }. */
export function csidOf(json: Record<string, unknown> | null): { requestId: string; token: string; secret: string } | null {
  const requestId = json?.requestID ?? json?.requestId;
  const token = json?.binarySecurityToken, secret = json?.secret;
  if ((typeof requestId !== "string" && typeof requestId !== "number") || typeof token !== "string" || typeof secret !== "string" || !token || !secret) return null;
  return { requestId: String(requestId), token, secret };
}
