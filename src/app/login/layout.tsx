import type { ReactNode } from "react";

// The sign-in screen is Direction 2.1 (IBM Plex + the Amiri brand line, linked by the page
// itself from public/fonts); it no longer loads the legacy Tajawal face.
export default function LoginLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
