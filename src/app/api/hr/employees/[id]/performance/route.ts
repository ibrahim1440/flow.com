import { hrHandler } from "@/lib/hr/http";
import { performanceFor } from "@/lib/hr/services/workforce";

export const GET = hrHandler(async ({ actor, params }) => performanceFor(actor, params.id));
