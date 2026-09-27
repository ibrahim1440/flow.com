/**
 * Scheduling a follow-up, as a testable orchestration.
 *
 * Two writes have to happen: a TASK activity carrying the promise and its due date, and the
 * lead's `nextFollowUpAt`, which is what the list sorts and counts on. There is no service
 * that does both in one transaction — if one is added, this should collapse into a call to it
 * and the component should not notice.
 *
 * Until then the sequence is: activity first, date second. That order is the whole point.
 * `nextFollowUpAt` alone answers "when next" and not "who promised what, and when did they
 * promise it", so a date moved with no activity behind it is exactly the state worth
 * preventing. If the activity fails, the date is never touched.
 *
 * ── The half-written case ──
 * The activity can succeed and the date fail. That leaves real history and a stale list, which
 * is recoverable — but only if the retry does NOT write the activity again. A naive retry
 * produces two identical TASK rows for one promise, and the second is indistinguishable from a
 * genuine reschedule. So a partial success is remembered, keyed by the exact instant being
 * scheduled, and a retry for that same instant resumes at the date write.
 *
 * Extracted from the component so all five paths can be exercised with no browser and no
 * database: success, activity failure, date failure, retry after partial, and double submit.
 */

export type WriteResult = { ok: boolean; error?: string };

export type ScheduleDeps = {
  /** POST /api/sales/activities — a TASK carrying the promise. */
  createActivity: (input: { subject: string; dueAtIso: string }) => Promise<WriteResult>;
  /** PATCH /api/sales/leads/[id] — the column the list reads. */
  setFollowUpDate: (dueAtIso: string) => Promise<WriteResult>;
};

/**
 * What survives between attempts.
 *
 * `activityCreatedFor` holds the ISO instant whose activity is already written and must not be
 * written again. It is deliberately the instant and not a boolean: changing the date after a
 * partial failure is a different promise and does need its own activity.
 */
export type ScheduleState = { activityCreatedFor: string | null };

export type ScheduleOutcome =
  | "scheduled"           // both writes landed
  | "activity-failed"     // nothing written, nothing changed
  | "date-failed"         // activity written, list not updated — recoverable
  | "already-running";    // a submit is in flight; this one was ignored

export type ScheduleResult = {
  outcome: ScheduleOutcome;
  /** Which of the two writes this attempt actually performed. */
  performed: { activity: boolean; date: boolean };
  state: ScheduleState;
  error?: string;
};

export const EMPTY_SCHEDULE_STATE: ScheduleState = { activityCreatedFor: null };

export async function runScheduleFollowUp(
  deps: ScheduleDeps,
  state: ScheduleState,
  input: { subject: string; dueAtIso: string; inFlight: boolean },
): Promise<ScheduleResult> {
  // Double submission. Guarded here rather than only by disabling a button, because a
  // double-tap on a phone fires twice before React re-renders the disabled state.
  if (input.inFlight) {
    return { outcome: "already-running", performed: { activity: false, date: false }, state };
  }

  const resuming = state.activityCreatedFor === input.dueAtIso;
  let wroteActivity = false;

  if (!resuming) {
    const created = await deps.createActivity({ subject: input.subject, dueAtIso: input.dueAtIso });
    if (!created.ok) {
      // Nothing written. The date is untouched, so there is nothing to undo and nothing to
      // explain away — and no partial state to remember.
      return {
        outcome: "activity-failed",
        performed: { activity: false, date: false },
        state: { activityCreatedFor: null },
        error: created.error,
      };
    }
    wroteActivity = true;
  }

  const dated = await deps.setFollowUpDate(input.dueAtIso);
  if (!dated.ok) {
    return {
      outcome: "date-failed",
      performed: { activity: wroteActivity, date: false },
      // Remembered so a retry for this same instant skips straight to the date.
      state: { activityCreatedFor: input.dueAtIso },
      error: dated.error,
    };
  }

  return {
    outcome: "scheduled",
    performed: { activity: wroteActivity, date: true },
    // Cleared: the promise is fully written, and a later schedule is a new promise.
    state: { activityCreatedFor: null },
  };
}

/**
 * The message for an outcome.
 *
 * Separate from the orchestration so the wording is asserted directly. The rule it exists to
 * enforce: only `scheduled` may read as success. A half-written schedule that says "done"
 * sends someone away believing the list will remind them.
 */
export function scheduleMessage(
  outcome: ScheduleOutcome,
  ar: boolean,
  serverError?: string,
): { kind: "success" | "error" | "warning" | "none"; text: string } {
  switch (outcome) {
    case "scheduled":
      return {
        kind: "success",
        text: ar ? "جُدولت المتابعة وسُجِّلت في السجل." : "Follow-up scheduled and recorded in the history.",
      };
    case "activity-failed":
      return {
        kind: "error",
        text: serverError ?? (ar
          ? "تعذّر إنشاء مهمة المتابعة، فلم يُغيَّر الموعد."
          : "Could not create the follow-up task, so the date was not changed."),
      };
    case "date-failed":
      return {
        kind: "warning",
        text: ar
          ? "سُجِّلت المهمة في السجل، لكن تعذّر تحديث موعد المتابعة على السجل — قد لا تظهر في القائمة. أعد المحاولة؛ لن تُنشأ مهمة ثانية."
          : "The task was recorded, but the lead's follow-up date could not be updated — it may not appear in the list. Retry; a second task will not be created.",
      };
    case "already-running":
      return { kind: "none", text: "" };
  }
}
