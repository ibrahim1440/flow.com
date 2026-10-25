import { route, readJson } from "@/lib/marketing/server/http";
import { deleteBudget, saveBudget } from "@/lib/marketing/server/budgets";

type P = { id: string };

export const PATCH = route<P>("budget_manage", async (req, { actor, params }) => saveBudget(await readJson(req), actor, params.id));

export const DELETE = route<P>("budget_manage", async (_req, { actor, params }) => {
  await deleteBudget(params.id, actor);
  return { ok: true };
});
