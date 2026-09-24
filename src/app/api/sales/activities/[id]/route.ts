import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/sales/activities/[id] — complete a task, reopen it, or correct its wording.
 *
 * Ownership is the gate, and it is stricter than the read scope on purpose: a manager who
 * may SEE the team's follow-ups still does not get to tick off somebody else's visit as
 * done. That is a record of what a person did, and only they can say it happened.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  try {
    const existing = await prisma.activity.findUnique({
      where: { id },
      select: { id: true, ownerId: true, completedAt: true, type: true },
    });
    if (!existing) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    if (existing.ownerId !== user.id) {
      return NextResponse.json(
        {
          error: seesAllSales(user.permissions)
            ? "This activity belongs to another employee. Only they can complete or edit it."
            : NOT_FOUND_MESSAGE,
        },
        { status: seesAllSales(user.permissions) ? 403 : 404 },
      );
    }

    const data: Record<string, unknown> = {};

    if (b.completed === true) {
      // Idempotent: completing an already-completed task keeps the original timestamp rather
      // than moving it, so "when did you visit" stays answerable after a stray second click.
      if (!existing.completedAt) data.completedAt = new Date();
    } else if (b.completed === false) {
      data.completedAt = null;
    }

    if (typeof b.subject === "string") {
      const v = b.subject.trim();
      if (v.length < 2) throw { _appCode: 400, message: "An activity needs a subject." };
      data.subject = v;
    }
    if (typeof b.body === "string") data.body = b.body.trim() || null;

    if (b.dueAt === null) {
      if (existing.type === "TASK") {
        throw { _appCode: 400, message: "A task needs a due date. Complete it instead of clearing the date." };
      }
      data.dueAt = null;
    } else if (typeof b.dueAt === "string" && b.dueAt) {
      const d = new Date(b.dueAt);
      if (Number.isNaN(d.getTime())) throw { _appCode: 400, message: "dueAt is not a date." };
      data.dueAt = d;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    const activity = await prisma.activity.update({
      where: { id },
      data,
      select: { id: true, type: true, subject: true, body: true, dueAt: true, completedAt: true },
    });

    return NextResponse.json({ activity });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** DELETE /api/sales/activities/[id] — remove a note logged in error. Own records only. */
export async function DELETE(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;
  const { id } = await params;

  try {
    const existing = await prisma.activity.findUnique({
      where: { id },
      select: { id: true, ownerId: true, completedAt: true },
    });
    if (!existing) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    if (existing.ownerId !== user.id) {
      return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    }
    if (existing.completedAt) {
      // A completed activity is a record of something that happened. Deleting it edits
      // history; leaving it is the honest option.
      return NextResponse.json(
        { error: "A completed activity is part of the record and cannot be deleted." },
        { status: 409 },
      );
    }

    await prisma.activity.delete({ where: { id } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handleDomainError(err);
  }
}
