"use client";

import { createContext, useContext } from "react";
import type { Permissions } from "@/lib/auth-shared";
import type { Lang } from "@/lib/i18n/translations";

export type User = { id: string; name: string; role: string; permissions: Permissions; preferredLanguage: Lang; privileged?: boolean; username?: string | null; mfaEnrollmentRequired?: boolean; passwordChangeRequired?: boolean; classicHome?: boolean; homeSetByAdmin?: boolean };
export type AppCtx = { user: User };
export const UserContext = createContext<AppCtx | null>(null);
export const useUser = () => useContext(UserContext)?.user ?? null;
