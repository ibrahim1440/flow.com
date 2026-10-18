import type { ReactNode } from "react";
import { LegacyFonts } from "@/components/LegacyFonts";

// A legacy surface (Tajawal): the face is loaded here, not in the root layout, so the
// Direction 2.1 routes never fetch it (HR-D13).
export default function LegacyFontLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <LegacyFonts />
      {children}
    </>
  );
}
