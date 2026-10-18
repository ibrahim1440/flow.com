import { hrHandler } from "@/lib/hr/http";
import { employeeProvisions } from "@/lib/hr/services/provisions";

// P-2 rev3 item 4: one employee's provision balances and movements.
export const GET = hrHandler(async ({ actor, params }) => employeeProvisions(actor, params.id));
