"use client";
// Shared pieces of the «tools» screens of UI batch 2 (analytics, history, organisation settings,
// automation & WhatsApp), on the Direction 2.1 operations scope. Presentation only: no request,
// permission or data rule lives here. The settings sub-navigation lists only pages that exist
// and that the viewer may open (the same `routeAllowed` the shell uses).
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

type SettingsLink = { href: string; ar: string; en: string; icon: D21IconName; also?: string[] };
// F-P01 / E-P01 «عام · التشغيل · المبيعات · المالية · الأتمتة». The operations and finance
// settings pages of the frame (production & roasting, inventory, products, invoicing & tax) do
// not exist yet, so they are not listed.
const SETTINGS_NAV: { ar: string; en: string; items: SettingsLink[] }[] = [
  { ar: "عام", en: "General", items: [
    { href: "/dashboard/settings", ar: "المنشأة", en: "Organisation", icon: "home" },
    { href: "/dashboard/employees", ar: "المستخدمون والصلاحيات", en: "Users & permissions", icon: "users" },
  ] },
  { ar: "المبيعات", en: "Sales", items: [
    { href: "/dashboard/sales/settings", ar: "المبيعات", en: "Sales", icon: "deal" },
  ] },
  { ar: "الأتمتة", en: "Automation", items: [
    { href: "/dashboard/automation", ar: "الأتمتة والواتساب", en: "Automation & WhatsApp", icon: "bell", also: ["/dashboard/automation/"] },
  ] },
];

function SettingsNav() {
  const pathname = usePathname() ?? "";
  const viewer = useViewer();
  const { lang } = useI18n();
  const ar = lang === "ar";
  if (!viewer) return null;
  const groups = SETTINGS_NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => routeAllowed(viewer, i.href)) }))
    .filter((g) => g.items.length > 0);
  return (
    <nav className="tl-snav" aria-label={ar ? "الإعدادات" : "Settings"} data-testid="settings-nav">
      {groups.map((g) => (
        <div key={g.en}>
          <h3>{ar ? g.ar : g.en}</h3>
          <ul>
            {g.items.map((i) => {
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
export function LinkTabs({ items, label }: { items: { href: string; label: string; count?: number | string; current: boolean; testId?: string }[]; label: string }) {
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
