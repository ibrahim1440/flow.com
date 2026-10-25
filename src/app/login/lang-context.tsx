"use client";
import { createContext } from "react";
import type { Lang } from "@/lib/i18n/translations";

/** The `hq_lang` cookie as the server read it (null: none yet). Lets the first paint use it. */
export const LoginLangContext = createContext<Lang | null>(null);
