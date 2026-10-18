import { hrHandler } from "@/lib/hr/http";
import { HrError, readJson } from "@/lib/hr/core";
import { prisma } from "@/lib/db";
import { selfPerson } from "@/lib/hr/services/self";
import { cancelLeave } from "@/lib/hr/services/leave";

export const POST = hrHandler(async ({ actor, request, params, today }) => {
  const p = await selfPerson(actor);
  const owns = await prisma.hrLeaveRequest.count({ where: { id: params.id, employeeId: p.id } });
  if (!owns) throw new HrError("Leave request not found", 404);
  return cancelLeave(actor, params.id, await readJson(request), today);
}, { self: true });
