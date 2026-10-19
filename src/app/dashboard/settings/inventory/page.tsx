"use client";
// Settings › Inventory («المخزون» in the settings navigation of GX F-P01 1205:2). No Figma frame
// draws this page: it holds the one inventory figure the system already used as a constant — the
// green-coffee low-stock line of the inventory screen («أصناف أقل من 20 كغ», Figma 251:2482) —
// in the label-column sections of F-P01, and points to where the per-item reorder points live.
// GET / PUT /api/settings/inventory (admin role, step-up, audited).
import Link from "next/link";
import { useEffect, useState } from "react";
import { OpsLoading, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { Ico } from "@/components/shell/icons";
import { useD21Phone } from "@/components/shell/page-context";
import { routeAllowed } from "@/lib/nav/registry";
import { Sec, SettingsFrame, useViewer } from "../../_components/tools-ui";
import { SingleSetting } from "../_parts/single-setting";
import "../_parts/sections.css";

type Inv = { lowStockGreenKg: string | null; effectiveLowStockGreenKg: string; isDefault: boolean; range: { default: number }; can: { edit: boolean } };

export default function InventorySettingsPage() {
  const L = useL();
  const viewer = useViewer();
  const [s, setS] = useState<Inv | null>(null);
  const [failed, setFailed] = useState(false);
  useD21Phone({ title: L("المخزون", "Inventory"), sub: L("الإعدادات", "Settings"), back: "/dashboard/settings" });
  useEffect(() => {
    fetch("/api/settings/inventory", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject())).then(setS).catch(() => setFailed(true));
  }, []);

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <PageHeader title={L("المخزون", "Inventory")} />
        <p className="tl-sub">{L("إعدادات النظام", "System settings")}<span className="tl-sep">·</span>{L("للمدير فقط", "admins only")}</p>
        {failed ? <div className="hr-notice tone-danger" role="alert">{L("تعذّر التحميل.", "Could not load.")}</div> : !s ? <OpsLoading rows={4} /> : (
          <div data-testid="inventory-settings">
            <Sec title={L("المخزون المنخفض", "Low stock")} caption={L("يُعلَّم البن الأخضر الأقل من هذا الحد «مخزون منخفض» في شاشة المخزون", "Green coffee below this line is flagged «low stock» on the inventory screen")} testId="low-stock">
              <SingleSetting
                url="/api/settings/inventory" field="lowStockGreenKg" testId="low-stock"
                stored={s.lowStockGreenKg} effective={s.effectiveLowStockGreenKg} isDefault={s.isDefault} canEdit={s.can.edit}
                label={L("حد المخزون المنخفض للبن الأخضر", "Green coffee low-stock line")}
                help={L(`فارغ = الافتراضي ${s.range.default} كغ · لكل صنف`, `Empty = the default ${s.range.default} kg · per bean`)}
                unit={L("كغ", "kg")}
                onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Inv>) } : x))}
                savedText={(j) => L(`حُفظ. شاشة المخزون تعلّم الآن الأصناف الأقل من ${String(j.effectiveLowStockGreenKg)} كغ.`, `Saved. The inventory screen now flags beans below ${String(j.effectiveLowStockGreenKg)} kg.`)}
              />
            </Sec>
            <Sec title={L("مواد التعبئة", "Packaging materials")} caption={L("تُدار في صفحاتها المعتمدة ولا تتكرر هنا", "Managed on their own approved pages, not repeated here")}>
              {viewer && routeAllowed(viewer, "/dashboard/inventory") ? (
                <div className="tl-card">
                  <Ico name="box" />
                  <div>
                    <strong>{L("نقاط إعادة الطلب", "Reorder points")}</strong>
                    <p>{L("لكل مادة تعبئة حدّها، يُعدَّل من بطاقتها في «المخزون › مواد التعبئة»", "Each packaging material has its own point, edited on its card in «Inventory › Packaging materials»")}</p>
                  </div>
                  <Link href="/dashboard/inventory?tab=pack" className="hr-btn is-sm" style={{ textDecoration: "none" }}>{L("فتح", "Open")}</Link>
                </div>
              ) : <p className="ss-muted">{L("لا تملك صلاحية فتح المخزون.", "You cannot open inventory.")}</p>}
            </Sec>
          </div>
        )}
      </SettingsFrame>
    </OpsRoot>
  );
}
