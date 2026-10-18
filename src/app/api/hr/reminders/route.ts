import { hrHandler } from "@/lib/hr/http";
import { reminders } from "@/lib/hr/services/people";
import { assertCan } from "@/lib/hr/core";
const assertDirectory = async (a: Parameters<typeof assertCan>[0]) => assertCan(a, "directory");

export const GET = hrHandler(async ({ actor, today }) => assertDirectory(actor).then(() => reminders(actor, null, today)));
