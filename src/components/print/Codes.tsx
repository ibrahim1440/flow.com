"use client";
/**
 * The barcode and the QR code on a printed label, drawn as SVG in millimetres (crisp at any printer resolution, the
 * same element in the preview and the print). Code 128 / EAN-13 bars come from JsBarcode's encoder (its object
 * renderer: the bar pattern only, no DOM); the QR code from qrcode.react, already in the application.
 */
import JsBarcode from "jsbarcode";
import { QRCodeSVG } from "qrcode.react";
import { isValidEan13 } from "@/lib/scan/codes";

/** The bar pattern ("1" = bar module) of a value, or null when it cannot be encoded. Pure; unit-tested. */
export function barPattern(value: string, format: "CODE128" | "EAN13" = "CODE128"): { modules: string } | null {
  const out: { encodings?: { data: string }[] } = {};
  try {
    JsBarcode(out, value, { format, flat: true } as never);
  } catch {
    return null;
  }
  const modules = (out.encodings ?? []).map((e) => e.data).join("");
  return modules ? { modules } : null;
}

/**
 * A barcode `widthMm` wide and `heightMm` tall, with a quiet zone of 10 modules each side (scanners need it). The
 * module width is what is left divided by the module count; a printer at 203 dpi resolves 0.125 mm, so keep the module
 * ≥ 0.25 mm (a 9-character Code 128 needs about 40 mm). `text` prints the human-readable line under the bars.
 */
export function Barcode({ value, widthMm, heightMm, text = true, testId }: { value: string; widthMm: number; heightMm: number; text?: boolean; testId?: string }) {
  const format = isValidEan13(value) ? "EAN13" : "CODE128";
  const p = barPattern(value, format);
  if (!p) return null;
  const quiet = 10;
  const total = p.modules.length + 2 * quiet;
  const textH = text ? Math.min(3.2, heightMm * 0.28) : 0;
  const barsH = heightMm - textH;
  const rects: { x: number; w: number }[] = [];
  for (let i = 0; i < p.modules.length; i++) {
    if (p.modules[i] !== "1") continue;
    const last = rects[rects.length - 1];
    if (last && last.x + last.w === quiet + i) last.w += 1;
    else rects.push({ x: quiet + i, w: 1 });
  }
  return (
    <svg className="pl-barcode" data-testid={testId} data-value={value} data-format={format} role="img" aria-label={value}
      viewBox={`0 0 ${total} ${heightMm * (total / widthMm)}`} width={`${widthMm}mm`} height={`${heightMm}mm`} preserveAspectRatio="none"
      shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width={total} height={heightMm * (total / widthMm)} fill="#fff" />
      {rects.map((r) => <rect key={r.x} x={r.x} y="0" width={r.w} height={barsH * (total / widthMm)} fill="#000" />)}
      {text ? (
        <text x={total / 2} y={(heightMm - textH * 0.12) * (total / widthMm)} textAnchor="middle" fontFamily="ui-monospace, Menlo, Consolas, monospace"
          fontSize={textH * 0.92 * (total / widthMm)} fill="#000" letterSpacing={0.6}>{value}</text>
      ) : null}
    </svg>
  );
}

/** A QR code `sizeMm` square (error correction M: survives a scuffed sack). */
export function QrCode({ value, sizeMm, testId }: { value: string; sizeMm: number; testId?: string }) {
  return (
    <span className="pl-qr" data-testid={testId} data-value={value} style={{ width: `${sizeMm}mm`, height: `${sizeMm}mm` }}>
      <QRCodeSVG value={value} level="M" marginSize={1} style={{ width: "100%", height: "100%" }} />
    </span>
  );
}
