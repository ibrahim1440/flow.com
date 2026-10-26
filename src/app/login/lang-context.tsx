"use client";
import { createContext } from "react";
import type { Lang } from "@/lib/i18n/translations";
import { DEFAULT_LOGIN_TAGLINE } from "@/lib/login-tagline";

/** The `hq_lang` cookie as the server read it (null: none yet). Lets the first paint use it. */
export const LoginLangContext = createContext<Lang | null>(null);

/**
 * The sign-in line in force, per language (owner language decision 1): what Settings › Organisation
 * stored, else the built-in line. Read by the server layout, so the page needs no request for it.
 */
export const LoginTaglineContext = createContext<{ ar: string; en: string }>({ ...DEFAULT_LOGIN_TAGLINE });
