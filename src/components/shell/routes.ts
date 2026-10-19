/**
 * Which dashboard routes render inside the Direction 2.1 shell.
 *
 * The shell itself is shared and registry-driven; a module moves onto it once its own
 * screens have been brought to Direction 2.1, so that no page shows Direction 2.1
 * navigation around legacy content (or the reverse). HR and employee self-service were
 * designed in Direction 2.1 from the start, and operations followed in migration phase 1
 * (whole prefixes), and stock (inventory, purchases, products) in phase 2. The CRM routes of implementation
 * batch 0/1 were rebuilt to their frames one route at a time, so they are listed as anchored,
 * segment-exact patterns: `/dashboard/sales/leads/123` is the lead page, but
 * `/dashboard/sales/quotes/…` (the editor, not migrated) never matches by prefix accident.
 *
 * Every other module keeps the legacy shell until its screens are migrated — adding its
 * prefix or pattern here is the whole switch.
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
  // UI batch 1 (module B): the quotations LIST only (frame 181:1609). The editor, the issued
  // quotation and the print view (`quotes/new`, `quotes/[id]`, `quotes/[id]/print`) have no
  // approved frame yet and keep the legacy shell; this pattern cannot match them.
  /^\/dashboard\/sales\/quotes\/?$/,
  // Labels and the print subsystem (G-20 / G-21), designed in Direction 2.1.
  "/dashboard/labels",
  // Stock (migration phase 2, UI batch 1 · module A): inventory, purchases and products, ported
  // to the frozen Phase 3 frames (Figma page 216:2, docs/design/direction-2.1-rc/INVENTORY.md).
  "/dashboard/inventory",
  "/dashboard/purchases",
  "/dashboard/products",
  // Users & permissions (UI batch 1): a visual-only port of the legacy screen.
  "/dashboard/employees",
];

export function usesDirection21(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return DIRECTION_21_ROUTES.some((r) =>
    typeof r === "string" ? pathname === r || pathname.startsWith(r + "/") : r.test(pathname),
  );
}
