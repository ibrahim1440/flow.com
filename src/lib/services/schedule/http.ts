// Request helpers of the schedule routes (/api/production/schedule/**).
import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { ScheduleError, scheduleCan, type ScheduleCan } from "./schedule-db";
import { riyadhKey } from "./planner";

/** The signed-in viewer who may see the schedule (the production module; the administrator holds it), with what they may do. */
export async function requireScheduleView() {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, can: null as never, error };
  const can = scheduleCan(user);
  if (!can.view) return { user: null as never, can: null as never, error: forbidden() };
  return { user, can, error: null };
}

export function scheduleError(err: unknown): NextResponse {
  if (err instanceof ScheduleError) return NextResponse.json(err.body(), { status: err.status });
  return handleDomainError(err);
}

export async function readJson(request: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    const b = await request.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch { /* fall through */ }
  return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
}

/** «2026-10-06», or today in Riyadh. */
export function dayParam(v: string | null, now = new Date()): string | null {
  if (!v) return riyadhKey(now);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null;
}

export const actorOf = (user: { id: string; name?: string | null }, can: ScheduleCan) => ({ id: user.id, name: user.name ?? null, can });
