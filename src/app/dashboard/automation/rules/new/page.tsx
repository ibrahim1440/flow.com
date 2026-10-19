"use client";

import { OpsRoot } from "@/components/ops/ui";
import { RuleEditor } from "../../_components/RuleEditor";

export default function NewAutomationRulePage() {
  return (
    <OpsRoot className="tl-root">
      <div className="hr-page">
        <RuleEditor rule={null} />
      </div>
    </OpsRoot>
  );
}
