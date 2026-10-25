import { route, qp } from "@/lib/marketing/server/http";
import { listMessages } from "@/lib/marketing/server/messaging";

export const GET = route("customers_data", async (req) => {
  const q = qp(req);
  return listMessages({ status: q.get("status"), search: q.get("q"), page: Math.max(1, Number(q.get("page")) || 1) });
});
