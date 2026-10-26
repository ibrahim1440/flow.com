import type { ReactNode } from "react";
import { headers } from "next/headers";
import { langFromAcceptLanguage } from "@/lib/i18n/browser-lang";
import { GuestLangContext } from "./guest-lang";

// Guest cupping is Direction 2.1 (GX-G G-08): IBM Plex is linked by the page itself
// (GuestShell, from public/fonts) and the shared tokens come from direction-2.1.css; the legacy
// Tajawal face is no longer loaded here. guest-qc keeps its own legacy layout.
//
// Owner language decision 2: a guest link opens in the guest's browser language (Accept-Language:
// Arabic when it is Arabic, otherwise English); the page's toggle still switches.
export default async function GuestCuppingLayout({ children }: { children: ReactNode }) {
  const lang = langFromAcceptLanguage((await headers()).get("accept-language"));
  return <GuestLangContext value={lang}>{children}</GuestLangContext>;
}
