import type { Metadata } from "next";
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/auth";
import { LANG_COOKIE, asLang } from "@/lib/i18n/language-switch";
import "./globals.css";

// Link previews (WhatsApp, iMessage, Slack… — owner, Nov 2026, option A): the activation link and every other link to the
// system unfurl as the brand card. og:image must be ABSOLUTE for crawlers, so `metadataBase` is the system's public
// address: APP_BASE_URL (the one the activation links and e-mails are built on), else the production URL Vercel gives,
// else the production domain. Crawlers fetch /brand/* and the sign-in pages without a session (there is no request
// middleware; those routes are public).
function publicBase(): URL {
  const own = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  try {
    return new URL(own || (vercel ? `https://${vercel}` : "https://www.beanflow.net"));
  } catch {
    return new URL("https://www.beanflow.net");
  }
}

const OG_TITLE = "حِقبة — نظام المحمصة";
const OG_DESCRIPTION = "سجّل دخولك إلى نظام محمصة حِقبة";
const OG_IMAGE = { url: "/brand/og-hiqbah-1200x630.png", width: 1200, height: 630, alt: "حِقبة", type: "image/png" };

export const metadata: Metadata = {
  metadataBase: publicBase(),
  title: OG_TITLE,
  description: OG_DESCRIPTION,
  openGraph: { title: OG_TITLE, description: OG_DESCRIPTION, images: [OG_IMAGE], type: "website", locale: "ar_SA", siteName: "حِقبة" },
  twitter: { card: "summary_large_image", title: OG_TITLE, description: OG_DESCRIPTION, images: [OG_IMAGE.url] },
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
