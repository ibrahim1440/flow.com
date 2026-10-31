// Batch 26 (gate G3): the admin / training resets clear the credit log and the customer-bound commission log ONLY through
// audit_reset_purge() (migration 20261209090000_audit_append_only). The runtime role may execute it only on a training /
// demo database granted with `grant-app-runtime.sql -v allow_reset=1`; in production it holds no EXECUTE. The routes ask
// first, so a database without the grant answers a clear refusal before anything is deleted (the transaction would roll
// back anyway), and the function's own refusals are answered in Arabic too.
import { NextResponse } from "@/lib/api-response";

type QueryDb = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> };

export const AUDIT_RESET_UNAVAILABLE = {
  error: "إعادة الضبط غير متاحة على قاعدة البيانات هذه: مسح سجل الائتمان وسجل العمولات غير مفعّل لها (يُفعَّل لقواعد التدريب والعرض فقط). ما انحذف شيء.",
  errorEn: "Reset is not available on this database: clearing the credit and commission logs is not enabled for it (training / demo databases only). Nothing was deleted.",
  code: "AUDIT_RESET_UNAVAILABLE",
} as const;

export const AUDIT_RESET_ACTOR_REFUSED = {
  error: "قاعدة البيانات رفضت إعادة الضبط: الحساب لازم يكون مديرًا نشطًا أو عنده صلاحية إعادة الضبط. ما انحذف شيء.",
  errorEn: "The database refused the reset: the account must be an active administrator or hold the reset permission. Nothing was deleted.",
  code: "AUDIT_RESET_ACTOR",
} as const;

/** null when this connection may run audit_reset_purge(); otherwise the 503 refusal to return as is. */
export async function auditResetUnavailable(db: QueryDb): Promise<NextResponse | null> {
  const rows = await db.$queryRaw<{ ok: boolean | null }[]>`SELECT coalesce(has_function_privilege(to_regprocedure('audit_reset_purge(text,text,text)'), 'EXECUTE'), false) AS ok`;
  return rows[0]?.ok ? null : NextResponse.json(AUDIT_RESET_UNAVAILABLE, { status: 503 });
}

/** The refusal for an error raised by audit_reset_purge() inside the reset transaction, or null for any other error. */
export function auditResetErrorResponse(err: unknown): NextResponse | null {
  const text = [
    (err as { message?: unknown })?.message,
    JSON.stringify((err as { meta?: unknown })?.meta ?? null),
  ].filter((x) => typeof x === "string").join(" ");
  if (!text.includes("audit_reset_purge") && !text.includes("AUDIT_RESET")) return null;
  if (text.includes("AUDIT_RESET: the actor")) return NextResponse.json(AUDIT_RESET_ACTOR_REFUSED, { status: 403 });
  if (/permission denied for function audit_reset_purge|function audit_reset_purge\(.*\) does not exist|42501|42883/.test(text)) {
    return NextResponse.json(AUDIT_RESET_UNAVAILABLE, { status: 503 });
  }
  return null;
}
