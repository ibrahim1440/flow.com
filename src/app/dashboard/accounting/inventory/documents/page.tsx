"use client";

// Figma: ACC-41 (desktop) and ACC-47 (390 px approval cards). Inventory documents by type and
// status; below 768 px, documents awaiting approval can be approved or rejected in place (the
// server still enforces four-eyes and duties).
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { api, ApiError, Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { Pager, useAmount, useAutoText, useCan, useDay } from "../../_components/kit";
import { DocTypeLabel, InvStatus, qty } from "../_ui";

type Row = { id: string; docNo: number; type: string; status: string; docDate: string; issueReason: string | null; description: string | null; rejectedReason: string | null; provisional: boolean;
  location: string; toLocation: string | null; createdBy: string; lines: { item: string; name: string; qty: string; unit: string; role: string }[]; value: string | null; ledger: { status: string; reason: string | null } | null };
type List = { rows: Row[]; total: number; page: number; pageSize: number; counts: Record<string, number> };
type TypeSeg = "ALL" | "RECEIPT" | "PRODUCTION" | "ISSUES" | "SALE_ISSUE" | "RETURNS" | "COUNT";
type StatusSeg = "ALL" | "DRAFT" | "PENDING" | "POSTED";

export default function InventoryDocumentsPage() {
  const { L } = useL();
  const day = useDay();
  const amt = useAmount();
  const auto = useAutoText();
  const { can } = useCan();
  const sp = useSearchParams();
  const [type, setTypeRaw] = useState<TypeSeg>("ALL");
  const [status, setStatusRaw] = useState<StatusSeg>(() => (sp.get("status") === "PENDING" ? "PENDING" : "ALL"));
  const [q, setQ] = useState(""); const [qd, setQd] = useState(""); const [page, setPage] = useState(1);
  const setType = (v: TypeSeg) => { setTypeRaw(v); setPage(1); };
  const setStatus = (v: StatusSeg) => { setStatusRaw(v); setPage(1); };
  useEffect(() => { const t = setTimeout(() => { setQd(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const params = new URLSearchParams({ page: String(page), pageSize: "25" });
  if (type !== "ALL") params.set("type", type);
  if (status !== "ALL") params.set("status", status);
  if (qd) params.set("q", qd);
  const { data, error, loading, reload } = useApi<List>(`/api/accounting/inventory/documents?${params}`);
  const n = (k: string) => data?.counts[k] ?? 0;
  const summary = (r: Row) => r.lines.length === 1 ? `${r.lines[0].name} · ${qty(r.lines[0].qty)} ${r.lines[0].unit}` : r.type === "PRODUCTION"
    ? `${r.lines.filter((l) => l.role === "INPUT").map((l) => l.name).join(" + ")} → ${r.lines.filter((l) => l.role === "OUTPUT").map((l) => `${qty(l.qty)} ${l.unit} ${l.name}`).join("، ")}`
    : L(`${r.lines.length} بنود`, `${r.lines.length} lines`);

  return (
    <Card>
      <CardTitle title={L("مستندات المخزون", "Inventory documents")}
        sub={L("استلام، صرف وهدر، تحويل، إنتاج، تكلفة مبيعات، مرتجعات، تكاليف إضافية، مطابقة فواتير، جرد — كل مستند يعتمده غير مُعدّه", "Receipts, issues and waste, transfers, production, cost of sales, returns, landed costs, bill matches, counts — each approved by someone other than its preparer")}
        right={can("inv_doc_create") ? <Link href="/dashboard/accounting/inventory/documents/new"><Button kind="primary" icon={Plus}>{L("مستند مخزون", "Inventory document")}</Button></Link> : undefined} />
      <div className="flex items-end gap-3 flex-wrap">
        <Field label={L("بحث", "Search")}><input className={`${INPUT} min-w-[220px]`} placeholder={L("رقم المستند أو الصنف…", "Document number or item…")} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Segmented<StatusSeg> value={status} onChange={setStatus} options={[
          { value: "ALL", label: L("الكل", "All") }, { value: "DRAFT", label: L(`مسودات · ${n("DRAFT")}`, `Drafts · ${n("DRAFT")}`) },
          { value: "PENDING", label: L(`بانتظار الاعتماد · ${n("SUBMITTED") + n("APPROVED")}`, `Awaiting approval · ${n("SUBMITTED") + n("APPROVED")}`) }, { value: "POSTED", label: L(`مرحّلة · ${n("POSTED")}`, `Posted · ${n("POSTED")}`) }]} />
        <Segmented<TypeSeg> value={type} onChange={setType} options={[
          { value: "ALL", label: L("الكل", "All") }, { value: "RECEIPT", label: L("استلام", "Receipts") }, { value: "PRODUCTION", label: L("إنتاج", "Production") },
          { value: "ISSUES", label: L("صرف وتحويل", "Issues & transfers") }, { value: "SALE_ISSUE", label: L("تكلفة المبيعات", "Cost of sales") }, { value: "RETURNS", label: L("مرتجعات", "Returns") }, { value: "COUNT", label: L("جرد", "Counts") }]} />
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : !data ? <LoadingState /> : data.rows.length === 0 ? <EmptyState title={L("لا توجد مستندات بهذه الشروط", "No documents match")} /> : (
        <div aria-busy={loading}>
          <MobileApprovals rows={data.rows.filter((r) => r.status === "SUBMITTED")} onDone={reload} summary={summary} />
          <div className="hidden md:block">
            <Table>
              <thead><tr><Th>{L("رقم", "No.")}</Th><Th>{L("النوع", "Type")}</Th><Th>{L("التاريخ", "Date")}</Th><Th>{L("الموقع", "Location")}</Th><Th>{L("البيان", "Description")}</Th><Th num>{L("القيمة", "Value")}</Th><Th>{L("الحالة", "Status")}</Th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="hover:bg-cream/40">
                    <Td><Link className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/inventory/documents/${r.id}`}>#{r.docNo}</Link></Td>
                    <Td><DocTypeLabel type={r.type} reason={r.issueReason} /></Td>
                    <Td className="whitespace-nowrap">{day(r.docDate)}</Td>
                    <Td>{r.location}{r.toLocation ? ` → ${r.toLocation}` : ""}</Td>
                    <Td>{r.description ? `${auto(r.description)} · ` : ""}{summary(r)}</Td>
                    <Td num>{r.value === null ? "—" : amt(r.value)}</Td>
                    <Td><span title={r.rejectedReason ?? r.ledger?.reason ?? undefined}><InvStatus status={r.status} rejected={!!r.rejectedReason} ledger={r.ledger} provisional={r.provisional} /></span></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </div>
      )}
      {data && data.total > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      <p className="text-xs text-brown">{L("المستند المرحّل لا يُعدَّل: يُصحَّح بمستند مقابل (مرتجع، جرد، صرف). لا رصيد سالب، ولا مستند بتاريخ يسبق حركة مرحّلة للصنف والموقع.", "A posted document is never edited: it is corrected by a counter document (return, count, issue). No negative stock, and no document dated before a posted movement of the same item and location.")}</p>
    </Card>
  );
}

/** Figma ACC-47: approval cards below 768 px. */
function MobileApprovals({ rows, onDone, summary }: { rows: Row[]; onDone: () => void; summary: (r: Row) => string }) {
  const { L } = useL();
  const day = useDay();
  const amt = useAmount();
  const auto = useAutoText();
  const { can } = useCan();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  if (!rows.length) return null;
  const act = async (id: string, path: string, json: unknown = {}) => {
    setBusy(id + path); setMsg(null);
    try { await api(`/api/accounting/inventory/documents/${id}/${path}`, { method: "POST", json }); setRejecting(null); setReason(""); onDone(); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : String(e)); }
    setBusy("");
  };
  return (
    <div className="md:hidden flex flex-col gap-3 mb-3">
      <p className="text-lg font-extrabold text-charcoal">{L(`مستندات مخزون بانتظار اعتمادك · ${rows.length}`, `Inventory documents awaiting approval · ${rows.length}`)}</p>
      {msg && <Notice tone="bad">{msg}</Notice>}
      {rows.map((r) => (
        <article key={r.id} className="bg-white border border-border rounded-2xl p-4 flex flex-col gap-2 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <Link className="font-bold text-orange tabular-nums" href={`/dashboard/accounting/inventory/documents/${r.id}`}>#{r.docNo}</Link>
            <InvStatus status={r.status} />
          </div>
          <p className="font-bold text-charcoal"><DocTypeLabel type={r.type} reason={r.issueReason} /> · {r.location}</p>
          <p className="text-[15px] font-extrabold text-charcoal">{summary(r)}</p>
          {r.value && <p className="text-2xl font-extrabold text-charcoal tabular-nums">{amt(r.value)} {L("ر.س", "SAR")}</p>}
          <p className="text-xs text-brown">{day(r.docDate)}{r.description ? ` · ${auto(r.description)}` : ""}</p>
          {can("inv_doc_approve") && (rejecting === r.id ? (
            <div className="flex flex-col gap-2">
              <Field label={L("سبب الرفض", "Reason")} hint={L("5 أحرف على الأقل", "At least 5 characters")}><input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="flex gap-2"><Button kind="danger" className="min-h-11 flex-1" disabled={reason.trim().length < 5} busy={busy === r.id + "reject"} onClick={() => act(r.id, "reject", { reason })}>{L("تأكيد الرفض", "Confirm rejection")}</Button><Button className="min-h-11 flex-1" onClick={() => setRejecting(null)}>{L("إلغاء", "Cancel")}</Button></div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button kind="primary" className="min-h-11 flex-1" busy={busy === r.id + "approve"} onClick={() => act(r.id, "approve")}>{L("اعتماد", "Approve")}</Button>
              <Button kind="danger" className="min-h-11 flex-1" onClick={() => { setRejecting(r.id); setReason(""); }}>{L("رفض…", "Reject…")}</Button>
            </div>
          ))}
        </article>
      ))}
      <p className="text-[11px] text-brown">{L("الأزرار بحجم لمس 44 بكسل على الأقل. الرفض يطلب سبباً. من أعدّ المستند لا يستطيع اعتماده.", "Buttons are at least 44 px. Rejection asks for a reason. The preparer cannot approve.")}</p>
    </div>
  );
}
