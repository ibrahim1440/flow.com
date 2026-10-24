import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { processQueue } from "@/lib/zatca/pipeline";
import { zatcaError } from "@/lib/zatca/refusals";

export const maxDuration = 60;

/** POST /api/accounting/zatca/queue — drain the queue now (what the cron does). accounting › zatca_resubmit. */
export async function POST() {
  const { user, error } = await requireSub("accounting", "zatca_resubmit");
  if (error) return error;
  try {
    const r = await processQueue({ actorId: user.id, budgetMs: 45_000 });
    return NextResponse.json({ ...r, results: r.results.slice(0, 50) });
  } catch (err) {
    return zatcaError(err);
  }
}
