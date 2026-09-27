"use client";

import { JournalEditor } from "../../_components/journal-editor";
import { NoPermission } from "../../../finance/_components/ui";
import { useCan } from "../../_components/kit";

export default function NewJournalPage() {
  const { can } = useCan();
  if (!can("journal_create")) return <NoPermission />;
  return <JournalEditor onSaved={(id) => { window.location.href = `/dashboard/accounting/journals/${id}`; }} />;
}
