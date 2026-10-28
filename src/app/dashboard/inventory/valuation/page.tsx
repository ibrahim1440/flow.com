"use client";
// «تقييم المخزون» for the inventory › valuation duty (unified inventory phase 4, council F7): the same screen as
// «المحاسبة › تقييم المخزون», reached under the operations inventory by a viewer who holds that duty without the
// accounting module — the cost-ledger figures only (the API keeps the general-ledger side to the accounting module).
import { Suspense } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { InventoryValuationScreen } from "../../accounting/_ui/inventory-valuation";

export default function InventoryValuationPage() {
  return <Suspense fallback={<OpsLoading />}><InventoryValuationScreen /></Suspense>;
}
