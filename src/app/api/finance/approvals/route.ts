import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { approvalQueue } from "@/lib/finance/server/approvals";

export const GET = financeHandler(undefined, ({ actor, scope }) => approvalQueue(prisma, actor, scope));
