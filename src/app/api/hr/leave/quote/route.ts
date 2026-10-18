import { hrHandler } from "@/lib/hr/http";
import { quoteLeave } from "@/lib/hr/services/leave";
import { toArabic } from "@/lib/hr/messages-ar";

// Read-only preview for HR filing on someone's behalf: leave_manage and the person in scope.
export const GET = hrHandler(async ({ actor, query }) => {
  const q = await quoteLeave(actor, query);
  return { ...q, problems: q.problems.map((x) => ({ code: x.code, error: toArabic(x.message) ?? x.message, errorEn: x.message })) };
});
