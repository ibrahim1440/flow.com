// Server layout for «مساحة عملي»: the Direction 2.1 viewport and the section's styles (scoped to `.d21`,
// which only the dashboard shell sets). No guard here: every route is any login, and the API scopes
// every read and write to the person.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "./_components/ws.css";

export const viewport = direction21Viewport;

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return children;
}
