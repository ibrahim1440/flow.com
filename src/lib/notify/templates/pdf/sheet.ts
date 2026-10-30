// The A4 business document as a PDF, drawn on the server (feature/email-demo).
//
// The app prints its quotation and tax invoice from the browser (components/print/document/
// DocumentSheet + «طباعة / حفظ PDF»); there is no headless browser on the server to turn that page
// into a file. This module draws the SAME sheet with jsPDF so an e-mail can carry it as an
// attachment: the same parts in the same places (logo and seller at the start, the title block at
// the end, the banner, the two meta lists, the lines table with its header repeated on every page,
// the totals box at the end edge, notes, bank details, the running footer «الصفحة X من Y» with the
// document number), the same measurements (document.css at 794 px = 595 pt: ×0.75), the same
// Direction 2.1 colours and the same face — IBM Plex Sans Arabic, 400 and 600 (lib/fonts/
// plex-arabic-pdf-base64.ts, built from the self-hosted files by scripts/fonts/build-pdf-plex.py).
// The content — the column set, each cell, the titles, dates and amounts — comes from the print
// helpers the browser document uses (lib/print/quote-document.ts, lib/print/invoice-document.ts).
//
// jsPDF does no OpenType shaping or bidi: every Arabic string is shaped to the presentation forms
// (arabic-reshaper) and put in visual order (bidi-js, paragraph direction RTL) before it is drawn,
// and jsPDF is told the text is already visual. Diacritics are dropped (the reshaper does not
// position marks). Latin and numeric runs keep their left-to-right order inside Arabic text.
import { jsPDF } from "jspdf";
import { convertArabic } from "arabic-reshaper";
import bidiFactory from "bidi-js";
import { PlexArabicRegular, PlexArabicSemiBold } from "@/lib/fonts/plex-arabic-pdf-base64";
import { splitLtrRuns } from "@/lib/print/bidi";
import { HIQBAH_LOGO_PNG_BASE64, HIQBAH_LOGO_PNG_SIZE } from "./logo-png";

const bidi = bidiFactory();

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const MARKS = /[ً-ٰٟۖ-ۭ]/g;

/**
 * jsPDF runs its own Arabic pass on every string (preProcessText → processArabic), and its ligature
 * step reads the string left to right: in VISUAL order a lam form followed by an alef form is the
 * logical «ال»/«ا…ل» seen backwards («صالح» drew as «صلاح»). A zero-width non-joiner between them
 * (an empty glyph added to the font for this) keeps jsPDF from fusing them; the true «لا» ligatures
 * are already made by the reshaper.
 */
const FALSE_LAM_ALEF = /([\uFEDF\uFEE0])(?=[\uFE82\uFE84\uFE88\uFE8E])|(\uFE8D)(?=\uFEDF)/g;

/**
 * Logical text → the glyph string jsPDF draws (shaped, visual order). Pure LTR text is returned as is.
 * Each Latin / numeric run is isolated left-to-right first (LRI … PDI), as the print documents wrap it
 * in <bdi>: without it «15%» after an Arabic word reads «%15» (UBA W2 turns the number into an Arabic
 * number and the percent sign falls to the paragraph direction).
 */
export function visual(text: string): string {
  if (!ARABIC.test(text)) return text;
  const isolated = splitLtrRuns(text.replace(MARKS, "")).map((r) => (r.ltr ? `\u2066${r.text}\u2069` : r.text)).join("");
  const shaped = convertArabic(isolated);
  const levels = bidi.getEmbeddingLevels(shaped, "rtl");
  return bidi.getReorderedString(shaped, levels).replace(/[\u2066-\u2069]/g, "").replace(FALSE_LAM_ALEF, (_m, a, b) => `${a ?? b}\u200C`);
}

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  primary: hex("#28241a"), secondary: hex("#4a473d"), muted: hex("#6e6a61"),
  rule: hex("#efeadf"), ruleStrong: hex("#e3dccb"),
  warningTint: hex("#fbf2da"), dangerTint: hex("#fcebe8"), danger: hex("#b42318"),
  // rgba(163, 68, 53, 0.13) over white (document.css .dsh-watermark).
  watermark: [243, 231, 229] as RGB,
};

export type SheetRow = { label: string; value: string; mono?: boolean; muted?: boolean };
export type SheetColumn = { key: string; label: string; numeric: boolean; muted?: boolean; /** Width weight; the description column takes what is left. */ width?: number };
export type SheetCell = { main: string; sub?: string | null };
export type SheetTotal = { label: string; value: string; grand?: boolean };

export type SheetInput = {
  seller: { name: string | null; lines: string[] } | null;
  title: { main: string; lines: string[] };
  banner?: { tone: "warning" | "danger"; title: string; text?: string | null } | null;
  /** The diagonal mark across every page (a draft, a demo). */
  watermark?: string | null;
  metaStart: SheetRow[];
  metaEnd: SheetRow[];
  columns: SheetColumn[];
  rows: SheetCell[][];
  totals?: SheetTotal[];
  /** Short sections after the totals: a heading and its lines. */
  extra?: { title: string; lines: string[] }[];
  notes?: { label: string; text: string } | null;
  bank?: { label: string; rows: SheetRow[] } | null;
  footer: { legal: string; status?: string | null; docNumber: string };
  /** Document properties (title / subject in the PDF info). */
  info?: { title: string; subject?: string };
};

// A4 in points; document.css measures × 0.75.
const W = 595.28, H = 841.89;
const MX = 36, TOP = 30, FOOT = 62;
const START = W - MX, END = MX, CW = W - 2 * MX;
const PX = 0.75;

class Sheet {
  doc: jsPDF;
  y = TOP;
  constructor() {
    this.doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
    this.doc.addFileToVFS("PlexArabic-Regular.ttf", PlexArabicRegular);
    this.doc.addFont("PlexArabic-Regular.ttf", "PlexArabic", "normal");
    this.doc.addFileToVFS("PlexArabic-SemiBold.ttf", PlexArabicSemiBold);
    this.doc.addFont("PlexArabic-SemiBold.ttf", "PlexArabic", "bold");
    this.doc.setFont("PlexArabic", "normal");
  }
  font(size: number, bold = false, color: RGB = C.primary) {
    this.doc.setFont("PlexArabic", bold ? "bold" : "normal");
    this.doc.setFontSize(size);
    this.doc.setTextColor(color[0], color[1], color[2]);
  }
  width(t: string, size: number, bold = false) {
    this.doc.setFont("PlexArabic", bold ? "bold" : "normal");
    this.doc.setFontSize(size);
    return this.doc.getTextWidth(visual(t));
  }
  /** Draw logical text; align is the physical edge x refers to. */
  text(t: string, x: number, y: number, o: { size: number; bold?: boolean; color?: RGB; align?: "right" | "left" | "center"; angle?: number }) {
    if (!t) return;
    this.font(o.size, o.bold, o.color ?? C.primary);
    const opts = { align: o.align ?? "right", isInputVisual: true, isOutputVisual: true, ...(o.angle ? { angle: o.angle } : {}) };
    (this.doc.text as unknown as (t: string, x: number, y: number, o: object) => void)(visual(t), x, y, opts);
  }
  /** Greedy word wrap of logical text to a width. */
  wrap(t: string, maxW: number, size: number, bold = false): string[] {
    const out: string[] = [];
    for (const para of t.split("\n")) {
      const words = para.split(/\s+/).filter(Boolean);
      let line = "";
      for (const w of words) {
        const cand = line ? `${line} ${w}` : w;
        if (line && this.width(cand, size, bold) > maxW) { out.push(line); line = w; } else line = cand;
      }
      out.push(line);
    }
    return out;
  }
  hline(x1: number, x2: number, y: number, color: RGB, w = 0.75) {
    this.doc.setDrawColor(color[0], color[1], color[2]);
    this.doc.setLineWidth(w);
    this.doc.line(x1, y, x2, y);
  }
  watermark(t: string) {
    // Centered on the page, rotated 24° (document.css: rotate(-24deg) in screen space = 24° counter-clockwise here).
    // 54 px as drawn on screen, smaller when the text would run off the sheet (a long mark).
    const size = Math.min(54 * PX, (54 * PX * 560) / this.width(t, 54 * PX, true));
    const w = this.width(t, size, true);
    const a = (24 * Math.PI) / 180;
    const x = W / 2 - (Math.cos(a) * w) / 2;
    const y = H / 2 + (Math.sin(a) * w) / 2;
    this.text(t, x, y, { size, bold: true, color: C.watermark, align: "left", angle: 24 });
  }
  newPage(wm: string | null | undefined) {
    this.doc.addPage();
    if (wm) this.watermark(wm);
    this.y = TOP;
  }
  ensure(h: number, wm: string | null | undefined, onBreak?: () => void) {
    if (this.y + h > H - FOOT) { this.newPage(wm); onBreak?.(); }
  }
}

/** Label / value list at [right edge, width]; returns its height. */
function props(s: Sheet, rows: SheetRow[], right: number, width: number, y0: number): number {
  const size = 13.5 * PX, lh = 22 * PX, gap = 11 * PX, labelW = 132 * PX, sp = 12 * PX;
  let y = y0;
  for (const r of rows) {
    const vw = width - labelW - sp;
    const lines = s.wrap(r.value, vw, size);
    s.text(r.label, right, y + size, { size, color: C.muted });
    lines.forEach((l, i) => s.text(l, right - labelW - sp, y + size + i * lh, { size, color: r.muted ? C.muted : C.primary }));
    y += lines.length * lh + gap;
  }
  return rows.length ? y - y0 - gap : 0;
}

export function renderSheetPdf(p: SheetInput): Buffer {
  const s = new Sheet();
  const doc = s.doc;
  if (p.info) doc.setProperties({ title: p.info.title, subject: p.info.subject ?? "", creator: "Hiqbah ERP" });
  if (p.watermark) s.watermark(p.watermark);

  // Logo (start edge), 54 px high.
  const lh = 54 * PX, lw = (lh * HIQBAH_LOGO_PNG_SIZE.w) / HIQBAH_LOGO_PNG_SIZE.h;
  doc.addImage(HIQBAH_LOGO_PNG_BASE64, "PNG", START - lw, s.y, lw, lh);
  s.y += lh + 18 * PX;

  // Seller (start) | title (end).
  const headTop = s.y;
  let ySeller = headTop;
  if (p.seller) {
    const size = 13.5 * PX, l = 22 * PX;
    if (p.seller.name) { s.text(p.seller.name, START, ySeller + size, { size, bold: true }); ySeller += l; }
    for (const line of p.seller.lines) for (const w of s.wrap(line, 360 * PX, size)) { s.text(w, START, ySeller + size, { size, color: C.secondary }); ySeller += l; }
  }
  let yTitle = headTop;
  s.text(p.title.main, END, yTitle + 18 * PX, { size: 18 * PX, bold: true, align: "left" });
  yTitle += 25.2 * PX;
  for (const l of p.title.lines) { s.text(l, END, yTitle + 13.5 * PX, { size: 13.5 * PX, color: C.secondary, align: "left" }); yTitle += 22 * PX; }
  s.y = Math.max(ySeller, yTitle);

  // Banner.
  if (p.banner) {
    s.y += 15 * PX;
    const tSize = 18 * PX, bSize = 13.5 * PX, pad = 12 * PX;
    const textLines = p.banner.text ? s.wrap(p.banner.text, CW - 2 * 14 * PX, bSize) : [];
    const h = pad * 2 + 25.2 * PX + textLines.length * 22 * PX;
    const bg = p.banner.tone === "danger" ? C.dangerTint : C.warningTint;
    doc.setFillColor(bg[0], bg[1], bg[2]);
    doc.roundedRect(END, s.y, CW, h, 10 * PX, 10 * PX, "F");
    s.text(p.banner.title, START - 14 * PX, s.y + pad + tSize, { size: tSize, bold: true, color: p.banner.tone === "danger" ? C.danger : C.primary });
    textLines.forEach((l, i) => s.text(l, START - 14 * PX, s.y + pad + 25.2 * PX + bSize + i * 22 * PX, { size: bSize, color: C.secondary }));
    s.y += h;
  }

  // Rule, then the meta lists.
  s.y += 19 * PX;
  s.hline(END, START, s.y, C.rule);
  s.y += 16 * PX;
  const hStart = props(s, p.metaStart, START, Math.min(340 * PX, CW / 2), s.y);
  const endW = Math.min(330 * PX, CW / 2);
  const hEnd = props(s, p.metaEnd, END + endW, endW, s.y);
  s.y += Math.max(hStart, hEnd) + 22 * PX;

  // Lines table.
  const fixed = p.columns.reduce((n, c) => n + (c.key === "description" ? 0 : (c.width ?? 56)), 0);
  const widths = p.columns.map((c) => (c.key === "description" ? Math.max(120, CW - fixed) : (c.width ?? 56)));
  const scale = CW / widths.reduce((a, b) => a + b, 0);
  const cw = widths.map((w) => w * scale);
  const pad = 12 * PX * 0.6;
  const edges = (i: number) => {
    const right = START - cw.slice(0, i).reduce((a, b) => a + b, 0);
    return { right, left: right - cw[i] };
  };
  const header = () => {
    const hh = 36 * PX, size = 12.5 * PX;
    p.columns.forEach((c, i) => {
      const e = edges(i);
      const x = c.numeric ? e.left + (i === p.columns.length - 1 ? 0 : pad) : e.right - (i === 0 ? 0 : pad);
      s.text(c.label, x, s.y + hh / 2 + size * 0.35, { size, bold: false, color: C.muted, align: c.numeric ? "left" : "right" });
    });
    s.y += hh;
    s.hline(END, START, s.y, C.ruleStrong);
  };
  header();
  const size = 14 * PX * 0.92, subSize = 12.5 * PX * 0.92;
  for (const r of p.rows) {
    const mainLines = r.map((cell, i) => (p.columns[i].key === "description" ? s.wrap(cell.main, cw[i] - 2 * pad, size) : [cell.main]));
    const n = Math.max(...mainLines.map((l) => l.length));
    const hasSub = r.some((c) => !!c.sub);
    const rh = Math.max(40 * PX, 10 * PX + n * 16 + (hasSub ? 14 : 0));
    s.ensure(rh, p.watermark, header);
    r.forEach((cell, i) => {
      const c = p.columns[i];
      const e = edges(i);
      const x = c.numeric ? e.left + (i === p.columns.length - 1 ? 0 : pad) : e.right - (i === 0 ? 0 : pad);
      const align = c.numeric ? "left" : "right";
      const block = mainLines[i].length * 16 + (cell.sub ? 14 : 0);
      let ty = s.y + (rh - block) / 2 + size;
      for (const l of mainLines[i]) { s.text(l, x, ty, { size, color: c.muted ? C.muted : C.primary, align }); ty += 16; }
      if (cell.sub) s.text(cell.sub, x, ty - 2, { size: subSize, color: C.muted, align });
    });
    s.y += rh;
    s.hline(END, START, s.y, C.rule);
  }

  // Totals box (end edge): label at the start, amount at the end.
  if (p.totals?.length) {
    const bw = 300 * PX, right = END + bw, tSize = 14 * PX, gap = 8 * PX, l = 22 * PX;
    s.y += 18 * PX;
    s.ensure(p.totals.length * (l + gap) + 20, p.watermark);
    for (const t of p.totals) {
      if (t.grand) { s.y += 4 * PX; s.hline(END, right, s.y, C.rule); s.y += 10 * PX; }
      s.text(t.label, right, s.y + tSize, { size: tSize, bold: !!t.grand, color: t.grand ? C.primary : C.secondary });
      s.text(t.value, END, s.y + tSize, { size: tSize, bold: !!t.grand, color: t.grand ? C.primary : C.secondary, align: "left" });
      s.y += l + gap;
    }
  }

  for (const x of p.extra ?? []) {
    const lines = x.lines.flatMap((t) => s.wrap(t, CW, 13.5 * PX));
    s.y += 20 * PX;
    s.ensure(22 * PX + lines.length * 22 * PX, p.watermark);
    s.text(x.title, START, s.y + 12.5 * PX, { size: 12.5 * PX, color: C.muted });
    s.y += 22 * PX;
    for (const l of lines) { s.text(l, START, s.y + 13.5 * PX, { size: 13.5 * PX, color: C.secondary }); s.y += 22 * PX; }
  }

  if (p.notes) {
    const lines = s.wrap(p.notes.text, CW, 13.5 * PX);
    s.y += 25 * PX;
    s.ensure(22 * PX + lines.length * 28 * PX, p.watermark);
    s.text(p.notes.label, START, s.y + 12.5 * PX, { size: 12.5 * PX, color: C.muted });
    s.y += 26 * PX;
    for (const l of lines) { s.text(l, START, s.y + 13.5 * PX, { size: 13.5 * PX }); s.y += 28 * PX; }
  }

  if (p.bank && p.bank.rows.length) {
    s.y += 18 * PX;
    s.ensure(24 * PX + p.bank.rows.length * 33 * PX, p.watermark);
    s.text(p.bank.label, START, s.y + 12.5 * PX, { size: 12.5 * PX, color: C.muted });
    s.y += 24 * PX;
    s.y += props(s, p.bank.rows, START, 420 * PX, s.y);
  }

  // The running footer on every page: legal line and «الصفحة X من Y · status» (start), the document number (end).
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    const fy = H - 22 * 2.835 + 4;
    s.hline(END, START, fy, C.rule);
    const fs = 9.4;
    s.text(p.footer.legal, START, fy + 9 + fs, { size: fs, color: C.muted });
    s.text(`الصفحة ${i} من ${pages}${p.footer.status ? ` · ${p.footer.status}` : ""}`, START, fy + 9 + fs + 16.5 * 0.9, { size: fs, color: C.muted });
    s.text(p.footer.docNumber, END, fy + 9 + fs + 16.5 * 0.9, { size: fs, color: C.muted, align: "left" });
  }
  return Buffer.from(doc.output("arraybuffer"));
}
