"use client";
// «اليوم · طلباتي المعلقة» — a compact card of the person's OWN HR requests still waiting for someone
// else's decision (leave PENDING, an advance REQUESTED, an attendance correction PENDING): the count and
// the latest three with who holds them. Submitting, withdrawing and cancelling live in «خدماتي»
// (/dashboard/me#requests) — this card only points there. Reads /api/workspace/requests (views.myRequests,
// the subject is always the session's own HR record). Not linked, nothing pending or a failed read: no card.
import Link from "next/link";
import { useL } from "@/components/ops/ui";
import { ADVANCE_STATUS, REQUEST_STATUS, StatusDot, money, type StatusEntry } from "@/components/hr/ui";
import { leaveTypeName } from "@/lib/i18n/hr";
import { ago, dayOf } from "@/lib/workspace/format";
import { TypeChip, useLang, useWs } from "./kit";

type Pending = {
  type: "LEAVE" | "ADVANCE" | "CORRECTION"; id: string; title: string; leaveTypeCode?: string; status: string; createdAt: string; pending: boolean;
  startDate?: string; endDate?: string; days?: string; amount?: string; workDate?: string;
  step: { ar: string; en: string } | null;
};
type Requests = { linked: boolean; items: Pending[]; pending: number };

// The employee's own request: pending reads as awaiting approval, not as their decision.
const MINE: Record<string, StatusEntry> = { PENDING: [REQUEST_STATUS.PENDING[0], REQUEST_STATUS.PENDING[1], "Awaiting approval"] };
const CORRECTION: Record<string, StatusEntry> = { PENDING: ["بانتظار المدير", "warning", "Awaiting manager"] };

export const MY_REQUESTS_HREF = "/dashboard/me#requests";

export function PendingRequestsCard({ now }: { now: Date }) {
  const L = useL();
  const lang = useLang();
  const { data } = useWs<Requests>("/api/workspace/requests");
  if (!data?.linked || !data.pending) return null;
  const latest = data.items.filter((i) => i.pending).slice(0, 3);
  const day = (iso: string) => dayOf(`${iso}T09:00:00Z`, lang, now);
  const what = (i: Pending) =>
    i.type === "LEAVE" ? `${leaveTypeName({ code: i.leaveTypeCode, nameAr: i.title }, lang)} · ${day(i.startDate!)}${i.endDate && i.endDate !== i.startDate ? ` — ${day(i.endDate)}` : ""}`
      : i.type === "ADVANCE" ? `${money(i.amount)} ${L("ر.س", "SAR")}`
        : `${L("الحضور", "Attendance")} · ${day(i.workDate!)}`;
  return (
    <section className="ws-mine" aria-labelledby="ws-mine" data-testid="ws-pending-requests">
      <div className="ws-mine-head">
        <h2 id="ws-mine" className="hr-section">{L("طلباتي المعلقة", "My pending requests")} <span className="hr-caption">· <span className="hr-num" data-testid="ws-pending-count">{data.pending}</span></span></h2>
      </div>
      <ul className="ws-mine-list">
        {latest.map((i) => (
          <li key={`${i.type}:${i.id}`} className="ws-mine-item">
            <TypeChip type={i.type} />
            <div className="ws-mine-body">
              <span className="ws-mine-title">{what(i)}</span>
              <span className="ws-row-meta">
                <StatusDot map={i.type === "ADVANCE" ? ADVANCE_STATUS : i.type === "CORRECTION" ? CORRECTION : MINE} value={i.status} />
                <span>{ago(i.createdAt, lang, now)}</span>
              </span>
              {i.step ? <span className="ws-note">{lang === "ar" ? i.step.ar : i.step.en}</span> : null}
            </div>
          </li>
        ))}
      </ul>
      <Link className="ws-mine-link" href={MY_REQUESTS_HREF} data-testid="ws-pending-open">{L("عرض في خدماتي", "View in My HR")}<span aria-hidden="true">{L(" ‹", " ›")}</span></Link>
    </section>
  );
}
