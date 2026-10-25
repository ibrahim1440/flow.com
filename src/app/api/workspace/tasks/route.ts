import { wsRoute } from "@/lib/workspace/server/http";
import { createTask, listTasks } from "@/lib/workspace/server/tasks";

/**
 * GET /api/workspace/tasks — ?scope=mine|assigned|watching|review|team|member &member= &status= &priority=
 * &due=overdue|today|week &q= &cursor= &limit= (see listTasks). Only tasks the caller may see.
 * POST — create: { title, assigneeId?, due: { quick, basis } | dueAt, priority?, kind?, channel?, … }.
 */
export const GET = wsRoute(({ actor, query }) => listTasks(actor, {
  scope: query.get("scope"), status: query.get("status"), priority: query.get("priority"), due: query.get("due"),
  q: query.get("q"), member: query.get("member"), cursor: query.get("cursor"), limit: Number(query.get("limit")) || undefined,
}));
export const POST = wsRoute(({ actor, body }) => createTask(actor, body), { status: 201 });
