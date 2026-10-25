import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { LANG_COOKIE, asLang } from "@/lib/i18n/language-switch";
import { LoginLangContext } from "./lang-context";

// The sign-in screen is Direction 2.1 (IBM Plex + the Amiri brand line, linked by the page
// itself from public/fonts); it no longer loads the legacy Tajawal face.
//
// Quick language switch (owner, 25 Oct 2026): the screen opens in the language last chosen in
// this browser — its own «English / العربية» toggle, or the account's saved language written
// with the last session cookie — read here so the first paint is already in that language.
export default async function LoginLayout({ children }: { children: ReactNode }) {
  const saved = asLang((await cookies()).get(LANG_COOKIE)?.value);
  return <LoginLangContext value={saved}>{children}</LoginLangContext>;
}
