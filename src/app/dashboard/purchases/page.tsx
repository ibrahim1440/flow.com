"use client";
// «المشتريات» — ONE purchases screen (unified inventory, phase 2; owner decision 2026-10-26: buy as in Qoyod, one
// document receives the goods and records the bill). Three tabs, each shown to whoever holds its existing duty:
//   «الفواتير»    (default)  the purchase invoices + «+ فاتورة مشتريات» — the AP read gate (accounting module or
//                            purchases › invoices); the button for the draft writer;
//   «الاستلامات»            the receipts register and «استلام بدون فاتورة» (the exception path) — the inventory module;
//   «الموردين»              suppliers, VAT number, terms, contact, open balance — either of the above;
//   «مطالبات الموردين»      «نقص من المورد» (20261119090000_supplier_shortfall): the open supplier claims — the AP read gate.
// ?tab=invoices|receipts|suppliers|claims keeps the tab in the address; /dashboard/purchases/invoices redirects here.
// A «تسجيل مشتريات» link from the green coffee tab arrives with ?bean=<lot id> and opens the receipts pane on that lot.
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OpsRoot, PageHeader, Tabs, useL } from "@/components/ops/ui";
import "@/components/ops/stock.css";
import "../accounting/_ui/accounting.css";
import "./_parts/purchases.css";
import { useUser } from "../user-context";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { PlusIcon } from "../_components/stock-materials";
import { InvoicesTab } from "./_parts/invoices";
import { ReceiptsTab } from "./_parts/receipts";
import { SuppliersTab } from "./_parts/suppliers";
import { ClaimsTab } from "./_parts/claims";

type Tab = "invoices" | "receipts" | "suppliers" | "claims";

export default function PurchasesPage() {
  const L = useL();
  const user = useUser();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const p = user?.permissions ?? {};
  const canRead = hasModuleAccess(p, "accounting") || hasSubPrivilege(p, "purchases", "invoices");
  const canDraft = hasSubPrivilege(p, "purchases", "invoices") || hasSubPrivilege(p, "accounting", "ap");
  const canInventory = hasModuleAccess(p, "inventory");
  const canReceive = hasSubPrivilege(p, "inventory", "receive");
  const tabs: { key: Tab; label: string }[] = [
    ...(canRead ? [{ key: "invoices" as Tab, label: L("الفواتير", "Invoices") }] : []),
    ...(canInventory ? [{ key: "receipts" as Tab, label: L("الاستلامات", "Receipts") }] : []),
    ...(canRead || canInventory ? [{ key: "suppliers" as Tab, label: L("الموردين", "Suppliers") }] : []),
    ...(canRead ? [{ key: "claims" as Tab, label: L("مطالبات الموردين", "Supplier claims") }] : []),
  ];
  const bean = sp.get("bean") ?? undefined;
  const asked = (bean ? "receipts" : sp.get("tab")) as Tab | null;
  const tab: Tab | undefined = tabs.find((t) => t.key === asked)?.key ?? tabs[0]?.key;
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!canRead) return;
    let off = false;
    fetch("/api/purchases/suppliers").then((r) => (r.ok ? r.json() : null)).then((j) => { if (!off && j) setSuppliers(j.rows); }).catch(() => undefined);
    return () => { off = true; };
  }, [canRead]);

  function open(k: Tab) {
    const q = new URLSearchParams(sp.toString());
    q.set("tab", k);
    q.delete("bean");
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }

  return (
    <OpsRoot className="stk-purchases acct pur-root">
      <div className="hr-page">
        <PageHeader
          title={L("المشتريات", "Purchases")}
          actions={canDraft ? <Link className="hr-btn is-primary" href="/dashboard/purchases/invoices/new" data-testid="new-purchase-invoice"><PlusIcon />{L("فاتورة مشتريات", "Purchase invoice")}</Link> : null}
        >
          <span className="hr-caption">{L("فاتورة المشتريات تستلم البضاعة وتسجّل الفاتورة معًا · ريال سعودي", "A purchase invoice receives the goods and records the bill together · SAR")}</span>
        </PageHeader>
        {tabs.length > 1 && tab ? <Tabs label={L("أقسام المشتريات", "Purchases sections")} value={tab} onChange={open} items={tabs} underline /> : null}
        <div className="pur-body">
          {tab === "invoices" ? <InvoicesTab suppliers={suppliers} /> : null}
          {tab === "receipts" ? <ReceiptsTab canReceive={canReceive} canDraft={canDraft} initialBean={bean} /> : null}
          {tab === "suppliers" ? <SuppliersTab /> : null}
          {tab === "claims" ? <ClaimsTab suppliers={suppliers} initialSupplier={sp.get("supplier") ?? undefined} /> : null}
          {!tab ? <div className="hr-state"><h3>{L("لا صلاحية لعرض المشتريات.", "You have no access to purchases.")}</h3></div> : null}
        </div>
      </div>
    </OpsRoot>
  );
}
