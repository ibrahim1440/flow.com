"use client";
// Shared pieces of the «tools» screens of UI batch 2 (analytics, history, organisation settings,
// automation & WhatsApp), on the Direction 2.1 operations scope. Presentation only: no request,
// permission or data rule lives here. The settings sub-navigation links only pages that exist
// and that the viewer may open (the same `routeAllowed` the shell uses); a frame section with
// no page is drawn disabled, never as a link.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Ico, type D21IconName } from "@/components/shell/icons";
import { routeAllowed, type Viewer } from "@/lib/nav/registry";
import { useUser } from "../user-context";
import { useI18n } from "@/lib/i18n/context";
import "@/components/ops/stock.css";
import "./tools.css";

/** The viewer as the registry understands it, or null before the session is known. */
export function useViewer(): Viewer | null {
  const user = useUser();
  return user ? { permissions: user.permissions, role: user.role } : null;
}

type SettingsLink = { href: string | null; ar: string; en: string; icon: D21IconName; also?: string[] };
// F-P01 / E-P01 / A-P08 «عام · التشغيل · المبيعات · المالية · الأتمتة» (gx.py SNAV). Every section
// has a page since batch "Settings" (production & roasting, inventory, products, invoicing & tax).
// A section with `href: null` would be drawn disabled with «قريباً», link nowhere, and be shown only
// to somebody who may open the organisation settings.
const SETTINGS_NAV: { ar: string; en: string; items: SettingsLink[] }[] = [
  { ar: "عام", en: "General", items: [
    { href: "/dashboard/settings", ar: "المنشأة", en: "Organisation", icon: "home" },
    { href: "/dashboard/employees", ar: "المستخدمون والصلاحيات", en: "Users & permissions", icon: "users", also: ["/dashboard/employees/"] },
  ] },
  { ar: "التشغيل", en: "Operations", items: [
    { href: "/dashboard/settings/production", ar: "الإنتاج والتحميص", en: "Production & roasting", icon: "flame", also: ["/dashboard/settings/production/"] },
    { href: "/dashboard/settings/inventory", ar: "المخزون", en: "Inventory", icon: "box" },
    { href: "/dashboard/settings/products", ar: "المنتجات", en: "Products", icon: "cup" },
  ] },
  { ar: "المبيعات", en: "Sales", items: [
    { href: "/dashboard/sales/settings", ar: "المبيعات", en: "Sales", icon: "deal" },
  ] },
  { ar: "المالية", en: "Finance", items: [
    { href: "/dashboard/settings/invoicing", ar: "الفوترة والضرائب", en: "Invoicing & tax", icon: "invoice" },
  ] },
  { ar: "الأتمتة", en: "Automation", items: [
    { href: "/dashboard/automation", ar: "الأتمتة والواتساب", en: "Automation & WhatsApp", icon: "bell", also: ["/dashboard/automation/"] },
  ] },
];

/** The settings hub's navigation (1440 only): the pages this viewer may open, and the frame's
 *  sections without a page yet as disabled «قريباً» rows (organisation-settings viewers only). */
export function SettingsNav() {
  const pathname = usePathname() ?? "";
  const viewer = useViewer();
  const { lang } = useI18n();
  const ar = lang === "ar";
  if (!viewer) return null;
  const owner = routeAllowed(viewer, "/dashboard/settings");
  const groups = SETTINGS_NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => (i.href ? routeAllowed(viewer, i.href) : owner)) }))
    .filter((g) => g.items.some((i) => i.href) || (owner && g.items.length > 0));
  return (
    <nav className="tl-snav" aria-label={ar ? "الإعدادات" : "Settings"} data-testid="settings-nav">
      {groups.map((g) => (
        <div key={g.en}>
          <h3>{ar ? g.ar : g.en}</h3>
          <ul>
            {g.items.map((i) => {
              if (!i.href) {
                return (
                  <li key={i.en}>
                    <span className="tl-snav-soon" aria-disabled="true" data-testid="settings-nav-soon">
                      <Ico name={i.icon} small />
                      <span>{ar ? i.ar : i.en}</span>
                      <em>{ar ? "قريباً" : "Soon"}</em>
                    </span>
                  </li>
                );
              }
              const current = pathname === i.href || (i.also ?? []).some((p) => pathname.startsWith(p));
              return (
                <li key={i.href}>
                  <Link href={i.href} aria-current={current ? "page" : undefined}>
                    <Ico name={i.icon} small />
                    <span>{ar ? i.ar : i.en}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** A settings page: the settings sub-navigation (1440 only), then the page. */
export function SettingsFrame({ children }: { children: ReactNode }) {
  return (
    <div className="tl-settings">
      <SettingsNav />
      <div className="hr-page">{children}</div>
    </div>
  );
}

/** A tab row whose tabs are pages (links), drawn like the HR underline tabs. */
export function LinkTabs({ items, label }: { items: { href: string; label: ReactNode; count?: number | string; current: boolean; testId?: string }[]; label: string }) {
  return (
    <nav className="hr-tabs is-underline tl-tabs" aria-label={label}>
      {items.map((t) => (
        <Link key={t.href} href={t.href} className="hr-tab" aria-current={t.current ? "page" : undefined} data-testid={t.testId}>
          {t.label}
          {t.count !== undefined ? <span className="hr-count">{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** A label-column section: title and caption at the inline-start, the body beside them. */
export function Sec({ title, caption, tone, children, testId }: { title: ReactNode; caption?: ReactNode; tone?: "danger"; children: ReactNode; testId?: string }) {
  return (
    <section className={`tl-sec${tone ? ` tone-${tone}` : ""}`} data-testid={testId}>
      <header>
        <h2>{title}</h2>
        {caption ? <p>{caption}</p> : null}
      </header>
      <div className="tl-body">{children}</div>
    </section>
  );
}

export function PlusIco() { return <Ico name="plus" small />; }
export function DownloadIco() { return <Ico name="dl" small />; }
