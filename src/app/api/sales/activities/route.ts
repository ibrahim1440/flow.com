import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales } from "@/lib/services/sales/scope";
import { parseActivity, logLeadOrDealActivity } from "@/lib/services/sales/activity-log";

const TYPES = ["CALL", "VISIT", "MEETING", "NOTE", "TASK", "SAMPLE_FOLLOW_UP", "WHATSAPP", "EMAIL"];

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
      // «متأخرة واليوم» (`crm-followups`): everything open that is due by the end of today.
      filter === "due"
        ? { ...base, completedAt: null, dueAt: { lte: endOfRiyadhToday } }
        : filter === "overdue"
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
        // `sort=recent`: the latest completed first, for the «آخر النشاط» feed.
        orderBy: url.searchParams.get("sort") === "recent"
          ? [{ completedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }]
          : [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true, type: true, subject: true, body: true, dueAt: true, completedAt: true, outcome: true,
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

  try {
    // The rules — type, outcome, subject, the lead-or-deal attachment, a task's due date, owner scope,
    // the caller owning the record, and the qualification in the same transaction — live in
    // lib/services/sales/activity-log.ts, shared with the customer composer and the workspace.
    const a = parseActivity(b, { leadOrDeal: true });
    const result = await prisma.$transaction((tx) => logLeadOrDealActivity(tx, { id: user.id, permissions: user.permissions }, a), TX_OPTS);
    // The opportunity comes back so the screen can offer "Open deal" instead of making the
    // person go and look for what just appeared.
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
