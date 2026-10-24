// Accounting A5 (council fix) — one CSV cell rule for every accounting export: quoted when it would change the row's
// shape, and a text that a spreadsheet would run as a formula (= + - @ tab CR at the start) prefixed with a single
// quote (CWE-1236) — account names, memos and customer names are user text. A plain number (−120.00 included) stays
// a number. Pure.
const NUMBER = /^-?\d+(\.\d+)?$/;
export function acctCsvCell(v: string | number | null | undefined): string {
  const raw = v === null || v === undefined ? "" : String(v);
  const safe = !NUMBER.test(raw) && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
