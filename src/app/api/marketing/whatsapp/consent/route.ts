import { route, readJson, qp } from "@/lib/marketing/server/http";
import { listConsent, recordConsent } from "@/lib/marketing/server/messaging";

export const GET = route("customers_data", async (req) => {
  const q = qp(req);
  return listConsent({ search: q.get("q"), status: q.get("status") });
});

export const POST = route(["customers_data", "messaging_manage"], async (req, { actor }) => recordConsent(await readJson(req), actor));
