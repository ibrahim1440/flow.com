import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { separationNotice, separationNoticeLog } from "@/lib/hr/services/hr-email";

// «إشعار إنهاء الخدمة» (hr › offboard): GET the sent log; POST { action: "preview" | "send", note?,
// useCompanyEmail? } — to the personal e-mail, the company e-mail only when confirmed.
export const GET = hrHandler(async ({ actor, params }) => separationNoticeLog(actor, params.id));
export const POST = hrHandler(async ({ actor, request, params }) => separationNotice(actor, params.id, await readJson(request)));
