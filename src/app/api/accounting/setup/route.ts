import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { acctError } from "@/lib/accounting/http";
import { getSettings, readiness } from "@/lib/accounting/setup";
import { manualJournalsEnabled } from "@/lib/accounting/manual-journals";
import { isSimpleMode } from "@/lib/simple-mode";
import { dayText } from "@/lib/accounting/dates";
import { sodPolicy } from "@/lib/accounting/sod";

/** «إعدادات المحاسبة»: the settings, the readiness checklist, the role map and what the viewer may do. */
export async function GET() {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  try {
    const [s, r, manual, sod] = await Promise.all([getSettings(), readiness(), manualJournalsEnabled(), sodPolicy()]);
    const can = (sub: string) => hasSubPrivilege(user.permissions, "accounting", sub);
    return NextResponse.json({
      settings: { ...s, goLiveDate: s.goLiveDate ? dayText(s.goLiveDate) : null },
      readiness: r,
      manualJournalsEnabled: manual,
      simpleMode: isSimpleMode(),
      // A5: the effective SoD policy (setting, or SIMPLE MODE) and what is stored.
      sod,
      viewer: { id: user.id },
      can: {
        settings: can("settings_manage"), coa: can("coa_manage"), periodLock: can("period_lock"), periodClose: can("period_close"),
        periodReopen: can("period_reopen"), journalCreate: can("journal_create"), journalSubmit: can("journal_submit"),
        journalApprove: can("journal_approve"), journalPost: can("journal_post"), journalReverse: can("journal_reverse"), opening: can("opening_balance"),
        // The registers' maintenance duties (src/lib/accounting/register-access.ts).
        recurring: can("recurring"), budgets: can("budgets"), deferrals: can("deferrals"), fixedAssets: can("fixed_assets"),
      },
    });
  } catch (err) {
    return acctError(err);
  }
}
