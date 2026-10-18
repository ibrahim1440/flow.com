import { hrHandler } from "@/lib/hr/http";
import { activateContract } from "@/lib/hr/services/contracts";

export const POST = hrHandler(async ({ actor, params }) => activateContract(actor, params.id, params.cid));
