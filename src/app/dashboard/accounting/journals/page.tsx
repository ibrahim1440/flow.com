"use client";

// Figma: ACC-02. Journal list: status segments, date/type filters, search, sort, pagination.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, Field, INPUT, LoadingState, Segmented, Table, Td, Th, useApi, useL } from "../../finance/_components/ui";
import { JournalStatus, JournalType, Pager, useAutoText, useCan, useDay } from "../_components/kit";

type Row = { id: string; entryNo: number; entryDate: string; description: string | null; type: string; status: string; sourceModule: string; total: number; isProvisional: boolean; createdBy: string | null; approvedBy: string | null; rejectionReason: string | null; reversesEntryId: string | null };
type Seg = "ALL" | "PENDING" | "DRAFT" | "POSTED" | "REVERSED";

export default function JournalsPage() {
  const { L, money } = useL();
  const day = useDay();
  const auto = useAutoText();
  const { can } = useCan();
  const sp = useSearchParams();
  const [seg, setSegRaw] = useState<Seg>(() => (["PENDING", "SUBMITTED"].includes(sp.get("status") ?? "") ? "PENDING" : "ALL"));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  // Any filter change starts again at page 1 (set in the same event, not in an effect).
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const setSeg = reset(setSegRaw);
  useEffect(() => { const t = setTimeout(() => { setQDebounced(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const params = new URLSearchParams({ page: String(page), pageSize: "25", sort });
  if (seg !== "ALL") params.set("status", seg);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (type) params.set("type", type);
  if (qDebounced) params.set("q", qDebounced);
  const { data, error, loading, reload } = useApi<{ rows: Row[]; total: number; page: number; pageSize: number }>(`/api/accounting/journals?${params}`);

  return (
    <Card>
      <div className="flex items-end gap-3 flex-wrap justify-between">
        <div className="flex items-end gap-3 flex-wrap">
          <Segmented<Seg> value={seg} onChange={setSeg} options={[
            { value: "ALL", label: L("الكل", "All") }, { value: "PENDING", label: L("بانتظار الاعتماد/الترحيل", "Awaiting approval/posting") },
            { value: "DRAFT", label: L("مسودات", "Drafts") }, { value: "POSTED", label: L("مرحّلة", "Posted") }, { value: "REVERSED", label: L("معكوسة", "Reversed") },
          ]} />
          <Field label={L("من", "From")}><input type="date" className={INPUT} value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></Field>
          <Field label={L("إلى", "To")}><input type="date" className={INPUT} value={to} onChange={(e) => reset(setTo)(e.target.value)} /></Field>
          <Field label={L("النوع", "Type")}>
            <select className={INPUT} value={type} onChange={(e) => reset(setType)(e.target.value)}>
              <option value="">{L("كل الأنواع", "All types")}</option>
              <option value="MANUAL">{L("يدوي", "Manual")}</option><option value="AUTO">{L("آلي", "Automatic")}</option>
              <option value="REVERSAL">{L("عكسي", "Reversal")}</option><option value="ADJUSTMENT">{L("تسوية", "Adjustment")}</option><option value="OPENING">{L("افتتاحي", "Opening")}</option>
            </select>
          </Field>
          <Field label={L("ترتيب", "Sort")}>
            <select className={INPUT} value={sort} onChange={(e) => reset(setSort)(e.target.value)}>
              <option value="newest">{L("الأحدث أولاً", "Newest first")}</option><option value="oldest">{L("الأقدم أولاً", "Oldest first")}</option><option value="amount">{L("الأكبر مبلغاً", "Largest amount")}</option>
            </select>
          </Field>
          <Field label={L("بحث", "Search")}><input className={INPUT} placeholder={L("رقم القيد أو الوصف…", "Entry number or description…")} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        </div>
        {can("journal_create") && <Link href="/dashboard/accounting/journals/new"><Button kind="primary" icon={Plus}>{L("قيد جديد", "New entry")}</Button></Link>}
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : !data ? <LoadingState /> : data.rows.length === 0 ? (
        <EmptyState title={L("لا توجد قيود بهذه الشروط", "No entries match")} body={L("غيّر التصفية أو أنشئ قيداً جديداً.", "Change the filters or create an entry.")} />
      ) : (
        <div aria-busy={loading}>
          <Table>
            <thead><tr><Th>{L("رقم", "No.")}</Th><Th>{L("التاريخ", "Date")}</Th><Th>{L("الوصف", "Description")}</Th><Th>{L("النوع", "Type")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{L("الحالة", "Status")}</Th><Th>{L("أعدّه / اعتمده", "Prepared / approved")}</Th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="hover:bg-cream/40">
                  <Td><a className="font-bold text-orange hover:underline" href={`/dashboard/accounting/journals/${r.id}`}>#{r.entryNo}</a></Td>
                  <Td className="whitespace-nowrap">{day(r.entryDate)}</Td>
                  <Td className="max-w-[380px]"><span className="line-clamp-2">{auto(r.description) || "—"}</span>{r.isProvisional && <span className="ms-1 text-[11px] font-bold text-amber-700">{L("(مؤقت)", "(provisional)")}</span>}</Td>
                  <Td><JournalType type={r.type} source={r.sourceModule} /></Td>
                  <Td num>{money(r.total)}</Td>
                  <Td><span title={r.rejectionReason ?? undefined}><JournalStatus status={r.status} rejected={!!r.rejectionReason} /></span></Td>
                  <Td className="text-xs text-brown">{[r.createdBy, r.approvedBy].filter(Boolean).join(" / ")}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {data && data.total > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </Card>
  );
}
