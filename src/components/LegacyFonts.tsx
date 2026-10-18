/**
 * The legacy stylesheet face (Tajawal, `globals.css`). Rendered by the legacy surfaces only —
 * the legacy dashboard shell and the guest pages — and hoisted into <head> by React
 * (`precedence`), so a Direction 2.1 route (HR, self-service, the operations screens) never
 * fetches it: those render IBM Plex from the shared shell tokens.
 *
 * Self-hosted (public/fonts/tajawal.css): the same weights, files and unicode-range subsets
 * Google Fonts served, so nothing is fetched from a third party.
 */
export function LegacyFonts() {
  return <link rel="stylesheet" precedence="legacy-fonts" href="/fonts/tajawal.css" />;
}
