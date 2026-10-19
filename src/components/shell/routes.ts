/**
 * Which dashboard routes render inside the Direction 2.1 shell.
 *
 * The shell itself is shared and registry-driven; a module moves onto it once its own
 * screens have been brought to Direction 2.1, so that no page shows Direction 2.1
 * navigation around legacy content (or the reverse). HR and employee self-service were
 * designed in Direction 2.1 from the start, and operations followed in migration phase 1
 * (whole prefixes), and stock (inventory, purchases, products) in phase 2. The CRM routes of implementation
 * batch 0/1 were rebuilt to their frames one route at a time, so they are listed as anchored,
 * segment-exact patterns: `/dashboard/sales/leads/123` is the lead page. UI batches 1 and 2 moved
 * every remaining module (accounting as a placeholder), so no dashboard route keeps the legacy
 * shell today; a new module still needs its prefix or pattern here to render in Direction 2.1.
 */
export const DIRECTION_21_ROUTES: readonly (string | RegExp)[] = [
  // The operations dashboard «اليوم» (Figma 20:236 / 24:842 / 34:1405), exact path only: every
  // other /dashboard/* module keeps its own entry below or the legacy shell.
  /^\/dashboard\/?$/,
  "/dashboard/hr",
  "/dashboard/me",
  // Operations (migration phase 1, docs/shell/MIGRATION-PLAN.md): orders, preparation,
  // production, production orders, packaging, dispatch, quality control and cupping.
  "/dashboard/orders",
  "/dashboard/workstation",
  "/dashboard/production",
  "/dashboard/production-orders",
  "/dashboard/packaging",
  "/dashboard/dispatch",
  "/dashboard/qc",
  "/dashboard/cupping",
  // CRM (implementation batch 0/1): the rebuilt routes, segment-exact.
  /^\/dashboard\/sales\/leads\/?$/,
  /^\/dashboard\/sales\/leads\/[^/]+\/?$/,
  /^\/dashboard\/sales\/pipeline\/?$/,
  /^\/dashboard\/sales\/deals\/[^/]+\/?$/,
  /^\/dashboard\/sales\/activities\/?$/,
  // UI batch 2 (sales-quotes): the whole quotations area — list (181:1609), editor and issued
  // quotation (GX A-10 / A-11), document view (GX A-12) — and collections (GX A-01).
  "/dashboard/sales/quotes",
  "/dashboard/sales/collections",
  // Labels and the print subsystem (G-20 / G-21), designed in Direction 2.1.
  "/dashboard/labels",
  // Stock (migration phase 2, UI batch 1 · module A): inventory, purchases and products, ported
  // to the frozen Phase 3 frames (Figma page 216:2, docs/design/direction-2.1-rc/INVENTORY.md).
  "/dashboard/inventory",
  "/dashboard/purchases",
  "/dashboard/products",
  // Users & permissions (UI batch 1): a visual-only port of the legacy screen.
  "/dashboard/employees",
  // UI batch 2 · performance (GX A-P03…A-P08): targets, sales reports, my commissions, sales
  // settings, commission review and plans — segment-exact, so no other sales route matches.
  /^\/dashboard\/sales\/(targets|reports|my-commissions|settings)\/?$/,
  /^\/dashboard\/commissions\/(review|plans)\/?$/,
  // UI batch 2 · core: the customers list with its account panel (styled after 179:1312) and the
  // own profile (language, PIN, two-step verification) — visual ports, no frame-only features.
  "/dashboard/customers",
  "/dashboard/profile",
  // UI batch 2 · tools: analytics, history, organisation settings and automation & WhatsApp
  // (rules, rule editor, message log, connection), ported to the GX frames D-P01/02, F-P01, E-P01…04.
  "/dashboard/analytics",
  "/dashboard/history",
  "/dashboard/settings",
  "/dashboard/automation",
  // Finance · cash & budget (UI batch 2, track finance): the six areas under /dashboard/finance,
  // ported to the GX B-P01…B-P07 frames (Figma 1JbZgpMqmPkUVne8ms9Ozz).
  "/dashboard/finance",
  // Accounting: a placeholder («نظام المحاسبة قيد التطوير») until the deferred module is built.
  "/dashboard/accounting",
];

export function usesDirection21(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return DIRECTION_21_ROUTES.some((r) =>
    typeof r === "string" ? pathname === r || pathname.startsWith(r + "/") : r.test(pathname),
  );
}
