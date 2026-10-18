/* Generated from docs/design/direction-2.1-rc/src/screens.py ICONS — the reference icon set, path for path. */
import type { SVGProps } from "react";

const PATHS = {
  home: "<path d=\"M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z\"/>",
  inbox: "<path d=\"M4 13.5 6.5 5h11l2.5 8.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z\"/><path d=\"M4 13.5h4.5l1.2 2.5h4.6l1.2-2.5H20\"/>",
  pulse: "<path d=\"M3 12h4l2.5-6 5 12 2.5-6h4\"/>",
  orders: "<path d=\"M6 3h12v18l-3-2-3 2-3-2-3 2z\"/><path d=\"M9 8h6M9 12h6\"/>",
  flame: "<path d=\"M12 21c-4 0-6.5-2.6-6.5-6 0-3.6 3-5.6 3.5-9 2 1.4 3 3 3 4.5 1-1 1.6-2.2 1.7-3.6C16.5 9 18.5 11.6 18.5 15c0 3.4-2.5 6-6.5 6z\"/>",
  cup: "<path d=\"M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z\"/><path d=\"M16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5c0 1 1 1.5 1 2.5M11.5 3.5c0 1 1 1.5 1 2.5\"/>",
  box: "<path d=\"m12 3 8 4.5v9L12 21l-8-4.5v-9z\"/><path d=\"m4 7.5 8 4.5 8-4.5M12 12v9\"/>",
  truck: "<path d=\"M3 6h11v10H3zM14 9h4l3 3.5V16h-7\"/><circle cx=\"7\" cy=\"17.5\" r=\"1.8\"/><circle cx=\"17\" cy=\"17.5\" r=\"1.8\"/>",
  users: "<circle cx=\"9\" cy=\"8.5\" r=\"3.5\"/><path d=\"M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5\"/><path d=\"M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.8c1.8.7 3 2.5 3.5 5.2\"/>",
  deal: "<path d=\"M4 7h16v12H4z\"/><path d=\"M9 7V5h6v2M4 12h16\"/>",
  quote: "<path d=\"M7 3h7l5 5v13H7z\"/><path d=\"M14 3v5h5M10 13h6M10 17h4\"/>",
  wallet: "<path d=\"M4 7a2 2 0 0 1 2-2h11v4\"/><path d=\"M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2z\"/><path d=\"M16.5 14.5h.01\"/>",
  invoice: "<path d=\"M6 3h12v18H6z\"/><path d=\"M9 8h6M9 12h6M9 16h3\"/>",
  chart: "<path d=\"M4 20V4M4 20h16\"/><path d=\"M8 16v-5M12 16V8M16 16v-3\"/>",
  check: "<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"3\"/><path d=\"m8.5 12 2.5 2.5 4.5-5\"/>",
  settings: "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8\"/>",
  search: "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"m16 16 4 4\"/>",
  bell: "<path d=\"M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z\"/><path d=\"M10 20.5a2 2 0 0 0 4 0\"/>",
  plus: "<path d=\"M12 5v14M5 12h14\"/>",
  chev: "<path d=\"m9 6 6 6-6 6\"/>",
  chevd: "<path d=\"m6 9 6 6 6-6\"/>",
  back: "<path d=\"M5 12h14M13 6l6 6-6 6\"/>",
  more: "<circle cx=\"5.5\" cy=\"12\" r=\"1\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"18.5\" cy=\"12\" r=\"1\"/>",
  filter: "<path d=\"M4 6h16M7 12h10M10 18h4\"/>",
  cols: "<rect x=\"4\" y=\"5\" width=\"16\" height=\"14\" rx=\"2\"/><path d=\"M10 5v14M15 5v14\"/>",
  close: "<path d=\"m6 6 12 12M18 6 6 18\"/>",
  cal: "<rect x=\"4\" y=\"5\" width=\"16\" height=\"15\" rx=\"2\"/><path d=\"M4 10h16M9 3v4M15 3v4\"/>",
  phone: "<path d=\"M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z\"/>",
  flask: "<path d=\"M9 3h6M10 3v6L5 18a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3L14 9V3\"/><path d=\"M7.5 14h9\"/>",
  dl: "<path d=\"M12 4v11M7 10l5 5 5-5M5 20h14\"/>",
  note: "<path d=\"M5 4h14v12l-4 4H5z\"/><path d=\"M15 20v-4h4\"/>",
} as const;

export type D21IconName = keyof typeof PATHS;

/**
 * The reference icon (`.ico` 18px, or `.ico.s` 16px): stroke 1.5, currentColor, no fill — as in
 * the reference. The stroke attributes are set on the element itself, so the icon renders the
 * same inside the shell chrome (which loads no page stylesheet) as inside a page.
 */
export function Ico({ name, small, className = "", ...rest }: { name: D21IconName; small?: boolean; className?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      className={`ico${small ? " s" : ""} ${className}`.trim()}
      viewBox="0 0 24 24"
      width={small ? 16 : 18}
      height={small ? 16 : 18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
      {...rest}
    />
  );
}
