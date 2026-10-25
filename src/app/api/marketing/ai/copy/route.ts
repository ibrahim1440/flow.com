import { route, readJson } from "@/lib/marketing/server/http";
import { generateCopy } from "@/lib/marketing/server/ai";

export const maxDuration = 120;

export const POST = route("ai_use", async (req, { actor }) => generateCopy(await readJson(req), actor));
