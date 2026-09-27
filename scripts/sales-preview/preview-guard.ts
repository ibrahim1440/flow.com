/**
 * The guard the TypeScript Preview scripts share, and the three disposable browser
 * identities, in one place so the provisioning script and the browser suite cannot drift
 * apart.
 *
 * This is the importable sibling of `withpreview.mjs`, which guards *processes* — it
 * applies the same three conditions to a connection string, plus the same denylist of
 * protected endpoints and privileged roles as a second line. A connection that is not the
 * approved preview endpoint, the isolated database and the restricted runtime role is
 * refused before any statement runs. Never prints a value.
 */
import { readFileSync } from "node:fs";
import type { RoleName } from "../../tests/e2e/support/roles";

const ALLOWED_ENDPOINT = "ep-wandering-leaf-aqjtuin5";
const ALLOWED_DATABASE = "sales_preview";
const ALLOWED_ROLE = "sales_preview_app";
const FORBIDDEN_ROLES = ["neondb_owner", "cloud_admin", "neon_service", "sales_preview_migrator"];
const DENIED_ENDPOINTS = ["ep-dawn-dust-aqn1u1uf", "ep-jolly-feather-aqne6cp1", "ep-icy-field-aq4upc3z"];

/** Where the preview app env file lives, matching the other Preview suites' default. */
export const PREVIEW_ENV_DEFAULT = "C:/Users/mtmbk/.beanflow/sales-preview/.env.preview-app";

/** The `NAV_` prefix is the cleanup contract: everything matching it is disposable. */
export const NAV_PREFIX = "NAV";

/**
 * Throwaway logins on an isolated preview database — not credentials, and deliberately
 * fixed so a re-run reissues the same ones instead of accumulating accounts. They are
 * never printed: a reader who needs one reads this file.
 */
export const NAV_PEOPLE: { id: string; name: string; pin: string; role: RoleName }[] = [
  { id: `${NAV_PREFIX}_rep`, name: `${NAV_PREFIX} Sales Rep`, pin: "940011", role: "crmRep" },
  { id: `${NAV_PREFIX}_manager`, name: `${NAV_PREFIX} Sales Manager`, pin: "940022", role: "crmManager" },
  { id: `${NAV_PREFIX}_finance`, name: `${NAV_PREFIX} Finance`, pin: "940033", role: "crmFinance" },
];

export type PreviewEnv = { url: string; secret: string; vars: Record<string, string> };

export class PreviewRefusal extends Error {}

/** Read the preview env file, then refuse anything that is not the approved database. */
export function loadPreviewEnv(envFile = process.env.PREVIEW_ENV ?? PREVIEW_ENV_DEFAULT): PreviewEnv {
  const refuse = (why: string): never => {
    throw new PreviewRefusal(`REFUSE: ${why}`);
  };

  let text: string;
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    return refuse(`cannot read the preview env file at ${envFile} — set PREVIEW_ENV`);
  }

  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) vars[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }

  const url = vars.DATABASE_URL;
  if (!url) refuse("DATABASE_URL is not in that env file");
  for (const bad of DENIED_ENDPOINTS) {
    if (url.includes(bad)) refuse("DATABASE_URL names a protected endpoint");
  }

  // Parsed rather than pattern-matched, so the role and database checked here are the ones
  // the driver will actually use — a substring test can be fooled by a query parameter.
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return refuse("unusable connection string");
  }
  if (!u.hostname.startsWith(ALLOWED_ENDPOINT)) refuse("not the approved preview endpoint");
  if (u.pathname.replace(/^\//, "") !== ALLOWED_DATABASE) refuse("not the approved preview database");
  if (FORBIDDEN_ROLES.includes(u.username)) refuse(`privileged or migration role; must be ${ALLOWED_ROLE}`);
  if (u.username !== ALLOWED_ROLE) refuse(`must run as ${ALLOWED_ROLE}`);

  const secret = vars.PIN_LOOKUP_SECRET;
  if (!secret || secret.length < 32) refuse("PIN_LOOKUP_SECRET missing or too short");

  return { url, secret, vars };
}
