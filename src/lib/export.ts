import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import ExcelJS from "exceljs";
import { convertArabic } from "arabic-reshaper";
import bidiFactory from "bidi-js";
import { AmiriBold, AmiriRegular } from "./fonts/amiri-base64";

const bidi = bidiFactory();

// Direction 2.1 brand colours (components/shell/direction-2.1.css): olive action for the header
// bands, clay signature for the accent rule / totals, the warm canvas for alternate rows and
// Deep Black text. The retired grey + purple export theme is gone (owner, 20 Oct 2026).
const BRAND = {
  primary: "#5C5C38",
  accent: "#BD7D47",
  primaryRGB: [92, 92, 56] as [number, number, number],
  accentRGB: [189, 125, 71] as [number, number, number],
  /** Totals row: action-primary-hover, so white text keeps its contrast (clay is for marks only). */
  totalRGB: [76, 75, 47] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
  lightGray: [248, 245, 238] as [number, number, number],
  darkText: [40, 36, 26] as [number, number, number],
};

function shapeArabic(text: string): string {
  const shaped = convertArabic(text);
  const embeddingLevels = bidi.getEmbeddingLevels(shaped);
  return bidi.getReorderedString(shaped, embeddingLevels);
}

/**
 * The strings above are already shaped AND in visual order (shapeArabic). jsPDF's own bidi step
 * (postProcessText) treats every string as visual-LTR input and re-orders it to logical order,
 * which reversed every Arabic word in the batches PDF («جاتنلإا ريرقت» for «تقرير الإنتاج»).
 * Visual in, visual out: jsPDF leaves the text as given. Applied to every doc.text of the
 * document, including the ones jspdf-autotable makes.
 */
function keepVisualOrder(doc: jsPDF) {
  const text = doc.text.bind(doc) as (...a: unknown[]) => jsPDF;
  (doc as unknown as { text: (...a: unknown[]) => jsPDF }).text = (t: unknown, x: unknown, y: unknown, options?: unknown, ...rest: unknown[]) =>
    text(t, x, y, { ...((options as object | undefined) ?? {}), isInputVisual: true, isOutputVisual: true }, ...rest);
}

function hasArabic(text: string): boolean {
  return /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(text);
}

/**
 * A table cell in LOGICAL order. autoTable wraps it into lines first (so a long Arabic cell breaks
 * between the right words, first line first), and each drawn line is shaped into visual order
 * in willDrawCell (visualCellLines) — shaping before the wrap printed wrapped Arabic lines in the
 * wrong order, and a cell left unshaped (the date «1 أكتوبر 2026») printed reversed.
 */
function processCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

function visualCellLines(lines: string[]): string[] {
  return lines.map((l) => (hasArabic(l) ? shapeArabic(l) : l));
}

export type BatchExportRow = {
  batchNumber: string;
  date: string;
  customer: string;
  // string when the batch has no order behind it (roast to stock)
  orderNumber: number | string;
  beanType: string;
  greenBeanQuantity: number;
  roastedBeanQuantity: number;
  wasteQuantity: number;
  roastProfile: string | null;
  status: string;
  bags3kg: number;
  bags1kg: number;
  bags250g: number;
  bags150g: number;
  samplesGrams: number;
};

const AR_HEADERS = [
  "عينات (جم)",
  "أكياس 150جم",
  "أكياس 250جم",
  "أكياس 1كجم",
  "أكياس 3كجم",
  "الحالة",
  "ملف التحميص",
  "الهالك (كجم)",
  "المحمصة (كجم)",
  "الخضراء (كجم)",
  "نوع البن",
  "رقم الطلب",
  "العميل",
  "التاريخ",
  "رقم الدفعة",
];

const EN_HEADERS = [
  "Samples (g)",
  "150g Bags",
  "250g Bags",
  "1kg Bags",
  "3kg Bags",
  "Status",
  "Roast Profile",
  "Waste (kg)",
  "Roasted (kg)",
  "Green (kg)",
  "Bean Type",
  "Order #",
  "Customer",
  "Date",
  "Batch #",
];

function rowToRtlArray(r: BatchExportRow): string[] {
  return [
    String(r.samplesGrams),
    String(r.bags150g),
    String(r.bags250g),
    String(r.bags1kg),
    String(r.bags3kg),
    processCell(r.status),
    processCell(r.roastProfile) || "-",
    String(r.wasteQuantity),
    String(r.roastedBeanQuantity),
    String(r.greenBeanQuantity),
    processCell(r.beanType),
    processCell(r.orderNumber),
    processCell(r.customer),
    processCell(r.date),
    processCell(r.batchNumber),
  ];
}

function registerFonts(doc: jsPDF) {
  doc.addFileToVFS("Amiri-Bold.ttf", AmiriBold);
  doc.addFont("Amiri-Bold.ttf", "Amiri", "bold");
  doc.addFileToVFS("Amiri-Regular.ttf", AmiriRegular);
  doc.addFont("Amiri-Regular.ttf", "Amiri", "normal");
}

function addPdfHeader(doc: jsPDF, title: string, titleAr: string) {
  const pageW = doc.internal.pageSize.getWidth();

  doc.setFillColor(...BRAND.primaryRGB);
  doc.rect(0, 0, pageW, 28, "F");

  doc.setFont("Amiri", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...BRAND.white);
  doc.text(shapeArabic("حِقبة للقهوة المختصة"), pageW - 14, 10, { align: "right" });

  doc.setFontSize(7);
  doc.setFont("Amiri", "normal");
  doc.text("Hiqbah Specialty Coffee", pageW - 14, 16, { align: "right" });

  doc.setFont("Amiri", "bold");
  doc.setFontSize(12);
  doc.text(shapeArabic(titleAr), pageW / 2, 10, { align: "center" });
  doc.setFontSize(9);
  doc.setFont("Amiri", "normal");
  doc.text(title, pageW / 2, 17, { align: "center" });

  doc.setFontSize(7);
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  doc.text(dateStr, 14, 10);
  doc.text(shapeArabic("تاريخ التصدير"), 14, 16);

  doc.setDrawColor(...BRAND.accentRGB);
  doc.setLineWidth(1);
  doc.line(0, 28, pageW, 28);
}

function addPdfFooter(doc: jsPDF) {
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    doc.setFontSize(7);
    doc.setFont("Amiri", "normal");
    doc.setTextColor(120, 120, 120);
    doc.text(`${i} / ${pages}`, pageW / 2, pageH - 6, { align: "center" });
    doc.text(
      shapeArabic("حِقبة للقهوة المختصة — تقرير آلي"),
      pageW - 14,
      pageH - 6,
      { align: "right" }
    );
  }
}

export function exportBatchesPDF(
  rows: BatchExportRow[],
  title = "Production Report",
  titleAr = "تقرير الإنتاج"
) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  keepVisualOrder(doc);
  registerFonts(doc);
  addPdfHeader(doc, title, titleAr);

  const headers = [...AR_HEADERS];

  const body = rows.map((r) => rowToRtlArray(r));

  const totalGreen = rows.reduce((s, r) => s + r.greenBeanQuantity, 0);
  const totalRoasted = rows.reduce((s, r) => s + r.roastedBeanQuantity, 0);
  const totalWaste = rows.reduce((s, r) => s + r.wasteQuantity, 0);
  const totalBags3 = rows.reduce((s, r) => s + r.bags3kg, 0);
  const totalBags1 = rows.reduce((s, r) => s + r.bags1kg, 0);
  const totalBags250 = rows.reduce((s, r) => s + r.bags250g, 0);
  const totalBags150 = rows.reduce((s, r) => s + r.bags150g, 0);
  const totalSamples = rows.reduce((s, r) => s + r.samplesGrams, 0);

  body.push([
    String(totalSamples),
    String(totalBags150),
    String(totalBags250),
    String(totalBags1),
    String(totalBags3),
    "",
    "",
    String(+totalWaste.toFixed(2)),
    String(+totalRoasted.toFixed(2)),
    String(+totalGreen.toFixed(2)),
    "",
    "",
    "",
    "",
    "الإجمالي",
  ]);

  autoTable(doc, {
    startY: 32,
    head: [headers],
    body,
    styles: {
      font: "Amiri",
      fontStyle: "normal",
      fontSize: 7,
      cellPadding: 2,
      halign: "right",
      textColor: BRAND.darkText,
    },
    headStyles: {
      fillColor: BRAND.primaryRGB,
      textColor: BRAND.white,
      fontStyle: "bold",
      fontSize: 7,
      halign: "right",
    },
    alternateRowStyles: {
      fillColor: BRAND.lightGray,
    },
    columnStyles: {
      0: { halign: "center" },
      1: { halign: "center" },
      2: { halign: "center" },
      3: { halign: "center" },
      4: { halign: "center" },
      7: { halign: "center" },
      8: { halign: "center" },
      9: { halign: "center" },
      11: { halign: "center" },
      // The date («1 أكتوبر 2026») and its header stay on whole words: the customer column takes
      // the slack instead of splitting them mid-word.
      13: { cellWidth: 24 },
    },
    willDrawCell(data) {
      data.cell.text = visualCellLines(data.cell.text);
    },
    didParseCell(data) {
      if (data.row.index === body.length - 1 && data.section === "body") {
        data.cell.styles.fillColor = BRAND.totalRGB;
        data.cell.styles.textColor = BRAND.white;
        data.cell.styles.fontStyle = "bold";
      }
    },
    margin: { left: 8, right: 8 },
  });

  addPdfFooter(doc);

  const filename = `hiqbah-${title.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(filename);
}

export async function exportBatchesExcel(
  rows: BatchExportRow[],
  title = "Production Report",
  titleAr = "تقرير الإنتاج"
) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Hiqbah Coffee";
  wb.created = new Date();

  const ws = wb.addWorksheet(title, {
    views: [{ rightToLeft: true }],
  });

  const brandFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF5C5C38" },
  };
  const accentFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF4C4B2F" },
  };
  const whiteFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFFFFF" },
  };
  const altFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF8F5EE" },
  };
  const whiteFont: Partial<ExcelJS.Font> = {
    name: "Cairo",
    size: 11,
    bold: true,
    color: { argb: "FFFFFFFF" },
  };
  const bodyFont: Partial<ExcelJS.Font> = {
    name: "Cairo",
    size: 10,
    color: { argb: "FF28241A" },
  };
  const headerBorder: Partial<ExcelJS.Borders> = {
    bottom: { style: "medium", color: { argb: "FFBD7D47" } },
  };

  const XL_AR = [
    "رقم الدفعة", "التاريخ", "العميل", "رقم الطلب", "نوع البن",
    "الكمية الخضراء (كجم)", "الكمية المحمصة (كجم)", "الهالك (كجم)",
    "ملف التحميص", "الحالة", "أكياس 3كجم", "أكياس 1كجم",
    "أكياس 250جم", "أكياس 150جم", "عينات (جم)",
  ];
  const XL_EN = [
    "Batch #", "Date", "Customer", "Order #", "Bean Type",
    "Green (kg)", "Roasted (kg)", "Waste (kg)", "Roast Profile",
    "Status", "3kg Bags", "1kg Bags", "250g Bags", "150g Bags", "Samples (g)",
  ];

  const titleRow = ws.addRow([`${titleAr} — ${title}`]);
  ws.mergeCells(1, 1, 1, 15);
  titleRow.getCell(1).font = { name: "Cairo", size: 14, bold: true, color: { argb: "FFFFFFFF" } };
  titleRow.getCell(1).fill = brandFill;
  titleRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
  titleRow.height = 30;

  const subRow = ws.addRow([
    `حِقبة للقهوة المختصة | Hiqbah Specialty Coffee | ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`,
  ]);
  ws.mergeCells(2, 1, 2, 15);
  subRow.getCell(1).font = { name: "Cairo", size: 9, color: { argb: "FF5C5C38" } };
  subRow.getCell(1).alignment = { horizontal: "center" };
  subRow.height = 20;

  ws.addRow([]);

  const arRow = ws.addRow(XL_AR);
  const enRow = ws.addRow(XL_EN);

  [arRow, enRow].forEach((row) => {
    row.height = 22;
    row.eachCell((cell) => {
      cell.font = whiteFont;
      cell.fill = brandFill;
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = headerBorder;
    });
  });

  rows.forEach((r, i) => {
    const row = ws.addRow([
      r.batchNumber,
      r.date,
      r.customer,
      r.orderNumber,
      r.beanType,
      r.greenBeanQuantity,
      r.roastedBeanQuantity,
      r.wasteQuantity,
      r.roastProfile || "-",
      r.status,
      r.bags3kg,
      r.bags1kg,
      r.bags250g,
      r.bags150g,
      r.samplesGrams,
    ]);
    row.eachCell((cell) => {
      cell.font = bodyFont;
      cell.fill = i % 2 === 0 ? whiteFill : altFill;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = {
        bottom: { style: "thin", color: { argb: "FFEFEADF" } },
      };
    });
  });

  const totalGreen = rows.reduce((s, r) => s + r.greenBeanQuantity, 0);
  const totalRoasted = rows.reduce((s, r) => s + r.roastedBeanQuantity, 0);
  const totalWaste = rows.reduce((s, r) => s + r.wasteQuantity, 0);
  const totalBags3 = rows.reduce((s, r) => s + r.bags3kg, 0);
  const totalBags1 = rows.reduce((s, r) => s + r.bags1kg, 0);
  const totalBags250 = rows.reduce((s, r) => s + r.bags250g, 0);
  const totalBags150 = rows.reduce((s, r) => s + r.bags150g, 0);
  const totalSamples = rows.reduce((s, r) => s + r.samplesGrams, 0);

  const sumRow = ws.addRow([
    "الإجمالي",
    "",
    "",
    "",
    "",
    +totalGreen.toFixed(2),
    +totalRoasted.toFixed(2),
    +totalWaste.toFixed(2),
    "",
    "",
    totalBags3,
    totalBags1,
    totalBags250,
    totalBags150,
    totalSamples,
  ]);
  sumRow.height = 24;
  sumRow.eachCell((cell) => {
    cell.font = { ...whiteFont, size: 10 };
    cell.fill = accentFill;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  const colWidths = [16, 14, 22, 10, 22, 14, 14, 12, 16, 14, 10, 10, 10, 10, 12];
  colWidths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hiqbah-${title.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
