import { prisma } from "@/lib/db";
import { accountingRoute, body } from "@/lib/accounting/http";
import { draftProfile } from "@/lib/accounting/einvoice/service";

export const GET = accountingRoute(null, async () => prisma.eInvoiceProfile.findMany({ orderBy: { version: "desc" }, take: 10 }));
export const POST = accountingRoute("einv_profile_prepare", async ({ user, request }) => draftProfile(await body(request), user.id), 201);
