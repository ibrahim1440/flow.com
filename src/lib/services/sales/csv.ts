/**
 * CSV for the lead list: reading what a salesperson exported from a phone, and writing
 * something a spreadsheet will open without executing it.
 *
 * Pure functions, no database and no HTTP, so every rule below is asserted directly.
 *
 * ── Why this file is careful ──
 * A CSV is not a data format, it is a family of them. Real lead lists arrive with a UTF-8
 * BOM from Excel, with CRLF endings, with Arabic company names, with quoted fields
 * containing the delimiter, and with a phone number the spreadsheet has helpfully turned
 * into 5.01234568E+8. Each of those is handled here rather than treated as a malformed
 * file the operator must fix by hand.
 */

// ─── Reading ──────────────────────────────────────────────────────────────────

/**
 * Split CSV text into rows of fields.
 *
 * A hand-written parser rather than a split on commas, because a split on commas is wrong
 * for the first company name containing one — and "Al Waha Coffee, Jeddah" is an ordinary
 * name, not an edge case. Handles quoted fields, doubled quotes inside them, embedded
 * newlines, CRLF, and the byte-order mark Excel writes.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      sawAny = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAny = false;
    } else {
      field += c;
      sawAny = true;
    }
  }

  if (sawAny || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// ─── Writing ──────────────────────────────────────────────────────────────────

/**
 * Make one cell safe to open in a spreadsheet.
 *
 * A field beginning with `=`, `+`, `-`, `@`, tab or carriage return is a formula to Excel,
 * Numbers and LibreOffice alike — so a lead whose "notes" read
 * `=HYPERLINK("http://evil","click")` becomes a live link in whoever opens the export.
 * The value is preserved exactly and prefixed with a single quote, which spreadsheets
 * consume as "this is text" and which reads back identically if the file is re-imported
 * through `parseCsv` + `stripFormulaGuard`.
 *
 * The lead API stores such text verbatim on purpose — sanitising on the way IN would
 * corrupt a company legitimately called "-Aroma-" — so neutralising belongs here, on the
 * way out, where the danger actually is.
 */
export function neutralizeCsvCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** The inverse, for round-tripping our own export back through the importer. */
export function stripFormulaGuard(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

/** Quote a field if it contains anything that would otherwise change the row's shape. */
export function csvField(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = neutralizeCsvCell(raw);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Render rows as a CSV document.
 *
 * CRLF endings and a leading BOM, because the audience is Excel on Windows: without the
 * BOM every Arabic company name in the file opens as mojibake, which makes the export
 * useless for exactly the records it matters most for.
 */
export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvField).join(","), ...rows.map((r) => r.map(csvField).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ─── Leads ────────────────────────────────────────────────────────────────────

export const LEAD_IMPORT_COLUMNS = [
  "companyName",
  "companyNameAr",
  "contactName",
  "phone",
  "email",
  "city",
  "address",
  "source",
  "sourceNote",
  "notes",
  "nextFollowUpAt",
] as const;

export type LeadImportRow = Partial<Record<(typeof LEAD_IMPORT_COLUMNS)[number], string>>;

export type ImportProblem = { row: number; column?: string; message: string };

const SOURCES = ["WALK_IN", "REFERRAL", "PHONE", "SOCIAL", "EXHIBITION", "WEBSITE", "OTHER"];

/** Accepts the exact column names, and the obvious human spellings of them. */
const HEADER_ALIASES: Record<string, (typeof LEAD_IMPORT_COLUMNS)[number]> = {
  company: "companyName",
  companyname: "companyName",
  "company name": "companyName",
  "اسم المنشأة": "companyName",
  companynamear: "companyNameAr",
  "company name ar": "companyNameAr",
  contact: "contactName",
  contactname: "contactName",
  "contact name": "contactName",
  "اسم جهة الاتصال": "contactName",
  phone: "phone",
  mobile: "phone",
  الهاتف: "phone",
  email: "email",
  "e-mail": "email",
  city: "city",
  المدينة: "city",
  address: "address",
  source: "source",
  sourcenote: "sourceNote",
  notes: "notes",
  note: "notes",
  nextfollowupat: "nextFollowUpAt",
  "next follow up": "nextFollowUpAt",
  followup: "nextFollowUpAt",
};

function canonicalHeader(raw: string): (typeof LEAD_IMPORT_COLUMNS)[number] | null {
  const key = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const direct = LEAD_IMPORT_COLUMNS.find((c) => c.toLowerCase() === key.replace(/\s+/g, ""));
  if (direct) return direct;
  return HEADER_ALIASES[key] ?? HEADER_ALIASES[key.replace(/\s+/g, "")] ?? null;
}

export type ParsedImport = {
  rows: LeadImportRow[];
  problems: ImportProblem[];
  /** Header cells that were not recognised. Reported, never silently ignored. */
  unknownColumns: string[];
};

/**
 * The most rows one upload may carry.
 *
 * A bound, not a guess: an import runs in one request and one transaction, and an
 * unbounded file is a way to hold a connection open for as long as the uploader likes.
 */
export const MAX_IMPORT_ROWS = 500;

/**
 * Read a lead CSV into validated rows.
 *
 * Validates the SHAPE — required fields present, dates parseable, sources recognised. It
 * deliberately does not decide whether a row is a duplicate: that is the lead service's
 * job, it needs the database, and the answer is "show the operator", not "drop the row".
 */
export function parseLeadCsv(text: string): ParsedImport {
  const problems: ImportProblem[] = [];
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));

  if (grid.length === 0) {
    return { rows: [], problems: [{ row: 0, message: "The file is empty." }], unknownColumns: [] };
  }

  const headerRow = grid[0];
  const unknownColumns: string[] = [];
  const mapping = headerRow.map((h) => {
    const c = canonicalHeader(h);
    if (!c && h.trim()) unknownColumns.push(h.trim());
    return c;
  });

  if (!mapping.includes("companyName")) {
    problems.push({
      row: 1,
      message:
        "The file needs a companyName column. Recognised headings are: " +
        LEAD_IMPORT_COLUMNS.join(", ") + ".",
    });
    return { rows: [], problems, unknownColumns };
  }

  const body = grid.slice(1);
  if (body.length > MAX_IMPORT_ROWS) {
    problems.push({
      row: 0,
      message: `This file has ${body.length} rows; ${MAX_IMPORT_ROWS} is the most one import may carry. Split it.`,
    });
    return { rows: [], problems, unknownColumns };
  }

  const rows: LeadImportRow[] = [];
  body.forEach((cells, i) => {
    const rowNumber = i + 2; // 1-based, and the header is row 1 — what the operator sees.
    const row: LeadImportRow = {};
    mapping.forEach((col, ci) => {
      if (!col) return;
      const value = stripFormulaGuard((cells[ci] ?? "").trim());
      if (value) row[col] = value;
    });

    if (!row.companyName || row.companyName.length < 2) {
      problems.push({ row: rowNumber, column: "companyName", message: "A company name is required." });
      return;
    }
    if (!row.contactName || row.contactName.length < 2) {
      problems.push({ row: rowNumber, column: "contactName", message: "A contact name is required." });
      return;
    }
    if (row.source) {
      const up = row.source.toUpperCase().replace(/[\s-]+/g, "_");
      if (!SOURCES.includes(up)) {
        problems.push({
          row: rowNumber,
          column: "source",
          message: `"${row.source}" is not a known source. Use one of: ${SOURCES.join(", ")}.`,
        });
        return;
      }
      row.source = up;
    }
    if (row.email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(row.email)) {
      problems.push({ row: rowNumber, column: "email", message: `"${row.email}" is not an email address.` });
      return;
    }
    if (row.nextFollowUpAt) {
      const d = new Date(row.nextFollowUpAt);
      if (Number.isNaN(d.getTime())) {
        problems.push({
          row: rowNumber,
          column: "nextFollowUpAt",
          message: `"${row.nextFollowUpAt}" is not a date. Use YYYY-MM-DD.`,
        });
        return;
      }
      row.nextFollowUpAt = d.toISOString();
    }

    rows.push(row);
  });

  return { rows, problems, unknownColumns };
}
