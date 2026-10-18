import { hrHandler } from "@/lib/hr/http";
import { dayBoard } from "@/lib/hr/services/attendance";

export const GET = hrHandler(async ({ actor, query, now }) => dayBoard(actor, query.get("day"), now));
