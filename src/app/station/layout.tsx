// Workstations (Phase 9) — the /station root. A server layout only for the head: the web app
// manifest and the Apple web-app tags apply to /station and nothing else (owner decision D11: an
// iPad or Android tablet at the roaster, «إضافة إلى الشاشة الرئيسية» opens the station full screen
// in landscape). The ERP's own head is untouched. Everything else is the client shell.
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { StationShell } from "./_ui/shell";

export const metadata: Metadata = {
  // Both names, like the ERP's own title: the tab reads in either language.
  title: "Hiqbah Station | محطة حِقبة",
  manifest: "/station/manifest.webmanifest",
  appleWebApp: { capable: true, title: "محطة حقبة", statusBarStyle: "default" },
  // Older iPadOS reads only the Apple-prefixed tag to open a home-screen page without Safari's bars.
  other: { "apple-mobile-web-app-capable": "yes" },
  icons: { apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
};

export const viewport: Viewport = {
  themeColor: "#F8F5EE",
  width: "device-width",
  initialScale: 1,
  // A shared tablet: no accidental pinch-zoom that leaves the station half off the screen.
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function StationLayout({ children }: { children: ReactNode }) {
  return <StationShell>{children}</StationShell>;
}
