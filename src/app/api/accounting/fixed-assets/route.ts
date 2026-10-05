import { accountingRoute, body, query } from "@/lib/accounting/http";
import { assetRegister, saveAsset } from "@/lib/accounting/fixed-assets-service";
import { accountingDate } from "@/lib/accounting/dates";

// The fixed-asset register (as of a date) and registering a new asset (draft).
export const GET = accountingRoute(null, async ({ request }) => { const asOf = query(request).get("asOf"); return assetRegister(asOf ? accountingDate(asOf) : undefined); });
export const POST = accountingRoute("fa_prepare", async ({ user, request }) => saveAsset(await body(request), user.id), 201);
