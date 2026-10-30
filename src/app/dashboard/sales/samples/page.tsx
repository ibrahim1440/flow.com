"use client";

/**
 * «العيّنات» (batch 24 WP-B, the rep's sidebar «المبيعات › العيّنات»): every sample of the caller's own deals (a sales
 * manager: everyone's), newest first, with where it stands — so the rep sees at a glance which café is still waiting for
 * a sample and whose feedback is missing. A list only: a sample is requested from its deal (one per product per
 * customer, manager approval for a second), and its feedback is recorded there. Data: GET /api/sales/samples (scoped
 * through the deal's owner on the server).
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, useLang, formatDay } from "../_components/ui";
import { PerfLoading, PerfNotice, PerfNote } from "../_components/perf";
import { useD21Phone, usePhone } from "@/components/shell/page-context";

type Row = {
  id: string; description: string; quantity: string; unit: string; status: string;
  sentAt: string | null; feedbackAt: string | null; feedbackScore: number | null; createdAt: string;
  approval?: string;
  productSku: { name: string } | null;
  opportunity: { id: string; title: string; customer: { id: string; name: string } | null; owner: { id: string; name: string } };
};

const STATUS: Record<string, { ar: string; en: string; tone: string }> = {
  REQUESTED: { ar: "مطلوبة — بانتظار الشحن", en: "Requested", tone: "in" },
  PREPARING: { ar: "قيد التجهيز", en: "Preparing", tone: "in" },
  SENT: { ar: "أُرسلت", en: "Sent", tone: "wa" },
  FEEDBACK_RECEIVED: { ar: "وصل رأيهم", en: "Feedback received", tone: "ok" },
  CANCELLED: { ar: "ملغاة", en: "Cancelled", tone: "x" },
};
const DAY = 86_400_000;

export default function SamplesPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [scope, setScope] = useState<"own" | "all">("own");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [now, setNow] = useState(0);
  useD21Phone({ title: ar ? "العيّنات" : "Samples" });

  useEffect(() => {
    api<{ rows: Row[]; scope: "own" | "all" }>("/api/sales/samples").then((r) => {
      if (r.ok) { setRows(r.data.rows); setScope(r.data.scope); setNow(Date.now()); } else setError(r.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
    });
  }, [ar]);

  const shown = useMemo(() => (rows ?? []).filter((r) => filter === "all" || !["FEEDBACK_RECEIVED", "CANCELLED"].includes(r.status)), [rows, filter]);
  if (error) return <div className="pg"><PerfNotice kind="error" ar={ar}>{error}</PerfNotice></div>;
  if (!rows) return <PerfLoading ar={ar} />;

  const waiting = (r: Row) => r.status === "SENT" && !r.feedbackAt && r.sentAt ? Math.floor((now - new Date(r.sentAt).getTime()) / DAY) : null;
  const what = (r: Row) => r.productSku?.name ?? r.description;

  return (
    <div className="pg">
      {!phone ? (
        <div className="ph">
          <div>
            <h1>{ar ? "العيّنات" : "Samples"}</h1>
            <div className="meta"><span>{scope === "own" ? (ar ? "عيّنات صفقاتك" : "Samples of your deals") : (ar ? "عيّنات كل الفريق" : "The whole team's samples")}</span></div>
          </div>
        </div>
      ) : null}
      <div className="tool" style={{ marginBottom: 14, display: "flex", gap: 8 }}>
        <ul className="d21-seg" aria-label={ar ? "عرض" : "Show"}>
          <li><button type="button" aria-current={filter === "open" ? "page" : undefined} onClick={() => setFilter("open")} data-testid="samples-open">{ar ? "المفتوحة" : "Open"}</button></li>
          <li><button type="button" aria-current={filter === "all" ? "page" : undefined} onClick={() => setFilter("all")} data-testid="samples-all">{ar ? "الكل" : "All"}</button></li>
        </ul>
      </div>
      {shown.length === 0 ? (
        <PerfNote testId="samples-empty">
          {ar ? "ما عندك عيّنات مفتوحة. تطلب العيّنة من صفحة العميل أو الصفقة (زر «عيّنة»)." : "No open samples. Request one from the customer or the deal («Sample»)."}
        </PerfNote>
      ) : (
        <div className="perf-scroll">
          <table className="t" data-testid="samples-table">
            <thead><tr>
              <th scope="col">{ar ? "العميل" : "Customer"}</th>
              <th scope="col">{ar ? "العيّنة" : "Sample"}</th>
              <th scope="col">{ar ? "الحالة" : "Status"}</th>
              <th scope="col" className="hide-c">{ar ? "التاريخ" : "Date"}</th>
              {scope === "all" ? <th scope="col" className="hide-c">{ar ? "المندوب" : "Rep"}</th> : null}
            </tr></thead>
            <tbody>
              {shown.map((r) => {
                const s = STATUS[r.status] ?? { ar: r.status, en: r.status, tone: "" };
                const w = waiting(r);
                return (
                  <tr key={r.id} data-testid="sample-row">
                    <td className="wrap"><Link className="who" href={`/dashboard/sales/deals/${r.opportunity.id}`}><bdi>{r.opportunity.customer?.name ?? r.opportunity.title}</bdi></Link></td>
                    <td className="wrap"><bdi>{what(r)}</bdi></td>
                    <td className="wrap">
                      <span className={`st ${s.tone}`}>{ar ? s.ar : s.en}</span>
                      {r.approval === "PENDING" ? <span className="flag wa" style={{ marginInlineStart: 6 }}>{ar ? "بانتظار موافقة المدير" : "Awaiting approval"}</span> : null}
                      {w !== null && w >= 5 ? <span className="flag" style={{ marginInlineStart: 6 }}>{ar ? `بدون رد ${w} يوم` : `No feedback ${w} days`}</span> : null}
                    </td>
                    <td className="hide-c"><bdi>{formatDay(r.sentAt ?? r.createdAt)}</bdi></td>
                    {scope === "all" ? <td className="hide-c">{r.opportunity.owner.name}</td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
