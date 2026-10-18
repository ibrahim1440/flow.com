import { hrHandler } from "@/lib/hr/http";
import { myPrivate } from "@/lib/hr/services/self";

export const GET = hrHandler(async ({ actor }) => myPrivate(actor), { self: true });
