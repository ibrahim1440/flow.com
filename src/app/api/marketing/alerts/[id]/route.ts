import { route, readJson, MktError, can, denied } from "@/lib/marketing/server/http";
import { prisma } from "@/lib/db";

/** { action: "ack" | "resolve" } */
export const POST = route<{ id: string }>(undefined, async (req, { actor, params }) => {
  if (!["campaigns_manage", "content_manage", "automation_manage", "budget_manage"].some((k) => can(actor, k))) throw denied();
  const b = await readJson(req);
  if (b.action !== "ack" && b.action !== "resolve") throw new MktError("الإجراء غير معروف.", "Unknown action.");
  await prisma.mktAlert.update({ where: { id: params.id }, data: b.action === "ack" ? { status: "ACKNOWLEDGED" } : { status: "RESOLVED", resolvedAt: new Date(), resolvedById: actor.id } });
  return { ok: true };
});
