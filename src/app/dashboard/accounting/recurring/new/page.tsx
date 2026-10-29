"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { OpsLoading } from "@/components/ops/ui";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { useUser } from "../../../user-context";
import { AcctShell, useApi, useLang, type Setup } from "../../_ui/shell";
import { RecurringForm, blankRecurring } from "../../_ui/recurring-form";

function NewRecurring() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const template = useSearchParams().get("template");
  const user = useUser();
  const canSales = !!user && hasModuleAccess(user.permissions, "sales") && hasSubPrivilege(user.permissions, "sales", "invoices_create");
  return (
    <AcctShell setup={setup.data} title={L("معاملة متكررة جديدة", "New recurring transaction")}
      meta={<Link href="/dashboard/accounting/recurring" className="acct-hint">→ {L("المعاملات المتكررة", "Recurring transactions")}</Link>}>
      {setup.data && !(setup.data.can.recurring && setup.data.can.journalCreate) ? <p role="alert" className="hr-err">{L("إنشاء المعاملات المتكررة يحتاج صلاحيتي «القيود السهلة والمعاملات المتكررة» وإنشاء القيود.", "Creating recurring transactions needs the recurring-transactions and journal-create duties.")}</p>
        : <RecurringForm initial={blankRecurring(template)} canSales={canSales} />}
    </AcctShell>
  );
}

export default function NewRecurringPage() {
  return <Suspense fallback={<OpsLoading />}><NewRecurring /></Suspense>;
}
