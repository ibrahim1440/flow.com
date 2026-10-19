"use client";
// Settings › Products («المنتجات» in the settings navigation of GX F-P01 1205:2). No Figma frame
// draws this page and no product setting is stored by itself: the product configuration lives on
// its approved pages — the print settings (Figma 1632:2, UPS A-5 «القوالب والحقول» and A-3 «ملفات
// الورق والطابعات», which also holds the print job cap) and the product categories (Figma 216:2).
// This page reaches them in the label-column sections of F-P01 («تُدار في صفحاتها المعتمدة ولا
// تتكرر هنا»), each link shown only to a viewer who may open it.
import Link from "next/link";
import { OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { Ico, type D21IconName } from "@/components/shell/icons";
import { useD21Phone } from "@/components/shell/page-context";
import { routeAllowed } from "@/lib/nav/registry";
import { Sec, SettingsFrame, useViewer } from "../../_components/tools-ui";
import "../_parts/sections.css";

export default function ProductsSettingsPage() {
  const L = useL();
  const viewer = useViewer();
  useD21Phone({ title: L("المنتجات", "Products"), sub: L("الإعدادات", "Settings"), back: "/dashboard/settings" });
  const card = (href: string, icon: D21IconName, title: string, body: string, testId: string) =>
    viewer && routeAllowed(viewer, href.split("?")[0]) ? (
      <div className="tl-card" key={href} data-testid={testId}>
        <Ico name={icon} />
        <div><strong>{title}</strong><p>{body}</p></div>
        <Link href={href} className="hr-btn is-sm" style={{ textDecoration: "none" }}>{L("فتح", "Open")}</Link>
      </div>
    ) : null;
  const print = [
    card("/dashboard/labels/templates", "note", L("القوالب والحقول", "Templates & fields"), L("ما يُطبع على كل ملصق وترتيبه، والإعدادات المحفوظة", "What each label prints and in what order, and the saved presets"), "products-templates"),
    card("/dashboard/labels/profiles", "settings", L("ملفات الورق والطابعات", "Paper & printer profiles"), L("مقاسات الورق والطابعات وحد الملصقات لكل مهمة طباعة", "Paper sizes, printers and the label cap per print job"), "products-profiles"),
  ].filter(Boolean);
  const catalog = [card("/dashboard/products?tab=categories", "cup", L("تصنيفات المنتجات", "Product categories"), L("التصنيفات وترتيبها وما تحتويه من منتجات", "The categories, their order and the products in each"), "products-categories")].filter(Boolean);

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <PageHeader title={L("المنتجات", "Products")} />
        <p className="tl-sub">{L("إعدادات النظام", "System settings")}<span className="tl-sep">·</span>{L("للمدير فقط", "admins only")}</p>
        <div data-testid="products-settings">
          <Sec title={L("الطباعة والملصقات", "Printing & labels")} caption={L("تُدار في صفحاتها المعتمدة ولا تتكرر هنا", "Managed on their own approved pages, not repeated here")}>
            {print.length ? print : <p className="ss-muted">{L("لا تملك صلاحية فتح إعدادات الطباعة.", "You cannot open the print settings.")}</p>}
          </Sec>
          <Sec title={L("الكتالوج", "Catalogue")} caption={L("تُدار في صفحاتها المعتمدة ولا تتكرر هنا", "Managed on their own approved pages, not repeated here")}>
            {catalog.length ? catalog : <p className="ss-muted">{L("لا تملك صلاحية فتح المنتجات.", "You cannot open products.")}</p>}
          </Sec>
        </div>
      </SettingsFrame>
    </OpsRoot>
  );
}
