import { hrHandler } from "@/lib/hr/http";
import { acknowledgeReview } from "@/lib/hr/services/self";

export const POST = hrHandler(async ({ actor, params }) => acknowledgeReview(actor, params.id), { self: true });
