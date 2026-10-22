import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { readRoastRequestKey } from "@/lib/services/roast-idempotency";

/**
 * Every station API: an ordinary ERP session (W1 has no device or station PIN — that is W2) and
 * production › start_batch, the sub-privilege «تسجيل دفعة» itself requires. The server computes
 * everything; the station sends raw inputs only.
 */
export async function requireStation() {
  return requireSub("production", "start_batch");
}

/** Station writes must carry an Idempotency-Key (S6: the status of an interrupted write is asked by key). */
export function requiredKey(request: Request): { key: string; error: null } | { key: null; error: NextResponse } {
  const r = readRoastRequestKey(request);
  if (!r.ok) return { key: null, error: NextResponse.json({ error: r.message, errorEn: r.en }, { status: 400 }) };
  if (!r.key) return { key: null, error: NextResponse.json({ error: "مفتاح التكرار مطلوب لكل إجراء من المحطة.", errorEn: "An Idempotency-Key is required for every station action.", code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 }) };
  return { key: r.key, error: null };
}
