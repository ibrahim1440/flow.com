"use client";
// «مساحة عملي · بانتظار اعتمادي» (Figma WS-05, 1745:1424 / 1745:1813 / 1745:1901 / 1745:1902). One inbox
// over the departments' queues; each decision is taken by the department's own endpoint (approval-ui.tsx).
import { useMemo, useState } from "react";
import { Notice, OpsBanner, OpsEmpty, OpsError, OpsLoading, useL } from "@/components/ops/ui";
import { ago } from "@/lib/workspace/format";
import { TypeChip, WsPage, WsShell, useLang, useNow, useSelection, useWs, type ApprovalItem } from "../_components/kit";
import { DecisionPane } from "../_components/approval-ui";

type Inbox = { items: ApprovalItem[]; counts: Record<string, number>; total: number; unavailable: string[] };
const TYPES: [string, string, string][] = [["", "الكل", "All"], ["LEAVE", "إجازات", "Leave"], ["ADVANCE", "سلف", "Advances"], ["DISCOUNT", "خصومات", "Discounts"], ["FINANCE", "مالية", "Finance"], ["MARKETING", "تسويق", "Marketing"]];

export default function ApprovalsPage() {
  const L = useL();
  const lang = useLang();
  const now = useNow();
  const { data, error, loading, reload } = useWs<Inbox>("/api/workspace/approvals");
  const [key, setKey] = useSelection("approval");
  const [type, setType] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  // The item just decided: its pane stays open on the outcome after the list reloads without it.
  const [held, setHeld] = useState<ApprovalItem | null>(null);
  const items = useMemo(() => (data?.items ?? []).filter((i) => !gone.has(i.key) && (!type || i.type === type)), [data, type, gone]);
  const selected = data?.items.find((i) => i.key === key) ?? (held && held.key === key ? held : null);

  return (
    <WsShell open={!!(selected)}>
      <WsPage title={L("بانتظار اعتمادي", "Pending my approval")} sub={<span className="hr-caption">{L("يُنفَّذ كل قرار في القسم المختص بقواعده نفسها.", "Every decision is carried out by its own department, under its own rules.")}</span>} testId="ws-approvals">
        {toast ? <OpsBanner tone="success" onClose={() => setToast(null)}>{toast}</OpsBanner> : null}
        {error ? <OpsError message={error.message} onRetry={reload} /> : null}
        {data?.unavailable.length ? <Notice tone="warning">{L("تعذّر تحميل جزء من الطلبات الآن؛ أعد المحاولة بعد قليل.", "Part of the queue could not be loaded; try again shortly.")}</Notice> : null}
        <div className="ws-seg" role="group" aria-label={L("نوع الطلب", "Request type")}>
          {TYPES.filter(([t]) => !t || (data?.counts[t] ?? 0) > 0 || type === t).map(([t, a, e]) => (
            <button key={t || "all"} type="button" aria-pressed={type === t} onClick={() => setType(t)}>{L(a, e)} <span className="hr-count">{t ? data?.counts[t] ?? 0 : items.length}</span></button>
          ))}
        </div>
        {loading && !data ? <OpsLoading /> : null}
        {data && items.length === 0 ? <OpsEmpty title={L("لا طلبات تنتظر قرارك", "Nothing is waiting for your decision")} body={L("تظهر هنا طلبات الإجازة والسلف والخصومات وغيرها عندما تكون أنت صاحب القرار.", "Leave, advance, discount and other requests appear here when the decision is yours.")} /> : null}
        {items.length ? (
          <ul className="ws-rows" aria-busy={loading || undefined}>
            {items.map((i) => (
              <li key={i.key} className={`ws-row${key === i.key ? " is-selected" : ""}`}>
                <TypeChip type={i.type} />
                <button type="button" className="ws-row-main" onClick={() => setKey(i.key)} aria-current={key === i.key || undefined} data-testid={`approval-${i.type}`}>
                  <span className="ws-row-title">{i.title}{i.subject ? ` · ${i.subject}` : ""}</span>
                  <span className="ws-row-meta">
                    {i.requester ? <span>{i.requester}</span> : null}
                    <span>{ago(i.createdAt, lang, now)}</span>
                    {i.warnings.length ? <span className="hr-flag tone-warning"><span>{lang === "ar" ? i.warnings[0].ar : i.warnings[0].en}</span></span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </WsPage>
      {selected ? <DecisionPane item={selected} onClose={() => { setKey(null); setHeld(null); }} onDecided={(m, it, refresh) => {
        if (m) { setToast(m); setHeld(it); setGone((g) => new Set(g).add(it.key)); }
        if (refresh || m) reload();
      }} /> : null}
    </WsShell>
  );
}
