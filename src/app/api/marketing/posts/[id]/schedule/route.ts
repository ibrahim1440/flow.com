import { route, readJson } from "@/lib/marketing/server/http";
import { reschedulePost } from "@/lib/marketing/server/posts";

export const POST = route<{ id: string }>("content_manage", async (req, { actor, params }) => reschedulePost(params.id, await readJson(req), actor));
