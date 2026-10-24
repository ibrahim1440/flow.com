// ZATCA Phase 2 (A4) — the switch and the endpoints.
//
// Effective mode = ZatcaSettings.mode, but only as far as the server allows it:
//   · ZATCA_ENABLED must be exactly "true" — otherwise the mode is OFF whatever the setting says (issuing then works
//     exactly as A2: no signing, no ICV, no submission);
//   · PRODUCTION also needs ZATCA_PRODUCTION_ALLOWED = "true" (set by the owner on go-live day, RUNBOOK §5).
// The default everywhere is OFF.
//
// Fatoora endpoints (Developer Portal manual; the SDK's API request format; host gw-fatoora.zatca.gov.sa). The
// paths are the same in the three environments; only the base differs. Verify against the current Developer
// Portal before going to simulation (RUNBOOK §2): ZATCA revises them.
//   POST  {base}/compliance                    OTP header, { csr }                        → compliance CSID
//   POST  {base}/compliance/invoices           Basic(compliance), { invoiceHash, uuid, invoice } → checks
//   POST  {base}/production/csids              Basic(compliance), { compliance_request_id } → production CSID
//   PATCH {base}/production/csids              Basic(production), OTP header, { csr }      → renewed CSID
//   POST  {base}/invoices/clearance/single     Basic(production), Clearance-Status: 1      → cleared XML
//   POST  {base}/invoices/reporting/single     Basic(production), Clearance-Status: 0      → reported
import type { ZatcaEnvironment } from "./crypto";

export type ZatcaMode = "OFF" | ZatcaEnvironment;
export const MODES: ZatcaMode[] = ["OFF", "SANDBOX", "SIMULATION", "PRODUCTION"];
export const ENVIRONMENTS: ZatcaEnvironment[] = ["SANDBOX", "SIMULATION", "PRODUCTION"];

export const BASE_URLS: Record<ZatcaEnvironment, string> = {
  SANDBOX: "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal",
  SIMULATION: "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation",
  PRODUCTION: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core",
};

type Env = Record<string, string | undefined>;

export const serverEnabled = (env: Env = process.env) => env.ZATCA_ENABLED === "true";
export const productionAllowed = (env: Env = process.env) => env.ZATCA_PRODUCTION_ALLOWED === "true";

/** Does the server allow this mode right now? */
export function serverAllows(mode: ZatcaMode, env: Env = process.env): boolean {
  if (mode === "OFF") return true;
  if (!serverEnabled(env)) return false;
  return mode !== "PRODUCTION" || productionAllowed(env);
}

export function effectiveMode(stored: string | null | undefined, env: Env = process.env): ZatcaMode {
  const m = (MODES as string[]).includes(stored ?? "") ? (stored as ZatcaMode) : "OFF";
  return serverAllows(m, env) ? m : "OFF";
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

/**
 * The base URL for an environment. ZATCA_MOCK_BASE_URL (tests, the local Playwright journey) replaces the SANDBOX
 * and SIMULATION bases only, and only with a loopback http URL — production always talks to ZATCA.
 */
export function baseUrl(env: ZatcaEnvironment, e: Env = process.env): string {
  const mock = e.ZATCA_MOCK_BASE_URL?.trim();
  if (mock && env !== "PRODUCTION" && LOOPBACK.test(mock)) return mock.replace(/\/$/, "");
  return BASE_URLS[env];
}

export const usingMock = (env: ZatcaEnvironment, e: Env = process.env) => baseUrl(env, e) !== BASE_URLS[env];

/** The developer portal's published test OTP (sandbox only: the compliance CSID there is a dummy). */
export const SANDBOX_TEST_OTP = "123345";

/** Simplified documents must be reported within 24 h; the board flags anything unreported after 20 h. */
export const REPORTING_WINDOW_MS = 24 * 3_600_000;
export const OVERDUE_AFTER_MS = 20 * 3_600_000;
