import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales } from "@/lib/services/sales/scope";

const TYPES = ["CALL", "VISIT", "MEETING", "NOTE", "TASK", "SAMPLE_FOLLOW_UP"];

/**
 * GET /api/sales/activities — the follow-up list.
 *
 * This is the screen a salesperson actually lives in: what is overdue, what is due today,
 * what is coming. So the filter the client asks for is applied in SQL and the counts come
 * back with it, rather than the client fetching everything and counting in the browser —
 * which would be wrong the moment the list is paginated.
 *
 * Scoped to the caller's own activities unless they may see the whole pipeline. A manager
 * looking at the team's follow-ups is a legitimate view; a rep browsing a colleague's call
 * notes is not.
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "open";
  const type = url.searchParams.get("type");
  const leadId = url.searchParams.get("leadId");
  const opportunityId = url.searchParams.get("opportunityId");
  const perPage = Math.min(200, Math.max(1, Number(url.searchParams.get("perPage") ?? 50) || 50));
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  const scopeAll = seesAllSales(user.permissions);
  const mineOnly = url.searchParams.get("scope") === "mine" || !scopeAll;

  const now = new Date();
  // "Today" in Riyadh, because that is the day the person filling this in is living in. Using
  // the server's UTC day puts the last three hours of every evening on tomorrow's list.
  const riyadhNow = new Date(now.getTime() + 3 * 3600_000);
  const endOfRiyadhToday = new Date(
    Date.UTC(riyadhNow.getUTCFullYear(), riyadhNow.getUTCMonth(), riyadhNow.getUTCDate(), 21, 0, 0, 0),
  );

  try {
    const base = {
      ...(mineOnly ? { ownerId: user.id } : {}),
      ...(type && TYPES.includes(type) ? { type: type as never } : {}),
      ...(leadId ? { leadId } : {}),
      ...(opportunityId ? { opportunityId } : {}),
    };

    const where =
      filter === "overdue"
        ? { ...base, completedAt: null, dueAt: { lt: now } }
        : filter === "today"
          ? { ...base, completedAt: null, dueAt: { gte: now, lte: endOfRiyadhToday } }
          : filter === "done"
            ? { ...base, completedAt: { not: null } }
            : filter === "all"
              ? base
              : { ...base, completedAt: null };

    const [rows, total, overdue, dueToday, open] = await Promise.all([
      prisma.activity.findMany({
        where,
        orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true, type: true, subject: true, body: true, dueAt: true, completedAt: true,
          createdAt: true,
          owner: { select: { id: true, name: true } },
          lead: { select: { id: true, companyName: true, status: true } },
          opportunity: { select: { id: true, title: true, outcome: true } },
          customer: { select: { id: true, name: true } },
        },
      }),
      prisma.activity.count({ where }),
      prisma.activity.count({ where: { ...base, completedAt: null, dueAt: { lt: now } } }),
      prisma.activity.count({
        where: { ...base, completedAt: null, dueAt: { gte: now, lte: endOfRiyadhToday } },
      }),
      prisma.activity.count({ where: { ...base, completedAt: null } }),
    ]);

    return NextResponse.json({
      rows,
      page,
      perPage,
      total,
      counts: { overdue, dueToday, open },
      scope: mineOnly ? "own" : "all",
      canSeeTeam: scopeAll,
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * POST /api/sales/activities — log a call, visit, note, or set a task.
 *
 * ── This records that contact happened. It does not make contact. ──
 * Nothing here sends an email, an SMS or a WhatsApp message, and no field implies it does.
 * A CRM that logs "sent" without sending is worse than one that logs nothing, because the
 * rep stops chasing.
 *
 * The activity must attach to a lead or a deal the caller may actually see — otherwise
 * posting a note would be a way to confirm that another rep's deal id exists.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const type = typeof b.type === "string" && TYPES.includes(b.type) ? b.type : null;
  if (!type) {
    return NextResponse.json({ error: "type must be one of: " + TYPES.join(", ") }, { status: 400 });
  }
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  if (subject.length < 2) {
    return NextResponse.json({ error: "An activity needs a subject." }, { status: 400 });
  }

  const leadId = typeof b.leadId === "string" && b.leadId ? b.leadId : null;
  const opportunityId = typeof b.opportunityId === "string" && b.opportunityId ? b.opportunityId : null;
  if (!leadId && !opportunityId) {
    return NextResponse.json(
      { error: "An activity attaches to a lead or a deal. Say which." },
      { status: 400 },
    );
  }

  let dueAt: Date | null = null;
  if (typeof b.dueAt === "string" && b.dueAt) {
    dueAt = new Date(b.dueAt);
    if (Number.isNaN(dueAt.getTime())) {
      return NextResponse.json({ error: "dueAt is not a date." }, { status: 400 });
    }
  }
  if (type === "TASK" && !dueAt) {
    // A task with no due date never appears on an overdue list and is therefore never done.
    return NextResponse.json({ error: "A task needs a due date." }, { status: 400 });
  }

  const scopeAll = seesAllSales(user.permissions);

  try {
    let customerId: string | null = null;

    if (leadId) {
      const lead = await prisma.lead.findFirst({
        where: { id: leadId, ...(scopeAll ? {} : { ownerId: user.id }) },
        select: { id: true, conversion: { select: { customerId: true } } },
      });
      if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 });
      customerId = lead.conversion?.customerId ?? null;
    }
    if (opportunityId) {
      const deal = await prisma.opportunity.findFirst({
        where: { id: opportunityId, ...(scopeAll ? {} : { ownerId: user.id }) },
        select: { id: true, customerId: true },
      });
      if (!deal) return NextResponse.json({ error: "Deal not found." }, { status: 404 });
      customerId = customerId ?? deal.customerId;
    }

    const activity = await prisma.activity.create({
      data: {
        type: type as never,
        subject,
        body: typeof b.body === "string" ? b.body.trim() || null : null,
        leadId,
        opportunityId,
        customerId,
        dueAt,
        // Completing at creation is the ordinary case for a call that just happened.
        completedAt: b.completed === true ? new Date() : null,
        // Never taken from the request. The person logging the call owns the record of it.
        ownerId: user.id,
      },
      select: {
        id: true, type: true, subject: true, dueAt: true, completedAt: true, createdAt: true,
      },
    });

    return NextResponse.json({ activity }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
