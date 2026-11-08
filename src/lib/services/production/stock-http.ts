import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { canRoastToStock, StockError, type StockActor } from "./stock-orders";

/**
 * The guard of every «تحميص للمخزون» route: a session, then production › roast_to_stock or the admin role. A WRITE by the
 * admin role goes through the admin-role gate (a verified individual, a fresh step-up), as the roaster settings do.
 */
export async function requireRoastToStock(opts: { write?: boolean } = {}): Promise<{ actor: StockActor; error: null } | { actor: null; error: NextResponse }> {
  const { user, error } = await requireAuth();
  if (error) return { actor: null, error };
  if (!canRoastToStock(user)) {
    return { actor: null, error: NextResponse.json({ error: "التحميص للمخزون لمن يملك صلاحيته.", errorEn: "Roasting to stock needs its privilege.", code: "ROAST_TO_STOCK_REQUIRED" }, { status: 403 }) };
  }
  if (opts.write && user.role === "admin") {
    const refused = await requireAdminAction(user, "production.roast_to_stock", { stepUp: true });
    if (refused) return { actor: null, error: refused };
  }
  return { actor: { id: user.id, name: user.name, role: user.role, permissions: user.permissions }, error: null };
}

export async function stockRun<T>(fn: () => Promise<T>, status = 200): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn(), { status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof StockError) return NextResponse.json({ error: err.ar, errorEn: err.en, code: err.code }, { status: err.status });
    return handleDomainError(err);
  }
}
