/**
 * The Hiqbah brand mark in the UI chrome (brand guideline v003, branch `brand-assets`).
 *
 * The «ح» with its diacritic stroke, cut from `brand/logos/svg-trimmed/hiqbah-icon-0{1,2}-*.svg`
 * (paths unchanged; HIQBAH and the tagline left out — at 28–72 px they would be a smudge). Each
 * file has a square viewBox with the guideline's clear space (the height of the stroke) built in,
 * so the image simply fills its slot.
 *
 *   light  — olive «ح», clay stroke: white / sand surfaces (sidebar, phone header, guest, MFA).
 *   olive  — beige «ح», clay stroke: on the olive brand panel (sign-in). The guideline asks for
 *            beige on olive and for the stroke in clay so it stays visible.
 *
 * The logo uploaded in Settings (`/api/settings/logo`) no longer replaces this mark (owner
 * decision: the brand identity is fixed).
 */
export const BRAND_MARK_SRC = {
  light: "/brand/hiqbah-mark-olive-clay.svg",
  olive: "/brand/hiqbah-mark-beige-clay.svg",
} as const;

/** The full primary logo (wordmark «حِقبة» + HIQBAH + «قهوة لكل حِقبة») for white paper. */
export const BRAND_PRIMARY_SRC = "/brand/hiqbah-primary-olive-clay.svg";
/** viewBox of the primary logo (svg-trimmed), for its aspect ratio. */
export const BRAND_PRIMARY_VIEWBOX = { w: 1693.0, h: 746.5 } as const;

export function BrandMark({ tone = "light", size, alt = "" }: { tone?: keyof typeof BRAND_MARK_SRC; size?: number; alt?: string }) {
  return (
    // A static SVG from /public: next/image would add nothing but a wrapper.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={BRAND_MARK_SRC[tone]} alt={alt} width={size} height={size} draggable={false} decoding="async" />
  );
}
