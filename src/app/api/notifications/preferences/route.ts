import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { preferences, savePreferences } from "@/lib/notifications/service";

/**
 * GET /api/notifications/preferences — the person's own e-mail choice per category (in-app is always
 * on), with each category's default. PUT { email: { sales: true, me: false, … } } saves them.
 * «ملفي» › «التنبيهات». Own account only — no id in the request.
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  try {
    return NextResponse.json({ categories: await preferences(user.id) });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return NextResponse.json({ categories: await savePreferences(user.id, b) });
  } catch (err) {
    return handleDomainError(err);
  }
}
