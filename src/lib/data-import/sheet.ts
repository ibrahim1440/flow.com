// «استيراد البيانات من Excel / قيود» — the file in and the template out. An .xlsx (Qoyod's customers / vendors export,
// or any Excel) or a .csv (Qoyod's products export: UTF-8, comma / semicolon / tab) becomes a table of trimmed text
// cells; the template is Qoyod's own layout — its sheet name, its headers in its order (headers only: an example row
// left in a data sheet would be imported) — then an instructions sheet.
import ExcelJS from "exceljs";
import { COLUMNS, ENTITY_LABEL, type ImportEntity } from "./spec";

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const DATA_SHEET = "البيانات";
const HELP_SHEET = "تعليمات";

export class SheetError extends Error {
  constructor(public en: string, public ar: string) { super(en); }
}

/** One cell as text: numbers without float noise, dates as YYYY-MM-DD, rich text / formulas / links by their text. */
export function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(12)));
  if (typeof v === "string") return v.trim();
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("").trim();
    if ("result" in v) return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ("text" in v) return String((v as { text: unknown }).text ?? "").trim();
    if ("error" in v) return "";
  }
  return String(v).trim();
}

/** RFC 4180 CSV (quoted fields, "" escapes, CRLF / LF), a leading BOM dropped; «;» or tab when the header has no comma. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = !first.includes(",") && first.includes(";") ? ";" : !first.includes(",") && first.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === sep) { row.push(cell.trim()); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

/** The uploaded file as a table: .xlsx by its zip signature, else text CSV. The old binary .xls is refused with a reason. */
export async function readTable(buf: Buffer, fileName: string): Promise<string[][]> {
  if (buf.length === 0) throw new SheetError("The file is empty.", "الملف فارغ.");
  if (buf.length > IMPORT_MAX_BYTES) throw new SheetError("The file is larger than 5 MB.", "حجم الملف أكبر من 5 ميغابايت.");
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const isOle = buf[0] === 0xd0 && buf[1] === 0xcf;
  if (isOle || /\.xls$/i.test(fileName)) throw new SheetError("Old .xls files are not read: save the file as .xlsx (Excel workbook) or CSV.", "ملفات ‎.xls القديمة غير مدعومة: احفظ الملف بصيغة ‎.xlsx (مصنف Excel) أو CSV.");
  if (!isZip) return parseCsv(buf.toString("utf8"));
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new SheetError("The Excel file could not be read (is it a valid .xlsx?).", "تعذّرت قراءة ملف Excel (هل هو ملف ‎.xlsx سليم؟).");
  }
  // The template's data sheet when present, else the first sheet that has any value.
  const ws = wb.getWorksheet(DATA_SHEET) ?? wb.worksheets.find((s) => s.name !== HELP_SHEET && s.actualRowCount > 0) ?? wb.worksheets[0];
  if (!ws) return [];
  const width = ws.columnCount;
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (r) => {
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellText(r.getCell(c).value));
    out.push(cells);
  });
  return out;
}

export type TemplateLists = { locations: { code: string; nameAr: string }[]; materialCategories: { nameAr: string; nameEn: string | null }[] };

/** The template workbook: the data sheet (bold headers, required ones marked «*», text columns formatted as text). */
/** Qoyod's sheet name for each export (the template reads like the file Qoyod gives). */
const QOYOD_SHEET: Record<ImportEntity, string> = { customers: "Customers", suppliers: "Vendors", products: "Products" };

/**
 * The template workbook: Qoyod's columns in Qoyod's order and words (required ones darker), text columns formatted as
 * text; the products template adds our three optional columns after Qoyod's (unit, site, pack weight).
 */
export async function templateXlsx(entity: ImportEntity, lists: TemplateLists): Promise<Buffer> {
  const cols = COLUMNS[entity].filter((c) => !c.extra || entity === "products");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Hiqbah";
  wb.created = new Date();
  const ws = wb.addWorksheet(QOYOD_SHEET[entity], { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.ar, key: c.key, width: Math.max(14, c.ar.length + 4), style: c.text ? { numFmt: "@" } : undefined }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  head.height = 28;
  cols.forEach((c, i) => {
    head.getCell(i + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.required ? "FF4C4B2F" : c.extra ? "FFA39E7A" : "FF7A7A5C" } };
  });

  const help = wb.addWorksheet(HELP_SHEET, { views: [{ rightToLeft: true }] });
  help.columns = [{ width: 26 }, { width: 10 }, { width: 70 }, { width: 26 }];
  help.addRow([`قالب استيراد ${ENTITY_LABEL[entity].ar}`]).font = { bold: true, size: 14 };
  help.addRow([`الأعمدة بترتيب ملف قيود وأسمائه نفسها: يمكن رفع ملف التصدير من قيود كما هو. صف لكل سجل، والأعمدة الداكنة مطلوبة.`]);
  if (entity === "products") help.addRow(["الأعمدة الثلاثة الأخيرة (الوحدة، الموقع، الوزن) ليست في ملف قيود: أضفها عند الحاجة بعد أعمدته."]);
  help.addRow(["يُفحص الملف كاملًا قبل الحفظ، ويُستورد كله أو لا شيء. السجل الموجود مسبقًا (بالاسم أو الرقم التسلسلي) يُتخطّى ولا يتكرر، فإعادة رفع الملف نفسه آمنة."]);
  help.addRow([]);
  const th = help.addRow(["العمود", "مطلوب", "الوصف", "مثال"]);
  th.font = { bold: true };
  for (const c of cols) help.addRow([c.ar, c.required ? "نعم" : "", c.ignore ? "من ملف قيود — لا يحفظه النظام" : c.hint ?? "", c.example]);
  if (entity === "products") {
    help.addRow([]);
    help.addRow(["رموز المواقع"]).font = { bold: true };
    for (const l of lists.locations) help.addRow([l.code, "", l.nameAr]);
  }
  if (entity === "products") {
    help.addRow([]);
    help.addRow(["تصنيفات المواد في النظام"]).font = { bold: true };
    for (const c of lists.materialCategories) help.addRow([c.nameAr, "", c.nameEn ?? ""]);
  }
  help.getColumn(3).alignment = { wrapText: true };
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}
