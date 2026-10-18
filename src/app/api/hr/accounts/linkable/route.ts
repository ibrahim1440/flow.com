import { hrHandler } from "@/lib/hr/http";
import { linkableAccounts } from "@/lib/hr/services/people";

export const GET = hrHandler(async ({ actor }) => linkableAccounts(actor));
