import { route, readJson } from "@/lib/marketing/server/http";
import { setKill } from "@/lib/marketing/server/settings-service";

/** { scope: "all" | "publishing" | "ads" | "messaging", on: boolean, reason } — takes effect before the next external call. */
export const POST = route("automation_manage", async (req, { actor }) => setKill(await readJson(req), actor));
