import { route, readJson } from "@/lib/marketing/server/http";
import { listTemplates, saveTemplate } from "@/lib/marketing/server/messaging";

export const GET = route(["messaging_manage", "customers_data"], async () => ({ rows: await listTemplates() }));

export const POST = route("messaging_manage", async (req, { actor }) => saveTemplate(await readJson(req), actor));
