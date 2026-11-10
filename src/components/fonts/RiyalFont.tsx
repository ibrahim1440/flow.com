import { preload } from "react-dom";

// The official riyal sign «⃁» (U+20C1) — public/fonts/saudi-riyal.css, a face for that one character, first in the app's
// font stacks. Both files are tiny (one glyph) and are PRELOADED (gate L4): the sign is on almost every page, and if its
// file has not arrived the browser draws an empty box — there is no reliable per-glyph fallback (no system font carries
// U+20C1 yet), so the only defence is to fetch it early. Server- and client-safe (react-dom preload, deduplicated).
const FILES = ["/fonts/saudi-riyal/saudi_riyal-regular.woff2", "/fonts/saudi-riyal/saudi_riyal-bold.woff2"];

export function RiyalFont() {
  for (const href of FILES) preload(href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  return <link rel="stylesheet" precedence="default" href="/fonts/saudi-riyal.css" />;
}
