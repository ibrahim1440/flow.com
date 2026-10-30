// «مساحة عملي» — where a NEW login lands. Pure.
//
// The operational role templates (inventory / roasting / qc / dispatch — the warehouse, the roasters and
// the stations) keep their operational dashboard; every other new login (the administrator, a custom
// role: sales, finance, HR, marketing, managers) starts in «مساحة عملي». Existing accounts are never
// changed by this; the administrator picks any account's landing page in the account editor.
import { hasModuleAccess, type Permissions } from "@/lib/auth-shared";
export const WORKSPACE_ROUTE = "/dashboard/workspace";
const OPERATIONAL_ROLES = new Set(["inventory", "roasting", "qc", "dispatch"]);

export function defaultLandingFor(role: string): string {
  return OPERATIONAL_ROLES.has(role) ? "/dashboard" : WORKSPACE_ROUTE;
}

/** Landing routes that need no module (the API scopes everything to the person). */
export const OPEN_LANDING_ROUTES = new Set([WORKSPACE_ROUTE]);

// ── «يومي» (batch 24 WP-B) ───────────────────────────────────────────────────────────────────
// A SALES persona lands on «يومي» and its «الرئيسية» (the shell's home link, the phone Home tab) goes there. Who is one:
// a login that holds the sales module, is neither the admin nor an operational role template, and holds no operations
// station module (production, dispatch, packaging, QC — a seller who also roasts keeps the operations board). The sales
// manager is one (their day, plus any rep's day read-only). Everybody else keeps their home. Presentation and landing only: «يومي»'s API decides
// what is shown, from the session.

export const MY_DAY_ROUTE = "/dashboard/my-day";
/**
 * The landing value round 1 stored for «رجّعني للصفحة القديمة». Council fix round 2 (item 11) keeps the person's choice
 * in its own column, `Employee.homePreference` ("my-day" | "classic"), and never writes `defaultRoute` (the admin's):
 * this value is still READ as «classic» so an account saved by round 1 keeps its choice.
 */
export const CLASSIC_HOME_ROUTE = "/dashboard/workspace?home=classic";
export type HomePreference = "my-day" | "classic";
/** The landing values nobody chose: the defaults of a new account (and «يومي» itself). */
const UNCHOSEN_LANDINGS = new Set(["", "/dashboard", WORKSPACE_ROUTE, MY_DAY_ROUTE, CLASSIC_HOME_ROUTE]);
/** The administrator set this account's landing page explicitly: it wins, and «صفحتي الرئيسية» is read-only. */
export function landingSetByAdmin(defaultRoute: string | null | undefined): boolean {
  return !UNCHOSEN_LANDINGS.has(defaultRoute ?? "");
}
/** The person's home choice as it stands (NULL = «يومي»; round 1's stored landing counts as «classic»). */
export function homeChoice(defaultRoute: string | null | undefined, homePreference: string | null | undefined): HomePreference {
  return homePreference === "classic" || (!homePreference && defaultRoute === CLASSIC_HOME_ROUTE) ? "classic" : "my-day";
}
export const TEAM_ROUTE = "/dashboard/sales/team";
/** Roles that keep their own home: the administrator (no book of its own) and the operational templates. */
const NO_DAY_ROLES = new Set(["admin", ...OPERATIONAL_ROLES]);

export function isSalesPersona(v: { role?: string | null; permissions: Permissions | Record<string, unknown> }): boolean {
  if (!v.role || NO_DAY_ROLES.has(v.role)) return false;
  const p = v.permissions as Permissions;
  return hasModuleAccess(p, "sales") && !["production", "dispatch", "packaging", "qc"].some((m) => hasModuleAccess(p, m));
}

/**
 * Where a sign-in lands, given the account's stored landing page: a sales persona whose landing is still one of the
 * defaults («مساحة عملي» or the dashboard) lands on «يومي»; a landing page the administrator chose is kept.
 */
export function landingFor(
  defaultRoute: string,
  v: { role?: string | null; permissions: Permissions | Record<string, unknown> },
  opts: { teamViewWithoutBook?: boolean; homePreference?: string | null } = {},
): string {
  if (landingSetByAdmin(defaultRoute)) return defaultRoute;
  if (homeChoice(defaultRoute, opts.homePreference) === "classic") return WORKSPACE_ROUTE;
  if (isSalesPersona(v)) {
    // A team-view manager with no customer of their own lands on «متابعة الفريق», not on an empty «يومي».
    return opts.teamViewWithoutBook ? TEAM_ROUTE : MY_DAY_ROUTE;
  }
  return defaultRoute;
}
