import type { Viewport } from "next";

/**
 * Viewport for the Direction 2.1 routes only (every route in ./routes.ts). `viewportFit: cover` makes
 * `env(safe-area-inset-*)` report the real insets, so the fixed phone tab bar, sticky action
 * bars and bottom sheets clear the home indicator; without it iOS reports 0. `resizes-content`
 * lets Android Chrome shrink the layout above the on-screen keyboard (iOS is handled by the
 * Dialog's visualViewport listener). Legacy modules keep the default viewport.
 */
export const direction21Viewport: Viewport = { viewportFit: "cover", interactiveWidget: "resizes-content" };
