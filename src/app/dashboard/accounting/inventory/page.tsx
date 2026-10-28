"use client";
// «تقييم المخزون» (Figma ACC-100 / 100s; «المخزون والتكلفة» before unified inventory phase 4). The screen lives in
// ../_ui/inventory-valuation.tsx: the same screen serves /dashboard/inventory/valuation (the inventory › valuation duty).
import { Suspense } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { InventoryValuationScreen } from "../_ui/inventory-valuation";

export default function InventoryCostPage() {
  return <Suspense fallback={<OpsLoading />}><InventoryValuationScreen /></Suspense>;
}
