"use client";
// Settings › «استيراد البيانات» (the admin role; the page itself is ./view.tsx, shared with «المحاسبة › استيراد البيانات»).
import { DataImportView } from "./view";

export default function DataImportPage() {
  return <DataImportView place="settings" />;
}
