// «مساحة عملي» — where a NEW login lands. Pure.
//
// The operational role templates (inventory / roasting / qc / dispatch — the warehouse, the roasters and
// the stations) keep their operational dashboard; every other new login (the administrator, a custom
// role: sales, finance, HR, marketing, managers) starts in «مساحة عملي». Existing accounts are never
// changed by this; the administrator picks any account's landing page in the account editor.
export const WORKSPACE_ROUTE = "/dashboard/workspace";
const OPERATIONAL_ROLES = new Set(["inventory", "roasting", "qc", "dispatch"]);

export function defaultLandingFor(role: string): string {
  return OPERATIONAL_ROLES.has(role) ? "/dashboard" : WORKSPACE_ROUTE;
}

/** Landing routes that need no module (the API scopes everything to the person). */
export const OPEN_LANDING_ROUTES = new Set([WORKSPACE_ROUTE]);
