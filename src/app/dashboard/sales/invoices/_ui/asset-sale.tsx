"use client";

// «بيع أصل ثابت» (BATCH 22 WP-F) — the line picker of the sales-invoice form, for the accountant only (accounting ›
// fixed_assets; the API refuses others). It lists the assets that may be sold (ACTIVE / FULLY_DEPRECIATED, no live disposal,
// no other open sale line) with their net book value, and adds one line: quantity 1, the asset's default tax (land and
// buildings: exempt E, VATEX-SA-30, with a RETT reminder), the disposal it will make (sale, or scrap sold to a dealer).
import { useState } from "react";
import { D21Dialog } from "@/components/ui/Dialog";
import { money, useApi, useLang } from "./inv";
import type { EditLine } from "./editor";

type Asset = { id: string; code: string; nameAr: string; nameEn: string | null; netBookValue: string; category: { nameAr: string; nameEn: string | null };
  tax: { taxCategory: "S" | "E"; taxRatePercent: string; exemptionReasonCode: string | null; rett: boolean } };

export function AssetSalePicker({ onPick, onClose }: { onPick: (l: EditLine) => void; onClose: () => void }) {
  const { L, lang } = useLang();
  const [q, setQ] = useState("");
  const list = useApi<{ items: Asset[] }>(`/api/sales/invoices/fixed-assets?q=${encodeURIComponent(q)}`);
  const items = list.data?.items ?? [];
  return (
    <D21Dialog lang={lang === "en" ? "en" : "ar"} width={560} title={L("بيع أصل ثابت", "Sell a fixed asset")} onClose={onClose} testId="asset-sale-picker"
      actions={<button type="button" className="hr-btn" onClick={onClose}>{L("إغلاق", "Close")}</button>}>
      <p className="acct-hint">{L("يُرحَّل صافي البند إلى «تسوية بيع الأصول الثابتة»، ويُسجَّل الاستبعاد من صفحة الأصل بعد الإصدار فيُحتسب الربح أو الخسارة.", "The line's net posts to «fixed-asset sale clearing»; after issue, record the disposal on the asset's page to book the gain or loss.")}</p>
      <label className="hr-field"><span className="hr-label">{L("ابحث بالرمز أو الاسم", "Search by code or name")}</span>
        <input className="hr-input" value={q} onChange={(e) => setQ(e.target.value)} data-testid="asset-sale-search" /></label>
      {list.error ? <p className="notice er" role="alert">{list.error}</p> : !list.data ? <p className="acct-hint" role="status">{L("جارٍ التحميل…", "Loading…")}</p> : items.length === 0 ? (
        <p className="acct-hint" data-testid="asset-sale-empty">{L("لا أصول قابلة للبيع (نشطة، غير مستبعدة، وليست على فاتورة أخرى).", "No asset can be sold (active, not disposed of, not on another invoice).")}</p>
      ) : (
        <ul className="ops-list" data-testid="asset-sale-options">{items.map((a) => (
          <li key={a.id}>
            <button type="button" className="hr-btn is-ghost" data-testid={`asset-sale-${a.code}`} onClick={() => onPick({
              kind: "FIXED_ASSET_SALE", fixedAssetId: a.id, disposalKind: "SALE", rett: a.tax.rett,
              description: L(`بيع أصل ثابت: ${a.code} · ${a.nameAr}`, `Fixed-asset sale: ${a.code} · ${a.nameEn || a.nameAr}`),
              quantity: "1", unit: "UNIT", unitPrice: "", discountPercent: "0",
              taxCategory: a.tax.taxCategory, taxRatePercent: a.tax.taxRatePercent, exemptionReasonCode: a.tax.exemptionReasonCode,
            })}>
              <bdi className="acct-code" dir="ltr">{a.code}</bdi> · <bdi>{L(a.nameAr, a.nameEn || a.nameAr)}</bdi>
              <span className="inv-sub">{L(a.category.nameAr, a.category.nameEn || a.category.nameAr)} · {L("القيمة الدفترية", "Book value")} <bdi className="hr-num">{money(a.netBookValue)}</bdi>{a.tax.rett ? L(" · عقار: معفى", " · real estate: exempt") : ""}</span>
            </button>
          </li>
        ))}</ul>
      )}
    </D21Dialog>
  );
}
