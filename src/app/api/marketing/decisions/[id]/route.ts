import { route, readJson } from "@/lib/marketing/server/http";
import { closeDecision } from "@/lib/marketing/server/decisions";

export const PATCH = route<{ id: string }>("campaigns_manage", async (req, { actor, params }) => closeDecision(params.id, await readJson(req), actor));
