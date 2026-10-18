import { hrHandler } from "@/lib/hr/http";
import { clearance } from "@/lib/hr/services/workforce";

export const GET = hrHandler(async ({ actor, params }) => clearance(actor, params.id));
