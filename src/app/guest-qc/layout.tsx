import type { ReactNode } from "react";

// Guest QC is Direction 2.1 (UI batch 2): it renders in the guest frame (guest-cupping/GuestShell),
// which links IBM Plex from public/fonts and carries the shared tokens (direction-2.1.css); the
// legacy Tajawal face is no longer loaded here.
export default function GuestQcLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
