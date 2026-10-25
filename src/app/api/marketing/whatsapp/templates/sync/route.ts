import { route } from "@/lib/marketing/server/http";
import { syncTemplates } from "@/lib/marketing/server/messaging";

export const POST = route("messaging_manage", async (_req, { actor }) => syncTemplates(actor));
