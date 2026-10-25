import { route, readJson } from "@/lib/marketing/server/http";
import { generatePlan } from "@/lib/marketing/server/ai";

export const maxDuration = 300;

export const POST = route("ai_use", async (req, { actor }) => generatePlan(await readJson(req), actor));
