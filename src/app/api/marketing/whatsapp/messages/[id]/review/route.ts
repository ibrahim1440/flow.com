import { route } from "@/lib/marketing/server/http";
import { reviewMessage } from "@/lib/marketing/server/messaging";

/** POST { outcome: DELIVERED | NOT_DELIVERED | UNCERTAIN, note } — «تسجيل نتيجة التحقق» on a campaign message that may have been delivered. */
export const POST = route<{ id: string }>("messaging_manage", async (req, { actor, params }) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return { review: await reviewMessage(params.id, body, actor) };
});
