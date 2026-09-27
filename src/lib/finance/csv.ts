// Bank statement CSV import: parsing, column mapping, validation and duplicate identity.
// Pure — the service decides what to persist.
//
// Duplicate identity is a FINGERPRINT, not "same date and amount":
//   sha256(account | date | amount | bank reference | normalised description | occurrence)
// where `occurrence` counts identical (date, amount, reference, description) rows within
// the same file. Two genuine identical coffee sales on one day are rows #1 and #2 and both
// import; re-importing the same statement yields the same fingerprints and imports nothing.
// A row whose date and amount match an existing line with a DIFFERENT fingerprint is
// imported but flagged for review — a human decides, the system never auto-rejects.

import { createHash } from "node:crypto";
import { normaliseDigits, parseMoney, type Minor } from "./money";
import { isDateString } from "./dates";

export type CsvMapping = {
  date: string;
  /** Either `amount` (signed) or `debit` + `credit` columns. */
  amount?: string;
  debit?: string;
  credit?: string;
  reference?: string;
  description?: string;
  counterparty?: string;
  /** Optional: route rows to accounts by code or last four digits. */
  account?: string;
  dateFormat: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
  hasHeader: boolean;
};

export type ParsedRow = {
  rowNo: number;
  txnDate: string;
  amount: Minor;
  reference: string | null;
  description: string | null;
  counterparty: string | null;
  accountRef: string | null;
};

export type RowError = { rowNo: number; field: string; message: string; raw: string };

export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t", "|"].map((d) => ({ d, n: first.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ",";
}

/** RFC-4180-style parser: quoted fields, doubled quotes, CRLF, embedded newlines. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function parseDate(raw: string, fmt: CsvMapping["dateFormat"]): string | null {
  const v = normaliseDigits(raw).trim().replace(/\./g, "/").replace(/-/g, fmt === "YYYY-MM-DD" ? "-" : "/");
  let y: string, m: string, d: string;
  if (fmt === "YYYY-MM-DD") {
    const r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
    if (!r) return null;
    [, y, m, d] = r;
  } else {
    const r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
    if (!r) return null;
    if (fmt === "DD/MM/YYYY") [, d, m, y] = r; else [, m, d, y] = r;
  }
  const s = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isDateString(s) ? s : null;
}

export function headerIndex(header: string[], name: string | undefined, hasHeader: boolean): number {
  if (!name) return -1;
  if (!hasHeader) {
    const n = Number(name);
    return Number.isInteger(n) && n >= 1 ? n - 1 : -1;
  }
  return header.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
}

export function mapRows(rows: string[][], mapping: CsvMapping): { parsed: ParsedRow[]; errors: RowError[]; header: string[] } {
  const header = mapping.hasHeader ? rows[0] ?? [] : [];
  const body = mapping.hasHeader ? rows.slice(1) : rows;
  const idx = {
    date: headerIndex(header, mapping.date, mapping.hasHeader),
    amount: headerIndex(header, mapping.amount, mapping.hasHeader),
    debit: headerIndex(header, mapping.debit, mapping.hasHeader),
    credit: headerIndex(header, mapping.credit, mapping.hasHeader),
    reference: headerIndex(header, mapping.reference, mapping.hasHeader),
    description: headerIndex(header, mapping.description, mapping.hasHeader),
    counterparty: headerIndex(header, mapping.counterparty, mapping.hasHeader),
    account: headerIndex(header, mapping.account, mapping.hasHeader),
  };
  const errors: RowError[] = [];
  const parsed: ParsedRow[] = [];
  if (idx.date < 0) errors.push({ rowNo: 0, field: "date", message: "Date column not found", raw: mapping.date });
  if (idx.amount < 0 && (idx.debit < 0 || idx.credit < 0)) {
    errors.push({ rowNo: 0, field: "amount", message: "Map either a signed amount column or both debit and credit columns", raw: "" });
  }
  if (errors.length) return { parsed, errors, header };

  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  body.forEach((r, k) => {
    const rowNo = k + (mapping.hasHeader ? 2 : 1);
    const rawDate = cell(r, idx.date);
    const txnDate = parseDate(rawDate, mapping.dateFormat);
    if (!txnDate) { errors.push({ rowNo, field: "date", message: `Unrecognised date for format ${mapping.dateFormat}`, raw: rawDate }); return; }
    let amount: Minor | null;
    if (idx.amount >= 0) {
      amount = parseMoney(cell(r, idx.amount));
      if (amount === null) { errors.push({ rowNo, field: "amount", message: "Not a valid amount (max two decimals)", raw: cell(r, idx.amount) }); return; }
    } else {
      const dr = cell(r, idx.debit), cr = cell(r, idx.credit);
      const d = dr === "" ? 0 : parseMoney(dr);
      const c = cr === "" ? 0 : parseMoney(cr);
      if (d === null || c === null) { errors.push({ rowNo, field: "amount", message: "Debit/credit is not a valid amount", raw: `${dr}|${cr}` }); return; }
      if (d !== 0 && c !== 0) { errors.push({ rowNo, field: "amount", message: "Row has both a debit and a credit", raw: `${dr}|${cr}` }); return; }
      amount = c !== 0 ? Math.abs(c) : -Math.abs(d);
    }
    if (amount === 0) { errors.push({ rowNo, field: "amount", message: "Zero amount", raw: "0" }); return; }
    parsed.push({
      rowNo,
      txnDate,
      amount,
      reference: cell(r, idx.reference) || null,
      description: cell(r, idx.description) || null,
      counterparty: cell(r, idx.counterparty) || null,
      accountRef: cell(r, idx.account) || null,
    });
  });
  return { parsed, errors, header };
}

export function normaliseDescription(s: string | null): string {
  return normaliseDigits(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Fingerprints in file order; identical rows get increasing occurrence numbers. */
export function fingerprintRows(accountId: string, rows: Pick<ParsedRow, "txnDate" | "amount" | "reference" | "description">[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const key = [accountId, r.txnDate, String(r.amount), (r.reference ?? "").trim().toUpperCase(), normaliseDescription(r.description)].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return createHash("sha256").update(`${key}|#${n}`).digest("hex");
  });
}

export function fileHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
