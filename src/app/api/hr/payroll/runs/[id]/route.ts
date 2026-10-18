import { hrHandler } from "@/lib/hr/http";
import { getRun } from "@/lib/hr/services/payroll";

export const GET = hrHandler(async ({ actor, params }) => getRun(actor, params.id));
