import { wsRoute } from "@/lib/workspace/server/http";
import { createOccasion, listOccasions, PREP_STEPS } from "@/lib/workspace/server/occasions";

/** GET ?from=YYYY-MM-DD&to=YYYY-MM-DD (marketing module). POST — marketing › campaigns_manage. */
export const GET = wsRoute(async ({ actor, query }) => {
  const from = new Date(`${query.get("from") ?? "1970-01-01"}T00:00:00Z`), to = new Date(`${query.get("to") ?? "2100-01-01"}T00:00:00Z`);
  return { items: await listOccasions(actor, from, to), prepSteps: PREP_STEPS };
});
export const POST = wsRoute(({ actor, body }) => createOccasion(actor, body), { status: 201 });
