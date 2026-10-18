import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { createDepartment, listDepartments } from "@/lib/hr/services/people";

export const GET = hrHandler(async ({ actor }) => listDepartments(actor));
export const POST = hrHandler(async ({ actor, request }) => createDepartment(actor, await readJson(request)), { status: 201 });
