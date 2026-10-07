import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import type { Prisma } from "@/generated/prisma/client";

const STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED", "CANCELLED"] as const;
const PER_PAGE = 50;

/** The message log, newest first. Filters: status, ruleId, q (a phone or a name). */
export async function GET(request: Request) {
  const { error } = await requireModule("automation");
  if (error) return error;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const ruleId = url.searchParams.get("ruleId");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  const page = Math.max(1, Math.min(1000, Number(url.searchParams.get("page")) || 1));

  const where: Prisma.WhatsAppMessageWhereInput = {};
  if (status && (STATUSES as readonly string[]).includes(status)) where.status = status as (typeof STATUSES)[number];
  if (ruleId) where.ruleId = ruleId;
  if (q) {
    const digits = q.replace(/\D/g, "");
    where.OR = [
      { recipientName: { contains: q, mode: "insensitive" } },
      { ruleName: { contains: q, mode: "insensitive" } },
      ...(digits.length >= 4 ? [{ phone: { contains: digits } }, { intendedPhone: { contains: digits } }] : []),
    ];
  }

  const [rows, total, counts] = await Promise.all([
    prisma.whatsAppMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
      select: {
        id: true,
        ruleId: true,
        ruleName: true,
        eventType: true,
        subjectType: true,
        subjectId: true,
        recipientKind: true,
        recipientName: true,
        phone: true,
        intendedPhone: true,
        body: true,
        status: true,
        statusNote: true,
        scheduledAt: true,
        attempts: true,
        sentAt: true,
        createdAt: true,
      },
    }),
    prisma.whatsAppMessage.count({ where }),
    prisma.whatsAppMessage.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  return NextResponse.json({
    rows,
    page,
    perPage: PER_PAGE,
    total,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  });
}
