// The one hosted database the accounting preview may write to (synthetic data only).
// Neon project "hiqbah-erp-test" (dry-smoke-16360248), branch "preview-accounting-ledger-core"
// (br-withered-art-aw2zp5kr), database accounting_preview, marked 'hiqbah-finance-disposable'.
// Production endpoints are refused by name as a second rail.
export const PREVIEW = { endpoint: "ep-plain-field-awqkif28", database: "accounting_preview" };
const DENIED = ["ep-dawn-dust-aqn1u1uf", "ep-jolly-feather-aqne6cp1", "ep-icy-field-aq4upc3z", "ep-noisy-night-aq3qczk4"];

export function isPreviewTarget(rawUrl) {
  let u;
  try { u = new URL(rawUrl ?? ""); } catch { return false; }
  if (DENIED.some((e) => u.hostname.includes(e))) return false;
  return u.hostname.startsWith(PREVIEW.endpoint) && u.pathname.replace(/^\//, "") === PREVIEW.database && process.env.ACCOUNTING_PREVIEW_DB === PREVIEW.database;
}
