"use client";
// P2 ERR-15 (owner decision ب2, approved Figma 5): under a follow-up / reminder date — a day already gone is said before
// saving (the server refuses it: DATE_IN_PAST). An unchanged stored date (`initial`) is not flagged: it never blocks.
const riyadhToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);

export function isPastPick(value: string | null | undefined, initial?: string | null): boolean {
  if (!value) return false;
  if (initial && value === initial) return false;
  return value.slice(0, 10) < riyadhToday();
}

export function PastDateHint({ ar, value, initial, testId }: { ar: boolean; value: string | null | undefined; initial?: string | null; testId?: string }) {
  if (!isPastPick(value, initial)) return null;
  return (
    <p role="alert" data-testid={testId ?? "past-date-hint"} style={{ margin: "6px 0 0", fontSize: 13, color: "var(--status-danger, #a34435)" }}>
      {ar ? "هالتاريخ فات — اختر اليوم أو بعده." : "That day has passed — choose today or later."}
    </p>
  );
}
