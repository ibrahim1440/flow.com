import { hrHandler } from "@/lib/hr/http";
import { rebuildRun } from "@/lib/hr/services/payroll";

export const POST = hrHandler(async ({ actor, params }) => rebuildRun(actor, params.id));
