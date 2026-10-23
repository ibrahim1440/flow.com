import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { interviewInvite, interviewInviteLog } from "@/lib/hr/services/hr-email";

// «إرسال دعوة مقابلة» (hr › recruit): GET the sent log; POST { action: "preview" | "send", interviewId?,
// location?, contactName?, contactPhone?, note? }. Without a configured provider the preview still renders
// and a send is recorded as NOT_CONFIGURED («البريد غير مفعّل بعد»).
export const GET = hrHandler(async ({ actor, params }) => interviewInviteLog(actor, params.id));
export const POST = hrHandler(async ({ actor, request, params }) => interviewInvite(actor, params.id, await readJson(request)));
