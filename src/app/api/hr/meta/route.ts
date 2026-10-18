import { hrHandler } from "@/lib/hr/http";
import { meta } from "@/lib/hr/services/meta";

export const GET = hrHandler(async ({ actor }) => meta(actor));
