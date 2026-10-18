import { hrHandler } from "@/lib/hr/http";
import { withdrawLeave } from "@/lib/hr/services/leave";

export const POST = hrHandler(async ({ actor, params }) => withdrawLeave(actor, params.id), { self: true });
