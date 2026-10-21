/**
 * Owner decision 2.1 for saved presets: a Cupping Results preset may show scorer names only when
 * its author holds labels.cupping_named_scorers AND confirms the privacy requirements
 * (`privacyConfirmed: true`). The confirmation is stored (who, when) and audited; turning names off
 * clears it. Returns the columns to write, or the refusal.
 */
import { NextResponse } from "@/lib/api-response";
import { isShown } from "../templates";
import type { PresetInput } from "../presets";
import { canNameScorers } from "./auth";
import type { requireAuth } from "@/lib/auth-server";

type User = Awaited<ReturnType<typeof requireAuth>>["user"];

export function namedScorersColumns(user: User, v: PresetInput, body: Record<string, unknown>):
  { error: NextResponse } | { data: { namedScorersConfirmedAt: Date | null; namedScorersConfirmedById: string | null } } {
  if (v.templateKey !== "CUPPING_RESULTS" || !isShown(v.fields, "scorerNames")) {
    return { data: { namedScorersConfirmedAt: null, namedScorersConfirmedById: null } };
  }
  if (!canNameScorers(user)) {
    return { error: NextResponse.json({ error: "Printing scorer names needs the separate «cupping named scorers» permission.", code: "NAMED_SCORERS_FORBIDDEN" }, { status: 403 }) };
  }
  if (body.privacyConfirmed !== true) {
    return { error: NextResponse.json({ error: "Confirm the privacy requirements before saving a preset that prints scorer names.", code: "PRIVACY_CONFIRMATION_REQUIRED" }, { status: 400 }) };
  }
  return { data: { namedScorersConfirmedAt: new Date(), namedScorersConfirmedById: user.id } };
}
