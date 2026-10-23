import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireAuth, requireSub, forbidden } from "@/lib/auth-server";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { readRoastRequestKey } from "@/lib/services/roast-idempotency";
import { listExceptions, requestException } from "@/lib/services/qc/exceptions";

/**
 * GET /api/qc/exceptions — QX-01 «طلبات الاستثناء»: pending first, then decided. The QC module.
 * POST — request one from the ERP (qc › create_record; Idempotency-Key required), as the station does.
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!hasModuleAccess(user.permissions, "qc")) return forbidden();
  try {
    const out = await listExceptions();
    return NextResponse.json({ ...out, canDecide: hasSubPrivilege(user.permissions, "qc", "approve_exception"), me: user.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("qc", "create_record");
  if (error) return error;
  const k = readRoastRequestKey(request);
  if (!k.ok) return NextResponse.json({ error: k.message, errorEn: k.en }, { status: 400 });
  if (!k.key) return NextResponse.json({ error: "مفتاح التكرار مطلوب.", errorEn: "An Idempotency-Key is required.", code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const out = await requestException({ id: user.id, name: user.name }, k.key, body);
    return NextResponse.json(out, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
