import { accountingRoute, body, query } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { prepareYearEnd, yearEndStatus } from "@/lib/accounting/year-end-service";
import { yearEndCloses } from "@/lib/accounting/fixed-assets-queries";

const yearOf = (v: unknown) => { const y = Number(v); if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new AccountingError("Choose a fiscal year.", 400); return y; };
// Blockers, the closing entry as it would be now, and the closes recorded for the year.
export const GET = accountingRoute(null, async ({ request }) => { const y = yearOf(query(request).get("year")); return { ...(await yearEndStatus(y)), closes: await yearEndCloses(y) }; });
export const POST = accountingRoute("year_close_prepare", async ({ user, request }) => prepareYearEnd(yearOf((await body(request)).year), user.id), 201);
