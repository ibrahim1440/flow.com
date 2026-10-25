import type { Metadata } from "next";
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/auth";
import { LANG_COOKIE, asLang } from "@/lib/i18n/language-switch";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hiqbah Coffee | محمصة حِقبة",
  description: "Internal production management system for Hiqbah Coffee Roasters",
  // Brand guideline v003: the «ح» mark (olive «ح», clay stroke) on a sand tile, so it reads on
  // light and dark tab bars. `app/favicon.ico` (16/32/48) is rendered from the same SVG.
  icons: {
    icon: [{ url: "/brand/hiqbah-app-icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read language preference from the JWT — no extra DB query needed
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  const user = token ? await verifyToken(token) : null;
  // Signed out: the language the sign-in screen last used (`hq_lang`, the quick language switch);
  // signed in, the account's saved language from the token always wins.
  const lang = user?.preferredLanguage ?? asLang(cookieStore.get(LANG_COOKIE)?.value) ?? "ar";
  const dir = lang === "ar" ? "rtl" : "ltr";

  return (
    <html lang={lang} dir={dir} className="h-full antialiased">
      <head>
        {/* Fonts are self-hosted (public/fonts) and loaded where they are used: IBM Plex by the
            Direction 2.1 shell (components/shell/AppShell). No third-party font origin is contacted. */}
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
