import type { NextConfig } from "next";
import path from "path";

/**
 * Response security headers.
 *
 * The application had none. The session cookie is SameSite=Lax, which means a page loaded
 * inside a frame on another origin is a fully authenticated page — so an attacker who can
 * get an operator to visit their site can overlay it on the dashboard and collect clicks on
 * whatever it likes: approve, cancel, delete. That is the gap these close first.
 *
 * ── Why the enforced CSP is small ──────────────────────────────────────────
 * The directives enforced below are the ones that cannot break a working page:
 * frame-ancestors (nobody may frame us), base-uri (no injected <base> can repoint relative
 * URLs), form-action (no form may post off-origin) and object-src (no plugins). None of
 * them constrains how this application already loads its own code.
 *
 * script-src is deliberately NOT enforced yet. Next.js App Router emits inline bootstrap
 * and streaming-payload scripts on every page, so an enforced script-src would have to
 * carry 'unsafe-inline' — which permits precisely the injection it is meant to stop, and
 * would be security theatre — or a per-request nonce threaded through the document. That
 * is a real change to how pages render and it deserves its own wave with its own
 * verification, not a line slipped into a hardening pass.
 *
 * So the full policy ships as Report-Only. It is honest about what it is: violations
 * surface in the browser console (and in a reporting endpoint once one exists) so the
 * policy can be tuned against real traffic before anyone turns it on. Clickjacking
 * protection is not deferred with it — that is enforced here and now, twice: via
 * frame-ancestors for modern browsers and X-Frame-Options for the rest.
 *
 * ── What the Report-Only policy allows, and why ────────────────────────────
 * Audited against what the application actually loads:
 *   - style/font from fonts.googleapis.com and fonts.gstatic.com — src/app/layout.tsx:26-29
 *     links the Tajawal stylesheet, which then fetches font files from gstatic.
 *   - img-src data: — the login page renders the configured logo from a base64 data URL
 *     (src/app/login/page.tsx:119), and QR codes are drawn to canvas.
 *   - blob: in img-src and connect-src — exports build files client-side and hand them over
 *     with URL.createObjectURL (src/lib/export.ts:426, history/page.tsx:183).
 *   - 'unsafe-inline' for styles — React sets element styles directly and Next injects
 *     <style> during hydration.
 * No WebSocket, no third-party script, no other external origin is used by the browser:
 * the translation API is called server-side only.
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  // See above: unsafe-inline here documents today's reality rather than endorsing it.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' blob:",
].join("; ");

/** Enforced now, because none of it can break a page that is already working. */
const CSP_ENFORCED = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  // Two years, subdomains included. Served over http in local development, where every
  // browser ignores it; it matters on the deployed origin, which is https-only.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // This application asks for none of these. Denying them costs nothing and removes them
  // from anything that later manages to run inside the page.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()",
  },
  { key: "Content-Security-Policy", value: CSP_ENFORCED },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
];

const nextConfig: NextConfig = {
  devIndicators: false,
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        // Every API response in this application is per-user operational data. None of it
        // may sit in a shared cache, and none of it should be revalidated from one either.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate" }],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/dashboard.html",        destination: "/dashboard",        permanent: false },
      { source: "/dashboard/:path*.html", destination: "/dashboard/:path*", permanent: false },
    ];
  },
};

export default nextConfig;
