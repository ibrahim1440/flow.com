import { route, readJson } from "@/lib/marketing/server/http";
import { audiencePreview, requestMessageCampaign } from "@/lib/marketing/server/messaging";

/** { preview: true, ...spec } answers the audience count; otherwise queues (or requests approval for) the send. */
export const POST = route<{ id: string }>("messaging_manage", async (req, { actor, params }) => {
  const b = await readJson(req);
  if (b.preview === true) {
    const seg = (b.segment ?? {}) as Record<string, unknown>;
    return audiencePreview({ templateId: String(b.templateId ?? ""), segment: { type: seg.type as "OPTED_IN_ALL", sku: (seg.sku as string) ?? null, days: seg.days ? Number(seg.days) : null, phones: seg.phones as string[] | undefined }, scheduledAt: null, link: null });
  }
  return requestMessageCampaign(params.id, b, actor);
});
