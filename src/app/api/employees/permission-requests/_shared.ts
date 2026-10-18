import { NextResponse } from "next/server";
import { HrError } from "@/lib/hr/core";
import { toArabic } from "@/lib/hr/messages-ar";
import { extractIp, hashRateLimitKey } from "@/lib/rate-limit";

/** Owner decision 1b: the permission-grant approval routes (account editors; see permission-change.ts). */
export function auditContext(request: Request, actorId: string) {
  return { actorId, ipHash: hashRateLimitKey(extractIp(request)), userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null };
}

export function errorResponse(e: unknown) {
  if (e instanceof HrError) return NextResponse.json({ error: toArabic(e.message) ?? e.message, errorEn: e.message, code: e.code }, { status: e.status });
  const d = e as { status?: number; code?: string; message?: string; conflicts?: unknown };
  if (d?.code === "SOD_DUTY_CONFLICT") return NextResponse.json({ error: d.message, code: d.code, conflicts: d.conflicts }, { status: 409 });
  throw e;
}
