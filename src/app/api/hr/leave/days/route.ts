import { hrHandler } from "@/lib/hr/http";
import { previewDays } from "@/lib/hr/services/leave";

export const GET = hrHandler(async ({ query }) => previewDays(query.get("start"), query.get("end")));
