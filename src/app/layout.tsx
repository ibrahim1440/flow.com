import type { Metadata } from "next";
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hiqbah Coffee | محمصة حِقبة",
  description: "Internal production management system for Hiqbah Coffee Roasters",
  icons: {
    icon: "/logo.svg",
    apple: "/logo.svg",
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read language preference from the JWT — no extra DB query needed
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  const user = token ? await verifyToken(token) : null;
  const lang = user?.preferredLanguage ?? "ar";
  const dir = lang === "ar" ? "rtl" : "ltr";

  return (
    <html lang={lang} dir={dir} className="h-full antialiased">
      <head>
        {/* Fonts are self-hosted (public/fonts) and loaded where they are used: IBM Plex by the
            Direction 2.1 shell (components/shell/AppShell), Tajawal (the legacy face) by the legacy
            surfaces (components/LegacyFonts). No third-party font origin is contacted. */}
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
