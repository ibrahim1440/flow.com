import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { LANG_COOKIE, asLang } from "@/lib/i18n/language-switch";
import { taglineFromRow } from "@/lib/login-tagline";
import { LoginLangContext, LoginTaglineContext } from "./lang-context";

// The sign-in screen is Direction 2.1 (IBM Plex + the Amiri brand line, linked by the page
// itself from public/fonts); it no longer loads the legacy Tajawal face.
//
// Quick language switch (owner, 25 Oct 2026): the screen opens in the language last chosen in
// this browser — its own «English / العربية» toggle, or the account's saved language written
// with the last session cookie — read here so the first paint is already in that language.
//
// The brand line (owner language decision 1, 26 Oct 2026) follows the language and may be replaced
// per language in Settings › Organisation. Only its two columns are read — a signed-out visitor is
// never handed any other part of the configuration row — and any failure (the database unreachable,
// the migration not applied yet) falls back to the built-in line: the sign-in screen must always draw.
async function readTagline(): Promise<{ ar: string; en: string }> {
  try {
    const row = await prisma.systemConfig.findUnique({ where: { id: "singleton" }, select: { loginTaglineAr: true, loginTaglineEn: true } });
    return taglineFromRow(row).effective;
  } catch {
    return taglineFromRow(null).effective;
  }
}

export default async function LoginLayout({ children }: { children: ReactNode }) {
  const [saved, tagline] = await Promise.all([cookies().then((c) => asLang(c.get(LANG_COOKIE)?.value)), readTagline()]);
  return (
    <LoginLangContext value={saved}>
      <LoginTaglineContext value={tagline}>{children}</LoginTaglineContext>
    </LoginLangContext>
  );
}
