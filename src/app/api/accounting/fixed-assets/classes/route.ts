import { accountingRoute, body } from "@/lib/accounting/http";
import { createClass } from "@/lib/accounting/fixed-assets-service";
import { faClasses } from "@/lib/accounting/fixed-assets-queries";

export const GET = accountingRoute(null, async () => faClasses());
export const POST = accountingRoute("fa_setup", async ({ user, request }) => createClass(await body(request), user.id), 201);
