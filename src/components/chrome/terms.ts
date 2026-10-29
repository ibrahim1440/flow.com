"use client";
// `useTerm()` — the glossary (`@/lib/nav/glossary`) for a page: Qoyod's word inside the accountant workspace, ours elsewhere.
import { useCallback } from "react";
import { useI18n } from "@/lib/i18n/context";
import { term, type TermKey } from "@/lib/nav/glossary";
import { useWorkspaceMode } from "@/components/shell/workspace-mode";

export function useTerm() {
  const { lang } = useI18n();
  const { accountant } = useWorkspaceMode();
  return useCallback((key: TermKey) => term(key, lang, accountant), [lang, accountant]);
}
