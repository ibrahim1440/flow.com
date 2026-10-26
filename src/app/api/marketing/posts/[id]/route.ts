import { route, readJson, str, qp } from "@/lib/marketing/server/http";
import { cancelPost, getPost, postHistory, readiness, serializePost, updatePost } from "@/lib/marketing/server/posts";
import { prisma } from "@/lib/db";

type P = { id: string };

export const GET = route<P>(undefined, async (_req, { params, user }) => {
  const p = await getPost(params.id);
  const [ready, history, approvals] = await Promise.all([
    readiness(p, user.preferredLanguage === "en" ? "en" : "ar"), postHistory(params.id),
    prisma.mktApproval.findMany({ where: { subjectType: "POST", subjectId: params.id }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  return { post: serializePost(p), readiness: ready, history, approvals };
});

export const PATCH = route<P>("content_manage", async (req, { actor, params }) => updatePost(params.id, await readJson(req), actor));

export const DELETE = route<P>("content_manage", async (req, { actor, params }) => {
  await cancelPost(params.id, actor, str(qp(req).get("reason"), "السبب", { max: 500 }));
  return { ok: true };
});
