import { route } from "@/lib/marketing/server/http";
import { listJourneys } from "@/lib/marketing/server/messaging";

export const GET = route(["messaging_manage", "customers_data"], async () => ({ rows: await listJourneys() }));
