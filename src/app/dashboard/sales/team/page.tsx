"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLang, api, num } from "../_components/ui";
import { PerfHeader, PerfLoading, PerfNotice } from "../_components/perf";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import { shortDate } from "@/components/d21/format";
import { useUser } from "../../user-context";
import { seesTeamReports } from "@/lib/services/sales/scope";

/**
 * «متابعة الفريق» — the sales manager's overview of the team (batch 24 WP-C). A quiet table: one row per rep,
 * sorted by NAME (never by a figure — no leaderboard, owner decision), each opening that rep's «يومي» read-only
 * (/dashboard/my-day?rep=<id>, WP-B). Figures: GET /api/sales/team (services/sales/team-overview.ts). The
 * collections target is SAR; everything else is a count or a deal value.
 */

type Row = {
  employeeId: string; name: string; customers: number;
  target: string | null; targetPercent: string | null; collected: string;
  negotiationCount: number; negotiationValue: string;
  lateReorders: number; contractsExpiring: number; lastActivityAt: string | null;
};

export default function TeamRoute() {
  const user = useUser();
  const lang = useLang();
  const ar = lang === "ar";
  if (!user) return <PerfLoading ar={ar} />;
  if (!seesTeamReports(user.permissions, user.role)) return <NoAccess ar={ar} />;
  return <TeamPage />;
}

function NoAccess({ ar }: { ar: boolean }) {
  useD21Phone({ title: ar ? "متابعة الفريق" : "Team overview" });
  return (
    <div className="pg">
      <div style={{ padding: "64px 0", textAlign: "center", display: "grid", gap: 10, justifyItems: "center" }} data-testid="team-no-access" role="status">
        <p style={{ fontWeight: 600, margin: 0, fontSize: 16 }}>{ar ? "متابعة الفريق لمدير المبيعات" : "The team overview is for the sales manager"}</p>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13.5 }}>{ar ? "يومك وعملاؤك وهدفك في «يومي»." : "Your own day, customers and target are on «My day»."}</p>
        <Link className="btn" href="/dashboard/my-day">{ar ? "فتح يومي" : "Open my day"}</Link>
      </div>
    </div>
  );
}

const muted = { color: "var(--text-muted)" } as const;

function TeamPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [month, setMonth] = useState("");
  const [pool, setPool] = useState<{ customers: number; contractsExpiring: number } | null>(null);
  const [windowDays, setWindowDays] = useState(45);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<{ month: string; rows: Row[]; unassigned?: { customers: number; contractsExpiring: number }; contractWindowDays?: number }>("/api/sales/team");
      if (cancelled) return;
      if (res.ok) { setRows(res.data.rows); setMonth(res.data.month); setPool(res.data.unassigned ?? null); setWindowDays(res.data.contractWindowDays ?? 45); setError(""); }
      else setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
    })();
    return () => { cancelled = true; };
  }, [ar]);

  // Whole riyals (no «.00») and the plural the rep reads (council fix round 1, P0-11).
  const sar = (v: string | null) => num(Math.round(Number(v ?? 0)));
  const deals = (n: number) => (ar ? (n === 1 ? "صفقة واحدة" : n === 2 ? "صفقتان" : n <= 10 ? `${num(n)} صفقات` : `${num(n)} صفقة`) : `${num(n)} deal${n === 1 ? "" : "s"}`);
  const pct = (r: Row) => (r.targetPercent === null ? (ar ? "بلا هدف" : "No target") : `${Math.round(Number(r.targetPercent))}%`);
  const day = (r: Row) => (r.lastActivityAt ? shortDate(r.lastActivityAt, lang) : "—");
  const myDay = (r: Row) => `/dashboard/my-day?rep=${encodeURIComponent(r.employeeId)}`;
  const monthText = month ? new Date(`${month}-15T00:00:00Z`).toLocaleDateString(ar ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { month: "long", year: "numeric" }) : "";

  const body = rows === null ? (error ? null : <PerfLoading ar={ar} />) : rows.length === 0 ? (
    <div className="empty" data-testid="team-empty" style={{ padding: "48px 0", textAlign: "center", display: "grid", gap: 8 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{ar ? "ما فيه مندوبين لهم عملاء أو هدف هذا الشهر" : "No rep has customers or a target this month"}</p>
      <p style={{ margin: 0, ...muted, fontSize: 13.5 }}>{ar ? "عيّن مسؤولًا لكل عميل من صفحة العميل، أو حدّد أهداف الشهر من «الأهداف»." : "Assign an account owner on each customer's page, or set this month's targets under Targets."}</p>
      <div><Link className="btn" href="/dashboard/sales/targets">{ar ? "فتح الأهداف" : "Open targets"}</Link></div>
    </div>
  ) : phone ? (
    <div data-testid="team-list">
      {rows.map((r) => (
        <Link key={r.employeeId} href={myDay(r)} className="mrow" data-testid={`team-row-${r.employeeId}`} style={{ color: "inherit", textDecoration: "none" }}>
          <div className="who"><bdi>{r.name}</bdi></div>
          <span className="n" style={{ fontWeight: 600 }}>{pct(r)}</span>
          <div className="r2">
            <span>{ar ? "محصّل" : "Collected"} <bdi className="n">{sar(r.collected)}</bdi></span>
            <span>{ar ? "متأخر" : "Late"} <span className="n">{num(r.lateReorders)}</span></span>
            <span>{ar ? "عقود" : "Contracts"} <span className="n">{num(r.contractsExpiring)}</span></span>
            <span>{day(r)}</span>
          </div>
        </Link>
      ))}
      {pool && pool.customers > 0 ? (
        <Link href="/dashboard/customers" className="mrow" data-testid="team-row-unassigned" style={{ color: "inherit", textDecoration: "none" }}>
          <div className="who"><bdi>{ar ? "بدون مندوب" : "No rep"}</bdi></div>
          <span className="n">{num(pool.customers)}</span>
          <div className="r2"><span>{ar ? "عقود" : "Contracts"} <span className="n">{num(pool.contractsExpiring)}</span></span><span>{ar ? "عيّن مندوب" : "Assign a rep"}</span></div>
        </Link>
      ) : null}
    </div>
  ) : (
    <div className="acc-scroll" style={{ overflowX: "auto" }}>
      <table className="t" data-testid="team-table">
        <thead>
          <tr>
            <th>{ar ? "المندوب" : "Rep"}</th>
            <th className="num">{ar ? "الهدف (التحصيل)" : "Target (collections)"}</th>
            <th className="num">{ar ? "المحصّل (ريال)" : "Collected (SAR)"}</th>
            <th className="num">{ar ? "في التفاوض (ريال)" : "In negotiation (SAR)"}</th>
            <th className="num">{ar ? "طلبات متأخرة" : "Late reorders"}</th>
            <th className="num">{ar ? `عقود تنتهي خلال ${num(windowDays)} يوم` : `Contracts ending in ${num(windowDays)} days`}</th>
            <th>{ar ? "آخر نشاط" : "Last activity"}</th>
            <th aria-label={ar ? "فتح" : "Open"} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.employeeId} data-testid={`team-row-${r.employeeId}`}>
              <td className="who"><Link href={myDay(r)}><bdi>{r.name}</bdi></Link><div className="acc-muted sm" style={{ ...muted, fontSize: 12.5 }}>{ar ? `${num(r.customers)} عميل` : `${num(r.customers)} customers`}</div></td>
              <td className="num"><bdi className="n">{pct(r)}</bdi>{r.target && <div style={{ ...muted, fontSize: 12.5 }}><bdi className="n">{sar(r.target)}</bdi></div>}</td>
              <td className="num"><bdi className="n">{sar(r.collected)}</bdi></td>
              <td className="num"><bdi className="n">{sar(r.negotiationValue)}</bdi>{r.negotiationCount > 0 && <div style={{ ...muted, fontSize: 12.5 }}>{deals(r.negotiationCount)}</div>}</td>
              <td className="num"><span className="n">{num(r.lateReorders)}</span></td>
              <td className="num"><span className="n">{num(r.contractsExpiring)}</span></td>
              <td>{day(r)}</td>
              <td><Link className="btn sm" href={myDay(r)} data-testid={`team-open-${r.employeeId}`}>{ar ? "يومه" : "Their day"}</Link></td>
            </tr>
          ))}
          {/* «بدون مندوب»: customers with no account owner appear on nobody's «يومي» (council fix round 1, P0-14). */}
          {pool && pool.customers > 0 ? (
            <tr data-testid="team-row-unassigned" className="acc-muted">
              <td className="who"><Link href="/dashboard/customers"><bdi>{ar ? "بدون مندوب" : "No rep"}</bdi></Link><div style={{ ...muted, fontSize: 12.5 }}>{ar ? `${num(pool.customers)} عميل بدون مسؤول` : `${num(pool.customers)} customers without an owner`}</div></td>
              <td className="num">—</td><td className="num">—</td><td className="num">—</td><td className="num">—</td>
              <td className="num"><span className="n">{num(pool.contractsExpiring)}</span></td>
              <td>—</td>
              <td><Link className="btn sm" href="/dashboard/customers" data-testid="team-open-unassigned">{ar ? "عيّن مندوب" : "Assign"}</Link></td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="pg" data-testid="team-overview">
      <PerfHeader ar={ar} title={ar ? "متابعة الفريق" : "Team overview"} phoneTitle={ar ? "متابعة الفريق" : "Team overview"}
        meta={[monthText, ar ? "مرتّب حسب الاسم" : "Sorted by name"].filter(Boolean)} />
      <PerfNotice kind="error" ar={ar} onDismiss={() => setError("")}>{error}</PerfNotice>
      {body}
      {rows && rows.length > 0 && (
        <p style={{ ...muted, fontSize: 12.5, marginTop: 16 }}>
          {ar
            ? "الهدف والمحصّل من التحصيل هذا الشهر. «في التفاوض»: قيمة الصفقات المفتوحة في مرحلة عرض السعر أو التفاوض. اضغط اسم المندوب تشوف يومه (للاطلاع فقط)."
            : "Target and collected are this month's collections. «In negotiation»: the value of open deals at the quotation or negotiation stage. Open a rep's name to see their day (read only)."}
        </p>
      )}
    </div>
  );
}
