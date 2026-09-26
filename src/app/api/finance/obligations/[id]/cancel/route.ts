import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson, reqStr } from "@/lib/finance/server/context";
import { cancelEffects, cancelObligation } from "@/lib/finance/server/obligations";

/** What a cancellation would touch (paid amount kept, requests released) — for the dialog. */
export const GET = financeHandler("budget_prepare", ({ scope, params }) => cancelEffects(prisma, scope, params.id));

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => cancelObligation(actor, scope, params.id, reqStr((await readJson(request)).reason, "Reason", 500)));
