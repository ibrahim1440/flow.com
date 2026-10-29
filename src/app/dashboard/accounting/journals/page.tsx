"use client";

// «القيود» (Figma ACC-02 / journal list): filters by status, type, date range and text; each row opens the entry.
import Link from "next/link";
import { useMemo, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { AcctShell, StatusTag, STATUS_AR, TYPE_AR, money, sourceLabel, useApi, useLang, type Setup } from "../_ui/shell";
import { DateRange, FilterCard, Section, ListFooter, ListPageSize, useFilters, useTerm } from "@/components/chrome";
import { useAccountantView } from "../_ui/qoyod-pages";

type Row = { id: string; ref: string | null; entryNo: number; entryDate: string; type: string; status: string; description: string | null; totalDebit: string; sourceModule: string; sourceType: string | null; sourceId: string | null; lineCount: number; sodBypass: boolean };
type List = { items: Row[]; total: number; take: number; skip: number; byStatus: Record<string, number> };

export default function JournalsPage() {
  const { L } = useLang();
  // Qoyod parity (accountant workspace only): the filter card, المرجع · التاريخ · الوصف · المصدر · النوع · المبلغ · الحالة ·
  // الخيارات, the dark title bar and the pager. Same API and query parameters; everyone else keeps this page as it was.
  const qoyod = useAccountantView();
  const t = useTerm();
  const setup = useApi<Setup>("/api/accounting/setup");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [skip, setSkip] = useState(0);
  const f = useFilters({ from: "", to: "", status: "", type: "", q: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(15);
  const url = useMemo(() => {
    const v = qoyod ? f.applied : { status, type, from, to, q };
    const p = new URLSearchParams(qoyod ? { take: String(size), skip: String((page - 1) * size) } : { take: "50", skip: String(skip) });
    if (v.status) p.set("status", v.status);
    if (v.type) p.set("type", v.type);
    if (v.from) p.set("from", v.from);
    if (v.to) p.set("to", v.to);
    if (v.q.trim()) p.set("q", v.q.trim());
    return `/api/accounting/journals?${p}`;
  }, [qoyod, f.applied, page, size, status, type, from, to, q, skip]);
  const list = useApi<List>(url);
  const d = list.data;
  const can = setup.data?.can;
  const pending = (d?.byStatus.SUBMITTED ?? 0) + (d?.byStatus.APPROVED ?? 0);
  return (
    <AcctShell setup={setup.data} pendingCount={pending}
      actions={can?.journalCreate && setup.data?.manualJournalsEnabled ? <Link className="hr-btn is-primary" href="/dashboard/accounting/journals/new" data-testid="new-journal">{qoyod ? `+ ${t("newJournal")}` : L("قيد يدوي", "Manual journal")}</Link> : undefined}>
      {setup.data && !setup.data.manualJournalsEnabled ? <p className="acct-hint">{L("القيود اليدوية معطّلة في المرحلة الأولى؛ تظهر هنا القيود الآلية والافتتاحية.", "Manual journals are disabled in Phase 1; automatic and opening entries show here.")}</p> : null}
      {qoyod ? (
        <FilterCard onApply={() => { f.apply(); setPage(1); }} onReset={() => { f.reset(); setPage(1); }} busy={list.loading}>
          <DateRange from={f.draft.from} to={f.draft.to} onChange={(r) => f.setDraft({ ...f.draft, ...r })} />
          <div className="qc-field"><span className="qc-label">{t("colStatus")}</span>
            <Select value={f.draft.status} onChange={(e) => f.set("status", e.target.value)} aria-label={t("colStatus")} data-testid="qf-status">
              <option value="">{L("الكل", "All")}</option>
              {Object.entries(STATUS_AR).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
            </Select></div>
          <div className="qc-field"><span className="qc-label">{t("colType")}</span>
            <Select value={f.draft.type} onChange={(e) => f.set("type", e.target.value)} aria-label={t("colType")}>
              <option value="">{L("الكل", "All")}</option>
              {Object.entries(TYPE_AR).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
            </Select></div>
          <div className="qc-field"><span className="qc-label">{L("بحث", "Search")}</span>
            <input className="hr-input" value={f.draft.q} onChange={(e) => f.set("q", e.target.value)} placeholder={L("الوصف أو رقم القيد أو المصدر", "Description, entry no. or source")} data-testid="journal-search" /></div>
        </FilterCard>
      ) : (
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
      )}
      {list.error ? <p role="alert" className="hr-err">{list.error}</p> : null}
      {!d ? <OpsLoading /> : d.items.length === 0 ? <p className="acct-hint" data-testid="journals-empty">{L("لا قيود تطابق البحث.", "No journal matches.")}</p> : qoyod ? (
        <Section title={t("journals")} testId="journals-section">
        <ListPageSize pageSize={size} onPageSize={setSize} onPage={setPage} />
        <div className="hr-tablewrap">
          <table className="hr-table is-dense is-mrow" data-testid="journals-table" data-layout="qoyod">
            <thead><tr><th>{t("colRef")}</th><th>{t("colDate")}</th><th>{t("colDescription")}</th><th className="acct-hide-m">{t("colSource")}</th><th className="acct-hide-m">{t("colType")}</th><th className="num">{t("colAmount")}</th><th>{t("colStatus")}</th><th className="acct-hide-m">{t("colOptions")}</th></tr></thead>
            <tbody>
              {d.items.map((j) => (
                <tr key={j.id}>
                  <td className="m-title"><Link href={`/dashboard/accounting/journals/${j.id}`} className="acct-code">{j.ref ?? `#${j.entryNo}`}</Link>
                    <span className="hr-msub">{j.entryDate} · {j.description ?? "—"}</span></td>
                  <td className="hr-num">{j.entryDate}</td>
                  <td>{j.description ?? "—"}</td>
                  <td className="acct-hide-m">{j.sourceType === "OPENING_BALANCE" ? L("الأرصدة الافتتاحية", "Opening balances") : sourceLabel(j.sourceModule, L)}{j.sourceType && j.sourceType !== "OPENING_BALANCE" ? <span className="acct-code"> · {j.sourceType}</span> : null}</td>
                  <td className="acct-hide-m">{L(TYPE_AR[j.type]?.[0] ?? j.type, TYPE_AR[j.type]?.[1] ?? j.type)}</td>
                  <td className="num hr-num m-end">{money(j.totalDebit)}</td>
                  <td><StatusTag map={STATUS_AR} value={j.status} /></td>
                  <td className="acct-hide-m"><Link className="hr-btn is-sm is-ghost" href={`/dashboard/accounting/journals/${j.id}`}>{t("rowView")}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ListFooter page={page} pageSize={size} total={d.total} onPage={setPage} onPageSize={setSize} noun={L("قيدًا", "entries")} />
        </Section>
      ) : (
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
      {!qoyod && d && d.total > d.take ? (
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
