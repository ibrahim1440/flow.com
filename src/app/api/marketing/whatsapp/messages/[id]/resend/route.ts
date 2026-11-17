import { route } from "@/lib/marketing/server/http";
import { resendAfterReview } from "@/lib/marketing/server/messaging";

/** POST { confirm: true } — «إعادة الإرسال بعد المراجعة»: a new message linked to the original, after «لم تصل», within 24 h. */
export const POST = route<{ id: string }>("messaging_manage", async (req, { actor, params }) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const m = await resendAfterReview(params.id, body, actor);
  return { message: { id: m.id, status: m.status, resendOfMessageId: m.resendOfMessageId } };
});
