import Link from "next/link";
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/auth";
import { LANG_COOKIE, asLang } from "@/lib/i18n/language-switch";

/**
 * The 404 page, in the viewer's language. Without it Next.js drew its own English
 * "404 · This page could not be found." on an Arabic screen. The language is read the way the
 * root layout reads it: the signed-in account's language from the token, else the sign-in
 * screen's last choice (`hq_lang`), else Arabic.
 */
export default async function NotFound() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  const user = token ? await verifyToken(token) : null;
  const lang = user?.preferredLanguage ?? asLang(cookieStore.get(LANG_COOKIE)?.value) ?? "ar";
  const ar = lang === "ar";
  return (
    <main dir={ar ? "rtl" : "ltr"} lang={lang} style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ textAlign: "center" }}>
        <p style={{ fontSize: 48, fontWeight: 700, margin: 0 }}>404</p>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: "8px 0 16px" }}>{ar ? "الصفحة غير موجودة." : "This page could not be found."}</h1>
        <Link href={user ? "/dashboard" : "/login"} style={{ textDecoration: "underline" }}>{user ? (ar ? "العودة إلى الرئيسية" : "Back to home") : (ar ? "تسجيل الدخول" : "Sign in")}</Link>
      </div>
    </main>
  );
}
