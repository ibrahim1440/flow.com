"use client";

// Accounting placeholder on the Direction 2.1 shell. The full module (Figma accounting batches
// 732:2 … 1001:2) is deferred by the owner; until it is built this page only says so.
import { OpsEmpty, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";

export default function AccountingPage() {
  const { t } = useI18n();
  const L = useL();

  return (
    <OpsRoot>
      <PageHeader title={t("accounting")} />
      <OpsEmpty
        title={L("نظام المحاسبة قيد التطوير", "The accounting module is under development")}
        body={L("ستتوفر هنا دفاتر الحسابات والقيود والتقارير المالية عند اكتماله.", "Accounts, journal entries and financial reports will be available here once it is ready.")}
      />
    </OpsRoot>
  );
}
