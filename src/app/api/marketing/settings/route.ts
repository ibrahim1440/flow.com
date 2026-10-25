import { route, readJson } from "@/lib/marketing/server/http";
import { getAll, saveSettings } from "@/lib/marketing/server/settings-service";

export const GET = route(undefined, async () => getAll());

export const PUT = route("automation_manage", async (req, { actor }) => saveSettings(await readJson(req), actor));
