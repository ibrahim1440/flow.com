import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Noto_Sans, Noto_Sans_Arabic } from "next/font/google";
import { verifyToken } from "@/lib/auth";
import "./globals.css";

// The two families the design system's type ramp is built on. next/font
// self-hosts them, so there is no request to Google on first paint and no
// layout shift from a late-arriving webfont — the previous <link> to
// fonts.googleapis.com cost a connection to a third party on every load.
// Weights match the ramp: Regular, Medium, SemiBold, Bold.
const notoSans = Noto_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-sans",
  display: "swap",
});

const notoSansArabic = Noto_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-sans-arabic",
  display: "swap",
});

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
    <html
      lang={lang}
      dir={dir}
      className={`h-full antialiased ${notoSans.variable} ${notoSansArabic.variable}`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
