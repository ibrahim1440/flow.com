import { route, readJson, str } from "@/lib/marketing/server/http";
import { submitPost } from "@/lib/marketing/server/posts";

export const POST = route<{ id: string }>("publish", async (req, { actor, params }) => {
  const b = await readJson(req).catch(() => ({} as Record<string, unknown>));
  return submitPost(params.id, actor, str(b.note, "ملاحظة", { max: 500 }));
});
