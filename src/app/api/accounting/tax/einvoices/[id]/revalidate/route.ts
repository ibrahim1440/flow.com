import { accountingRoute } from "@/lib/accounting/http";
import { revalidate } from "@/lib/accounting/einvoice/service";

// Re-run the local rules on the stored document (read-only).
export const POST = accountingRoute("einv_generate", async ({ params }) => revalidate(params.id));
