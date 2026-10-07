"use client";

import { use, useEffect, useState } from "react";
import { Alert, Spinner, api, useLang } from "../../../sales/_components/ui";
import { RuleEditor, type StoredRule } from "../../_components/RuleEditor";

export default function EditAutomationRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const ar = useLang() === "ar";
  const [rule, setRule] = useState<StoredRule | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api<{ rule: StoredRule }>(`/api/automation/rules/${id}`).then((r) => {
      if (cancelled) return;
      if (r.ok) setRule(r.data.rule);
      else setError(r.data.error ?? (ar ? "تعذر تحميل القاعدة." : "Could not load the rule."));
    });
    return () => {
      cancelled = true;
    };
  }, [id, ar]);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!rule) return <Spinner />;
  return <RuleEditor key={rule.id} rule={rule} />;
}
