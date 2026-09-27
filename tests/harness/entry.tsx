/**
 * Component harness — mounts the REAL Sales screens with the network stubbed.
 *
 * These are the production components, imported from src/app. Nothing here re-implements a
 * screen; the only things replaced are the four edges a browser cannot supply offline:
 *
 *   - `fetch`, which answers from a fixture table set by the test
 *   - `next/navigation`, so route params and the router exist
 *   - the i18n and user contexts, which normally come from a server-rendered provider
 *
 * ── What this can and cannot show ──
 * It can show layout, reflow, RTL, overflow, keyboard reachability, and every state the
 * component derives from a response — loading, empty, error, validation, permission-hidden
 * controls. It CANNOT show that any request is authorised, that anything persists, or that
 * the server would have answered the way the fixture does. Those are integration questions
 * and this file proves nothing about them.
 */
import React from "react";
import { createRoot } from "react-dom/client";

import PipelinePage from "../../src/app/dashboard/sales/pipeline/page";
import LeadDetailPage from "../../src/app/dashboard/sales/leads/[id]/page";
import MyCommissionsPage from "../../src/app/dashboard/sales/my-commissions/page";
import QuoteEditorPage from "../../src/app/dashboard/sales/quotes/[id]/page";
import LeadsListPage from "../../src/app/dashboard/sales/leads/page";
import QuotesListPage from "../../src/app/dashboard/sales/quotes/page";
import DealDetailPage from "../../src/app/dashboard/sales/deals/[id]/page";
import ActivitiesPage from "../../src/app/dashboard/sales/activities/page";
import TargetsPage from "../../src/app/dashboard/sales/targets/page";
import ReportsPage from "../../src/app/dashboard/sales/reports/page";
import SalesSettingsPage from "../../src/app/dashboard/sales/settings/page";
import ReviewPage from "../../src/app/dashboard/commissions/review/page";
import PlansPage from "../../src/app/dashboard/commissions/plans/page";
import QuotePrintPage from "../../src/app/dashboard/sales/quotes/[id]/print/page";
import CollectionsPage from "../../src/app/dashboard/sales/collections/page";


declare global {
  interface Window {
    __ROUTES__: Record<string, { status?: number; body?: unknown; delayMs?: number }>;
    __CALLS__: { method: string; url: string; body?: unknown }[];
    __USER__: unknown;
    mountScreen: (name: string) => void;
  }
}

window.__CALLS__ = [];
window.__ROUTES__ = window.__ROUTES__ ?? {};

/**
 * Fixture-backed fetch.
 *
 * Matched by substring so a test can key on "/api/sales/leads/" without reproducing query
 * strings. Every call is recorded, which is how the double-submit and no-duplicate checks
 * are made in the browser rather than only in the unit suite.
 */
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  let parsed: unknown;
  try { parsed = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { parsed = init?.body; }
  window.__CALLS__.push({ method, url, body: parsed });

  // A method-qualified key wins over a bare path, so a fixture can make GET succeed and
  // PATCH fail on the same URL — which is exactly the half-written-schedule case.
  const keys = Object.keys(window.__ROUTES__);
  const matches = (k: string) => {
    const [maybeMethod, maybePath] = k.includes(" ") ? k.split(" ") : [null, k];
    if (maybeMethod && maybeMethod !== method) return false;
    return url.includes(maybePath);
  };
  const key = keys.filter((k) => k.includes(" ")).find(matches)
    ?? keys.filter((k) => !k.includes(" ")).find(matches);
  const hit = key ? window.__ROUTES__[key] : undefined;
  if (hit?.delayMs) await new Promise((r) => setTimeout(r, hit.delayMs));
  const status = hit?.status ?? (hit ? 200 : 404);
  const body = hit?.body ?? { error: "no fixture for " + method + " " + url };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const SCREENS: Record<string, () => React.ReactElement> = {
  pipeline: () => <PipelinePage />,
  "leads-list": () => <LeadsListPage />,
  "lead-detail": () => <LeadDetailPage />,
  commissions: () => <MyCommissionsPage />,
  // The editor takes params as a promise, the way Next hands them over.
  "quote-editor": () => <QuoteEditorPage params={Promise.resolve({ id: "q1" })} />,
  "quotes-list": () => <QuotesListPage />,
  "deal-detail": () => <DealDetailPage params={Promise.resolve({ id: "d1" })} />,
  activities: () => <ActivitiesPage />,
  targets: () => <TargetsPage />,
  reports: () => <ReportsPage />,
  settings: () => <SalesSettingsPage />,
  review: () => <ReviewPage />,
  plans: () => <PlansPage />,
  "quote-print": () => <QuotePrintPage params={Promise.resolve({ id: "q1" })} />,
  collections: () => <CollectionsPage />,
};

window.mountScreen = (name: string) => {
  const el = document.getElementById("root")!;
  const Screen = SCREENS[name];
  if (!Screen) throw new Error("unknown screen: " + name);
  createRoot(el).render(
    <React.StrictMode>
      <div className="p-4">{Screen()}</div>
    </React.StrictMode>,
  );
};
