import { route, rangeOf } from "@/lib/marketing/server/http";
import { commandCenter } from "@/lib/marketing/server/overview";

export const dynamic = "force-dynamic";

export const GET = route(undefined, async (req, { actor }) => {
  const { from, to } = rangeOf(req, 30);
  return commandCenter(from, to, actor);
});
