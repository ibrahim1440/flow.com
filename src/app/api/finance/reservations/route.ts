import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { listReservations, createReservation } from "@/lib/finance/server/allocation";

export const GET = financeHandler(undefined, ({ scope, query }) => listReservations(prisma, scope, query.get("status") ?? undefined));

export const POST = financeHandler("allocate", async ({ actor, scope, request }) => createReservation(actor, scope, await readJson(request)), 201);
