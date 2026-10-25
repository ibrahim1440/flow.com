import { route, readJson, MktError } from "@/lib/marketing/server/http";
import { confirmManual, retryJob } from "@/lib/marketing/server/publishing";

/** { action: "confirm", url } after a manual publication, or { action: "retry", confirmNotPublished? }. */
export const POST = route<{ variantId: string }>("publish", async (req, { actor, params }) => {
  const b = await readJson(req);
  if (b.action === "confirm") await confirmManual(params.variantId, b, actor);
  else if (b.action === "retry") await retryJob(params.variantId, b, actor);
  else throw new MktError("الإجراء غير معروف.", "Unknown action.");
  return { ok: true };
});
