import type { ReactNode } from "react";
import { headers } from "next/headers";
import { langFromAcceptLanguage } from "@/lib/i18n/browser-lang";
import { GuestLangContext } from "../guest-cupping/guest-lang";

// Guest QC is Direction 2.1 (UI batch 2): it renders in the guest frame (guest-cupping/GuestShell),
// which links IBM Plex from public/fonts and carries the shared tokens (direction-2.1.css); the
// legacy Tajawal face is no longer loaded here.
//
// Owner language decision 2: a guest link opens in the guest's browser language (Accept-Language:
// Arabic when it is Arabic, otherwise English); the page's toggle still switches.
export default async function GuestQcLayout({ children }: { children: ReactNode }) {
  const lang = langFromAcceptLanguage((await headers()).get("accept-language"));
  return <GuestLangContext value={lang}>{children}</GuestLangContext>;
}
