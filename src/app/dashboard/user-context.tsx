"use client";

import { createContext, useContext } from "react";
import type { Permissions } from "@/lib/auth-shared";
import type { Lang } from "@/lib/i18n/translations";

export type User = { id: string; name: string; role: string; permissions: Permissions; preferredLanguage: Lang };
export type AppCtx = { user: User; logoBase64: string | null };
export const UserContext = createContext<AppCtx | null>(null);
export const useUser = () => useContext(UserContext)?.user ?? null;
export const useLogo = () => useContext(UserContext)?.logoBase64 ?? null;
