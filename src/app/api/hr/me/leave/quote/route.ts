import { hrHandler } from "@/lib/hr/http";
import { selfPerson } from "@/lib/hr/services/self";
import { quoteLeave } from "@/lib/hr/services/leave";
import { toArabic } from "@/lib/hr/messages-ar";

// Read-only: the subject is always the caller's own linked record, never a parameter.
export const GET = hrHandler(async ({ actor, query }) => {
  const p = await selfPerson(actor);
  const q = await quoteLeave(actor, query, { selfEmployeeId: p.id });
  return { ...q, problems: q.problems.map((x) => ({ code: x.code, error: toArabic(x.message) ?? x.message, errorEn: x.message })) };
}, { self: true });
