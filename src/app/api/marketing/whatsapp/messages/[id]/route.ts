import { route } from "@/lib/marketing/server/http";
import { cancelMessage } from "@/lib/marketing/server/messaging";

export const DELETE = route<{ id: string }>("messaging_manage", async (_req, { actor, params }) => {
  await cancelMessage(params.id, actor);
  return { ok: true };
});
