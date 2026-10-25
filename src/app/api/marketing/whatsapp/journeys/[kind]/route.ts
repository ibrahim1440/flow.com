import { route, readJson } from "@/lib/marketing/server/http";
import { saveJourney } from "@/lib/marketing/server/messaging";

export const PUT = route<{ kind: string }>("messaging_manage", async (req, { actor, params }) => saveJourney(params.kind, await readJson(req), actor));
