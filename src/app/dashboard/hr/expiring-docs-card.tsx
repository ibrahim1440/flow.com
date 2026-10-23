"use client";
// «وثائق قريبة الانتهاء» — the HR dashboard card (feat/hr-expiry-email). Shown to a caller holding a duty
// that sees an expiry (documents_view, private_view, contracts_manage); the API returns only the items
// those duties and the caller's scope cover (lib/hr/services/document-expiry.ts expiringForActor).
import Link from "next/link";
import { useState } from "react";
import { Btn, Flag, useCan, useHr, useHrI18n } from "@/components/hr/ui";

type Item = {
  source: string; id: string; employeeId: string; employeeNo: string; employeeName: string; labelAr: string; labelEn: string;
  expiresOn: string; daysLeft: number; tab: string; badge: { tone: "danger" | "warning"; ar: string; en: string } | null;
};
type Data = { today: string; thresholds: number[]; counts: { expired: number; soon: number }; items: Item[] };

export function ExpiringDocsCard() {
  const can = useCan();
  const allowed = can("documents_view") || can("private_view") || can("contracts_manage");
  const { data } = useHr<Data>(allowed ? "/api/hr/document-expiry" : null);
  const [all, setAll] = useState(false);
  const { L, en } = useHrI18n();
  if (!allowed || !data || data.items.length === 0) return null;
  const shown = all ? data.items : data.items.slice(0, 4);
  return (
    <section className="hr-expiry-card" data-testid="hr-expiring-docs" aria-label={L("وثائق قريبة الانتهاء", "Documents expiring soon")}>
      <div className="hr-expiry-card-head">
        <span className="hr-section">{L("وثائق قريبة الانتهاء", "Documents expiring soon")}</span>
        <span className="hr-expiry-card-counts">
          {data.counts.expired ? <Flag tone="danger">{L(`منتهية ${data.counts.expired}`, `${data.counts.expired} expired`)}</Flag> : null}
          {data.counts.soon ? <Flag>{L(`خلال ${data.thresholds[0]} يومًا: ${data.counts.soon}`, `Within ${data.thresholds[0]} days: ${data.counts.soon}`)}</Flag> : null}
        </span>
      </div>
      <ul className="hr-expiry-list">
        {shown.map((i) => (
          <li key={`${i.source}:${i.id}`}>
            <Link href={`/dashboard/hr/employees/${i.employeeId}?tab=${i.tab}`} className="hr-expiry-who">
              <span className="strong">{i.employeeName}</span>
              <span className="hr-caption"> · {en ? i.labelEn : i.labelAr}</span>
            </Link>
            <span className="hr-expiry-when">
              <span className="hr-num">{i.expiresOn}</span>
              {i.badge ? <Flag tone={i.badge.tone}>{en ? i.badge.en : i.badge.ar}</Flag> : null}
            </span>
          </li>
        ))}
      </ul>
      {data.items.length > 4 ? <Btn size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>{all ? L("عرض أقل", "Show less") : L(`عرض الكل (${data.items.length})`, `Show all (${data.items.length})`)}</Btn> : null}
    </section>
  );
}
