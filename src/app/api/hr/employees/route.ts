import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { createPerson } from "@/lib/hr/services/people";

export const POST = hrHandler(async ({ actor, request }) => createPerson(actor, await readJson(request)), { status: 201 });
