// The uniform permission model of the Qoyod-parity registers (council decision, integration/qoyod-program):
//   • reads (lists, records, previews, reports, widgets): the accounting module;
//   • maintenance — create, edit and archive of a register's records — the register's own sub-privilege under
//     `accounting`: `budgets`, `deferrals`, `recurring`, `fixed_assets` (adminOnly in scripts/permission-backfill.ts);
//   • every act that writes the GL (post, run, approve, auto-post, reverse) ALSO needs the existing journal duty —
//     `journal_post`, `journal_approve` or `journal_reverse` — through the central gate (a verified individual and a
//     step-up: STEP_UP_KEYS); the segregation-of-duties setting is applied by the services (a self-approval allowed by
//     the setting is recorded as `sodBypass` and listed by sodExceptions()).
// Fixed assets keep their own entry point (./fixed-assets/http.ts, requireFaWrite) — the same rule.
import { NextResponse } from "@/lib/api-response";
import { forbidden, privilegedGate, requireFreshAuth, requireSub } from "@/lib/auth-server";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

type User = Awaited<ReturnType<typeof requireSub>>["user"];
export type RegisterSub = "budgets" | "deferrals" | "recurring" | "fixed_assets";
/** The journal duties a register act may also need. `journal_create` is the document duty of a recurring journal's preparer. */
export type JournalDuty = "journal_create" | "journal_post" | "journal_approve" | "journal_reverse";
const STEPS_UP: ReadonlySet<JournalDuty> = new Set(["journal_post", "journal_approve", "journal_reverse"]);

/** The journal duty through the central gate (identity; a step-up for post / approve / reverse). */
export async function journalDutyGate(user: User, duty: JournalDuty): Promise<NextResponse | null> {
  if (!hasSubPrivilege(user.permissions, "accounting", duty)) return forbidden();
  const refused = await privilegedGate(user, "accounting", duty);
  if (refused) return refused;
  // The gate steps up for the GL duties (STEP_UP_KEYS); explicit here so a change there cannot drop it.
  return STEPS_UP.has(duty) ? requireFreshAuth(user) : null;
}

/** accounting › `sub` (the register's maintenance duty); with `duties`, each of those through the central gate too. */
export async function requireRegisterWrite(sub: RegisterSub, opts: { duties?: (JournalDuty | false | null | undefined)[] } = {}): Promise<{ user: User; error: NextResponse | null }> {
  const { user, error } = await requireSub("accounting", sub);
  if (error) return { user, error };
  for (const d of opts.duties ?? []) {
    if (!d) continue;
    const refused = await journalDutyGate(user, d);
    if (refused) return { user, error: refused };
  }
  return { user, error: null };
}

/**
 * What the viewer may do in each register (the pages draw only these controls; the routes re-check). A GL action is
 * drawn only for a holder of its journal duty (council ruling 5: no 403-only buttons) — `post` / `approve` / `reverse`
 * are the register's sub AND the duty; elsewhere the page says «يتطلب صلاحية الترحيل (journal_post)».
 */
export const registerCan = (p: Permissions) => {
  const has = (s: string) => hasSubPrivilege(p, "accounting", s);
  const journalCreate = has("journal_create"), journalPost = has("journal_post"), journalApprove = has("journal_approve"), journalReverse = has("journal_reverse");
  return {
    budgets: has("budgets"), deferrals: has("deferrals"), recurring: has("recurring"), fixedAssets: has("fixed_assets"),
    journalCreate, journalPost, journalApprove, journalReverse,
  };
};
