"use client";
// «المالية › استيراد البيانات» — the same page as Settings › «استيراد البيانات», for a holder of accounting › data_import
// (the owner grants it to the accountant, who has no settings module): drawn without the settings frame, back to
// «المحاسبة». The API is the same and re-checks the rule (src/lib/data-import/gate.ts).
import { DataImportView } from "../../settings/data-import/view";

export default function AccountingDataImportPage() {
  return <DataImportView place="accounting" />;
}
