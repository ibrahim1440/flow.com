import { route, readJson, qp } from "@/lib/marketing/server/http";
import { listBudgets, saveBudget } from "@/lib/marketing/server/budgets";
import { loadSettings } from "@/lib/marketing/server/settings";

export const GET = route(["budget_manage", "revenue_view"], async (req) => {
  const s = await loadSettings();
  const period = qp(req).get("period") ?? new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone, year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  return listBudgets(period);
});

export const POST = route("budget_manage", async (req, { actor }) => saveBudget(await readJson(req), actor));
