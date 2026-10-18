import { hrHandler } from "@/lib/hr/http";
import { completeSeparation } from "@/lib/hr/services/workforce";

export const POST = hrHandler(async ({ actor, params }) => completeSeparation(actor, params.id));
