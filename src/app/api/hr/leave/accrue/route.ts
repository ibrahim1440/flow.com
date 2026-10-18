import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { runAccrual } from "@/lib/hr/services/leave";

export const POST = hrHandler(async ({ actor, request }) => runAccrual(actor, String((await readJson(request)).month ?? "")));
