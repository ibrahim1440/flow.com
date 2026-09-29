import { accountingRoute, body, query } from "@/lib/accounting/http";
import { createRun } from "@/lib/accounting/fixed-assets-service";
import { runsList, runPreview } from "@/lib/accounting/fixed-assets-queries";

// Runs, or (?preview=<periodId>) what a run for that period would contain now.
export const GET = accountingRoute(null, async ({ request }) => { const p = query(request).get("preview"); return p ? runPreview(p) : runsList(); });
export const POST = accountingRoute("fa_prepare", async ({ user, request }) => createRun(String((await body(request)).periodId ?? ""), user.id), 201);
