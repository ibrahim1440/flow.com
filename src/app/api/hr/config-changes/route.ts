import { hrHandler } from "@/lib/hr/http";
import { listConfigChanges } from "@/lib/hr/services/config-change";

export const GET = hrHandler(async ({ actor, query }) => listConfigChanges(actor, { status: query.get("status") }));
