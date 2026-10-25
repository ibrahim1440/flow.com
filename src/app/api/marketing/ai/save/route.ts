import { route, readJson, strList, MktError } from "@/lib/marketing/server/http";
import { createPost } from "@/lib/marketing/server/posts";
import { createCopyAsset } from "@/lib/marketing/server/assets";

/**
 * Keep a generated variant: as a DRAFT post (aiGenerated — its publication follows the AI-content
 * approval policy, on by default) or as a copy asset in the library. Nothing is published from here.
 */
export const POST = route(["ai_use"], async (req, { actor }) => {
  const b = await readJson(req);
  if (b.as === "post") return createPost({ ...b, platforms: strList(b.platforms, "المنصات", 12) }, actor, { aiGenerated: true });
  if (b.as === "asset") return createCopyAsset({ ...b, tags: [...strList(b.tags, "الوسوم", 20), "ai"] }, actor, { aiGenerated: true });
  throw new MktError("حدد الحفظ كمنشور أو كمادة نصية.", "as must be post or asset.");
});
