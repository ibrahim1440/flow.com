import { hrHandler } from "@/lib/hr/http";
import { HrError, readJson } from "@/lib/hr/core";
import { prisma } from "@/lib/db";
import { selfPerson } from "@/lib/hr/services/self";
import { cancelAdvance } from "@/lib/hr/services/advances";

export const POST = hrHandler(async ({ actor, request, params }) => {
  const p = await selfPerson(actor);
  if (!(await prisma.hrAdvance.count({ where: { id: params.id, employeeId: p.id } }))) throw new HrError("Advance not found", 404);
  return cancelAdvance(actor, params.id, await readJson(request));
}, { self: true });
