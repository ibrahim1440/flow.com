/**
 * CSV for the inventory exports (movement ledger, purchases) — pure, unit-tested in
 * tests/ops/unit/inventory-csv.test.ts.
 *
 *   · RFC 4180: a field holding a comma, a quote, CR or LF is quoted, quotes doubled; CRLF rows.
 *   · A UTF-8 byte-order mark first, so Excel opens Arabic text as UTF-8.
 *   · Formula injection: a TEXT cell starting with = + - @ (or a tab / CR) is prefixed with an
 *     apostrophe so a spreadsheet shows it instead of evaluating it. Numbers are written as numbers
 *     (a negative quantity is a number, not a formula) — callers pass them as `number`.
 */
export type CsvCell = string | number | null | undefined;

export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** "YYYY-MM-DD HH:mm" in Riyadh time — the ERP's operational clock. */
export function riyadhStamp(d: Date | string): string {
  const x = d instanceof Date ? d : new Date(d);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(x);
  const g = (t: string) => p.find((q) => q.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

export function csvResponseHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
    "Cache-Control": "no-store",
  };
}
