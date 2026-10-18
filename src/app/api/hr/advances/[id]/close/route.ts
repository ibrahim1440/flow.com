import { hrHandler } from "@/lib/hr/http";
import { closeAdvance } from "@/lib/hr/services/advances";

export const POST = hrHandler(async ({ actor, params }) => closeAdvance(actor, params.id));
