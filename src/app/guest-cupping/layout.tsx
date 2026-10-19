import type { ReactNode } from "react";

// Guest cupping is Direction 2.1 (GX-G G-08): IBM Plex is linked by the page itself
// (GuestShell, from public/fonts) and the shared tokens come from direction-2.1.css; the legacy
// Tajawal face is no longer loaded here. guest-qc keeps its own legacy layout.
export default function GuestCuppingLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
