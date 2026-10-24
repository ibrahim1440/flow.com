"use client";

import Link from "next/link";
import { AcctShell, useApi, useLang, type Setup } from "../../_ui/shell";
import { JournalEditor } from "../../_ui/journal-editor";

export default function NewJournalPage() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  return (
    <AcctShell setup={setup.data} title={L("قيد يدوي جديد", "New manual journal")}
      meta={<Link href="/dashboard/accounting/journals" className="acct-hint">→ {L("القيود", "Journals")}</Link>}>
      {setup.data && !setup.data.manualJournalsEnabled ? (
        <p role="alert" className="hr-err">{L("القيود اليدوية معطّلة في المرحلة الأولى.", "Manual journals are disabled in Phase 1.")}</p>
      ) : <JournalEditor />}
    </AcctShell>
  );
}
