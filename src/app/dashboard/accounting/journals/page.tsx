"use client";

// «القيود» (Figma ACC-02 / journal list): filters by status, type, date range and text; each row opens the entry.
import Link from "next/link";
import { useMemo, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { AcctShell, StatusTag, STATUS_AR, TYPE_AR, money, sourceLabel, useApi, useLang, type Setup } from "../_ui/shell";

type Row = { id: string; ref: string | null; entryNo: number; entryDate: string; type: string; status: string; description: string | null; totalDebit: string; sourceModule: string; sourceType: string | null; sourceId: string | null; lineCount: number; sodBypass: boolean };
type List = { items: Row[]; total: number; take: number; skip: number; byStatus: Record<string, number> };

export default function JournalsPage() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [skip, setSkip] = useState(0);
  const url = useMemo(() => {
    const p = new URLSearchParams({ take: "50", skip: String(skip) });
    if (status) p.set("status", status);
    if (type) p.set("type", type);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (q.trim()) p.set("q", q.trim());
    return `/api/accounting/journals?${p}`;
  }, [status, type, from, to, q, skip]);
  const list = useApi<List>(url);
  const d = list.data;
  const can = setup.data?.can;
  const pending = (d?.byStatus.SUBMITTED ?? 0) + (d?.byStatus.APPROVED ?? 0);
  return (
    <AcctShell setup={setup.data} pendingCount={pending}
      actions={can?.journalCreate && setup.data?.manualJournalsEnabled ? <Link className="hr-btn is-primary" href="/dashboard/accounting/journals/new" data-testid="new-journal">{L("قيد يدوي", "Manual journal")}</Link> : undefined}>
      {setup.data && !setup.data.manualJournalsEnabled ? <p className="acct-hint">{L("القيود اليدوية معطّلة في المرحلة الأولى؛ تظهر هنا القيود الآلية والافتتاحية.", "Manual journals are disabled in Phase 1; automatic and opening entries show here.")}</p> : null}
      <div className="acct-row">
        <label className="hr-field acct-grow"><span className="hr-label">{L("بحث", "Search")}</span>
          <input className="hr-input" value={q} onChange={(e) => { setQ(e.target.value); setSkip(0); }} placeholder={L("الوصف أو رقم القيد أو المصدر", "Description, entry no. or source")} data-testid="journal-search" /></label>
        <label className="hr-field"><span className="hr-label">{L("الحالة", "Status")}</span>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setSkip(0); }} placeholder={L("الكل", "All")}>
            <option value="">{L("الكل", "All")}</option>
            {Object.entries(STATUS_AR).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
          </Select></label>
        <label className="hr-field"><span className="hr-label">{L("النوع", "Type")}</span>
          <Select value={type} onChange={(e) => { setType(e.target.value); setSkip(0); }} placeholder={L("الكل", "All")}>
            <option value="">{L("الكل", "All")}</option>
            {Object.entries(TYPE_AR).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
          </Select></label>
        <label className="hr-field"><span className="hr-label">{L("من", "From")}</span><input type="date" className="hr-input" value={from} onChange={(e) => { setFrom(e.target.value); setSkip(0); }} /></label>
        <label className="hr-field"><span className="hr-label">{L("إلى", "To")}</span><input type="date" className="hr-input" value={to} onChange={(e) => { setTo(e.target.value); setSkip(0); }} /></label>
      </div>
      {list.error ? <p role="alert" className="hr-err">{list.error}</p> : null}
      {!d ? <OpsLoading /> : d.items.length === 0 ? <p className="acct-hint" data-testid="journals-empty">{L("لا قيود تطابق البحث.", "No journal matches.")}</p> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense is-mrow" data-testid="journals-table">
            <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("القيد", "Entry")}</th><th>{L("الوصف", "Description")}</th><th>{L("المصدر", "Source")}</th><th>{L("النوع", "Type")}</th><th>{L("الحالة", "Status")}</th><th className="num">{L("المبلغ", "Amount")}</th></tr></thead>
            <tbody>
              {d.items.map((j) => (
                <tr key={j.id}>
                  <td className="hr-num">{j.entryDate}</td>
                  <td className="m-title"><Link href={`/dashboard/accounting/journals/${j.id}`} className="acct-code">{j.ref ?? `#${j.entryNo}`}</Link>
                    <span className="hr-msub">{j.entryDate} · {j.description ?? "—"}</span></td>
                  <td>{j.description ?? "—"}</td>
                  <td>{j.sourceType === "OPENING_BALANCE" ? L("الأرصدة الافتتاحية", "Opening balances") : sourceLabel(j.sourceModule, L)}{j.sourceType && j.sourceType !== "OPENING_BALANCE" ? <span className="acct-code"> · {j.sourceType}</span> : null}</td>
                  <td>{L(TYPE_AR[j.type]?.[0] ?? j.type, TYPE_AR[j.type]?.[1] ?? j.type)}</td>
                  <td><StatusTag map={STATUS_AR} value={j.status} /></td>
                  <td className="num hr-num m-end">{money(j.totalDebit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d && d.total > d.take ? (
        <div className="hr-tablefoot">
          <span className="hr-caption">{L(`${d.skip + 1}–${Math.min(d.skip + d.take, d.total)} من ${d.total}`, `${d.skip + 1}–${Math.min(d.skip + d.take, d.total)} of ${d.total}`)}</span>
          <span className="acct-actions">
            <button type="button" className="hr-btn is-sm" disabled={d.skip === 0} onClick={() => setSkip(Math.max(0, d.skip - d.take))}>{L("السابق", "Previous")}</button>
            <button type="button" className="hr-btn is-sm" disabled={d.skip + d.take >= d.total} onClick={() => setSkip(d.skip + d.take)}>{L("التالي", "Next")}</button>
          </span>
        </div>
      ) : null}
    </AcctShell>
  );
}
