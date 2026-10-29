"use client";
// «إضافة أصل» — a new asset (the sidebar «+» of «الأصول الثابتة»).
import { Suspense } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { useLang } from "../../_ui/shell";
import { FaShell, Crumb } from "../_ui/fa";
import { AssetForm } from "../_ui/asset-form";

function NewAsset() {
  const { L } = useLang();
  return <FaShell title={L("إضافة أصل", "Add asset")}><Crumb items={[{ label: L("إضافة أصل", "Add asset") }]} /><AssetForm /></FaShell>;
}
export default function Page() { return <Suspense fallback={<OpsLoading />}><NewAsset /></Suspense>; }
