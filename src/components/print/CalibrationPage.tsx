"use client";
/**
 * «Print calibration page» (design §P2-3): one page of the selected profile's paper with 1:1 mm
 * rulers along the top and left edges, every slot outlined with its size, and a 50 mm reference
 * square. Printed at 100 % with margins None, it shows the printer's real scale, offset and
 * non-printable edge, so the profile's scale and calibration X / Y can be corrected. It carries no
 * ERP data. Drawn as one SVG whose user unit is the millimetre.
 */
import { pageSize, sheetSlots, type LayoutProfile } from "@/lib/print/layout";
import { cssMm, fmtMm } from "@/lib/print/units";

export function CalibrationSvg({ profile, title }: { profile: LayoutProfile; title: string }) {
  const { w, h } = pageSize(profile);
  const slots = sheetSlots(profile);
  const ticks = (len: number) => Array.from({ length: Math.floor(len) + 1 }, (_, i) => i);
  const sq = Math.min(50, w - 20, h - 20);
  const sx = Math.max(8, (w - sq) / 2), sy = Math.max(8, (h - sq) / 2);
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${w} ${h}`} width={cssMm(w)} height={cssMm(h)} data-testid="calibration-svg"
      style={{ display: "block", fontFamily: "IBM Plex Sans, sans-serif" }}>
      <rect x={0} y={0} width={w} height={h} fill="#fff" />
      {/* Slot outlines (where labels print) */}
      {slots.map((s) => (
        <g key={s.slot}>
          <rect x={s.xMm} y={s.yMm} width={s.wMm} height={s.hMm} fill="none" stroke="#000" strokeWidth={0.2} />
          {s.wMm >= 20 && s.hMm >= 10 ? (
            <text x={s.xMm + s.wMm / 2} y={s.yMm + s.hMm - 2} fontSize={2.2} textAnchor="middle">{`${s.slot} · ${fmtMm(s.wMm)} × ${fmtMm(s.hMm)} mm`}</text>
          ) : null}
        </g>
      ))}
      {/* Top ruler */}
      {ticks(w).map((i) => (
        <line key={`t${i}`} x1={i} y1={0} x2={i} y2={i % 10 === 0 ? 4 : i % 5 === 0 ? 2.5 : 1.5} stroke="#000" strokeWidth={0.12} />
      ))}
      {ticks(w).filter((i) => i % 10 === 0 && i > 0 && i < w - 3).map((i) => <text key={`tl${i}`} x={i + 0.5} y={6.2} fontSize={2}>{i}</text>)}
      {/* Left ruler */}
      {ticks(h).map((i) => (
        <line key={`l${i}`} x1={0} y1={i} x2={i % 10 === 0 ? 4 : i % 5 === 0 ? 2.5 : 1.5} y2={i} stroke="#000" strokeWidth={0.12} />
      ))}
      {ticks(h).filter((i) => i % 10 === 0 && i > 0 && i < h - 3).map((i) => <text key={`ll${i}`} x={4.6} y={i + 0.7} fontSize={2}>{i}</text>)}
      {/* Reference square */}
      {/* Solid, so the PDF keeps it as one stroked path the tests can measure (50 mm ± 0.2). */}
      <rect x={sx} y={sy} width={sq} height={sq} fill="none" stroke="#000" strokeWidth={0.25} data-testid="calibration-square" />
      <text x={sx + sq / 2} y={sy + sq / 2 - 1} fontSize={3} textAnchor="middle" fontWeight={600}>{`${fmtMm(sq)} mm`}</text>
      <text x={sx + sq / 2} y={sy + sq / 2 + 3} fontSize={2} textAnchor="middle">{title}</text>
      <text x={sx + sq / 2} y={sy + sq / 2 + 6} fontSize={1.8} textAnchor="middle">{`${fmtMm(w)} × ${fmtMm(h)} mm · scale ${profile.scalePct}% · X ${fmtMm(profile.offsetXMm)} / Y ${fmtMm(profile.offsetYMm)} mm`}</text>
    </svg>
  );
}
