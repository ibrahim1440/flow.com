import { route, readJson } from "@/lib/marketing/server/http";
import { reviewText } from "@/lib/marketing/server/ai";

export const maxDuration = 120;

export const POST = route("ai_use", async (req, { actor }) => reviewText(await readJson(req), actor));
