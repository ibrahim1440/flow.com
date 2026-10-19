"use client";

import { use, useEffect, useState } from "react";
import { Notice, OpsLoading, OpsRoot } from "@/components/ops/ui";
import { api, useLang } from "../../../sales/_components/ui";
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

  return (
    <OpsRoot className="tl-root">
      <div className="hr-page">
        {error ? <Notice tone="danger">{error}</Notice> : !rule ? <OpsLoading /> : <RuleEditor key={rule.id} rule={rule} />}
      </div>
    </OpsRoot>
  );
}
