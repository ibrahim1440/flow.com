// «الأصول الثابتة» — who may reach the fixed-asset endpoints (the routes re-check every duty; the pages' controls are
// conveniences):
//   • reads (register, runs, reports, previews): the accounting module;
//   • maintenance that does not reach the books (categories, a DRAFT asset, its edits): accounting › fixed_assets (a
//     verified individual — the accounting module is privileged — no step-up);
//   • what is recorded / posted (activate, a depreciation run, an addition, a disposal): accounting › fixed_assets AND
//     the journal duty accounting › journal_post, through the central gate (verified individual + step-up);
//   • what undoes a posting (reverse a run, cancel an addition / a disposal): accounting › fixed_assets AND
//     accounting › journal_reverse (the same gate);
//   • the segregation-of-duties setting is applied in the services (./common.ts faSod): an act by the document's
//     preparer is refused or, when the setting allows it, recorded on the entry (JournalEntry.sodBypass) and listed in
//     «استثناءات فصل المهام» (FA_SELF_POSTED);
//   • the go-live opening (writes the opening-balance grid): accounting › opening_balance and a step-up.
import { NextResponse } from "@/lib/api-response";
import { forbidden, privilegedGate, requireModule, requireFreshAuth, requireSub } from "@/lib/auth-server";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

type User = Awaited<ReturnType<typeof requireSub>>["user"];
export type FaDuty = "journal_post" | "journal_reverse";

export async function requireFaRead() {
  return requireModule("accounting");
}

/** accounting › fixed_assets; with `duty`, also that journal duty through the central gate (identity + step-up). */
export async function requireFaWrite(opts: { duty?: FaDuty } = {}): Promise<{ user: User; error: NextResponse | null }> {
  const { user, error } = await requireSub("accounting", "fixed_assets");
  if (error) return { user, error };
  if (opts.duty) {
    if (!hasSubPrivilege(user.permissions, "accounting", opts.duty)) return { user, error: forbidden() };
    const refused = await privilegedGate(user, "accounting", opts.duty);
    if (refused) return { user, error: refused };
    // The gate steps up for the journal duties (STEP_UP_KEYS); kept explicit so a change there cannot drop it here.
    const stale = requireFreshAuth(user);
    if (stale) return { user, error: stale };
  }
  return { user, error: null };
}

export async function requireFaOpening(): Promise<{ user: User; error: NextResponse | null }> {
  const { user, error } = await requireSub("accounting", "opening_balance");
  if (error) return { user, error };
  const refused = requireFreshAuth(user);
  return { user, error: refused };
}

/** What the viewer may do (the pages draw only these controls). */
export const faCan = (p: Permissions) => {
  const write = hasSubPrivilege(p, "accounting", "fixed_assets");
  return {
    write,
    post: write && hasSubPrivilege(p, "accounting", "journal_post"),
    reverse: write && hasSubPrivilege(p, "accounting", "journal_reverse"),
    opening: hasSubPrivilege(p, "accounting", "opening_balance"),
  };
};
