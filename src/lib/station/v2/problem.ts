/**
 * Roasting station v2 — the report rules of D16 (owner-approved 9 Nov 2026). Pure (no database, client-safe), shared by
 * the service, the station screen, the ERP «بلاغات المحامص» page and the tests.
 *
 *   · A report stops charging (blocking) or is a minor problem the roaster keeps roasting through. A new report stops;
 *     right after «إرسال» the reporter (or a supervisor) may choose «متابعة التحميص · مشكلة بسيطة». A PAUSE always stops.
 *   · Every roast charged while a minor report is open is marked with it (RoastRun.problemId) — the station shows a short
 *     toast after the charge (owner: option 2, it never stops the charge), the lot and QC show the mark.
 *   · Who ends a report: a PAUSE — the roaster too (as before); anything else — a supervisor: the station assignment's
 *     «مشرف» flag, production › manage_roasters or manage_schedule (owner decision 1, 9 Nov 2026). No role check: the
 *     administrator holds both keys through the ordinary permission model (release gate B1).
 *   · Escalating a minor report back to «إيقاف التحميص» is open to anyone at the roaster (safety, gate M1); switching a
 *     report to minor stays with its reporter or a supervisor.
 *   · Ending a report other than a PAUSE writes «إيش كانت المشكلة؟» and «إيش الحل؟» (both required, ≤ 500 characters).
 */
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

export const PROBLEM_TEXT_MAX = 500;

export type ProblemActor = { id: string; role: string; permissions: Permissions; supervisor?: boolean };

/** A supervisor for the roasting station's reports (owner decision 1, 9 Nov 2026). */
export function isProblemSupervisor(a: Pick<ProblemActor, "permissions" | "supervisor">): boolean {
  return a.supervisor === true
    || hasSubPrivilege(a.permissions, "production", "manage_roasters")
    || hasSubPrivilege(a.permissions, "production", "manage_schedule");
}

/** Who may end a report: a PAUSE — anyone at the roaster; anything else — a supervisor. */
export function mayEndProblem(a: Pick<ProblemActor, "permissions" | "supervisor">, kind: string): boolean {
  return kind === "PAUSE" || isProblemSupervisor(a);
}

/** Who may switch an open report to «متابعة التحميص» (minor): its reporter or a supervisor; never a PAUSE. */
export function mayContinueProblem(a: ProblemActor, p: { kind: string; reportedById: string }): boolean {
  return p.kind !== "PAUSE" && (a.id === p.reportedById || isProblemSupervisor(a));
}

/** Who may set a report's mode: to «إيقاف التحميص» (blocking) anyone at the roaster (safety); to minor — see above. */
export function maySetProblemMode(a: ProblemActor, p: { kind: string; reportedById: string }, blocking: boolean): boolean {
  return blocking ? true : mayContinueProblem(a, p);
}

/** Charging is refused only by an open BLOCKING report; a minor one lets the roast go and marks it. */
export function chargeBlockedBy(problem: { blocking: boolean } | null | undefined): boolean {
  return !!problem && problem.blocking;
}

/** Whether ending this report needs the cause and the fix written (every report but a PAUSE). */
export const endNeedsTexts = (kind: string) => kind !== "PAUSE";

/** A cause / fix field: trimmed, collapsed, 1..PROBLEM_TEXT_MAX characters, or null when empty / not text. */
export function problemText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > PROBLEM_TEXT_MAX ? null : t;
}

/** The report's words (the station chips' own labels), for the ERP page, QC and the toasts. */
export const PROBLEM_KIND_LABEL: Record<string, { ar: string; en: string }> = {
  PAUSE: { ar: "إيقاف مؤقت", en: "Pause" },
  MALFUNCTION: { ar: "عطل في الحمّاصة", en: "Roaster malfunction" },
};
export const PROBLEM_REASON_LABEL: Record<string, { ar: string; en: string }> = {
  BURNER_STOPPED: { ar: "توقّف الموقد", en: "Burner stopped" },
  IRREGULAR_HEAT: { ar: "حرارة غير منتظمة", en: "Irregular heat" },
  COOLING_PROBLEM: { ar: "مشكلة في التبريد", en: "Cooling problem" },
  OTHER: { ar: "أخرى", en: "Other" },
};
export const problemReasonText = (reason: string, lang: "ar" | "en") => PROBLEM_REASON_LABEL[reason]?.[lang] ?? reason;
