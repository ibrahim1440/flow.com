"use client";

// Fixed-asset register and its reconciliation with the general ledger (Figma ACC-60).
import { useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../finance/_components/ui";
import { riyadhToday, useAmount, useCan, useDay } from "../_components/kit";
import { ASSET_STATUS, Pill, faNo } from "./_ui";

type Row = { id: string; assetNo: number; name: string; classCode: string; className: string; status: string; inServiceDate: string; cost: string; accumulated: string; nbv: string | null; disposedOn: string | null };
type Item = { kind: string; ref: string; amount: string; note: string; billNo?: number; lineNo?: number; count?: number; assetNo?: number };
type Rec = { asOf: string; accounts: { accountId: string; code: string; name: string; nameAr: string | null; role: string; register: string; ledger: string; difference: string; unexplained: string; items: Item[] }[] };
const ITEM: Record<string, [string, string]> = {
  UNREGISTERED_BILL_LINE: ["بند فاتورة مرحّل على حساب الأصل ولم يُسجَّل أصلاً", "Bill line on the asset account, not registered as an asset"],
  BILL_LINE_PART: ["جزء من بند الفاتورة خارج تكلفة الأصل", "Part of a bill line outside the asset's cost"],
  BILL_LINE_PENDING_ASSET: ["بند فاتورة على أصل مسودة لم يُرسمل بعد", "Bill line on a draft asset not yet capitalised"],
  OTHER_JOURNALS: ["قيود يدوية أو افتتاحية على الحساب", "Manual, opening or other journals on the account"],
  ALREADY_IN_LEDGER: ["مسجّل كرصيد قائم في الأستاذ", "Registered as already in the ledger"],
  JOURNAL_NOT_POSTED: ["قيد أصول لم يُرحَّل بعد", "Fixed-asset journal not yet posted"],
};

export default function FixedAssetsPage() {
  const { L } = useL();
  const day = useDay();
  const amt = useAmount();
  const { can } = useCan();
  const [status, setStatus] = useState("ALL");
  const [cls, setCls] = useState("ALL");
  const [asOf, setAsOf] = useState(riyadhToday());
  const reg = useApi<Row[]>("/api/accounting/fixed-assets");
  const rec = useApi<Rec>(`/api/accounting/fixed-assets/reconciliation?asOf=${asOf}`);
  const rows = (reg.data ?? []).filter((r) => (status === "ALL" || r.status === status) && (cls === "ALL" || r.classCode === cls));
  const classes = [...new Set((reg.data ?? []).map((r) => r.classCode))];
  const refOf = (i: Item) => i.billNo !== undefined ? L(`فاتورة مورد #${i.billNo} · سطر ${i.lineNo}${i.assetNo ? ` · FA-${String(i.assetNo).padStart(4, "0")}` : ""}`, `bill #${i.billNo} · line ${i.lineNo}${i.assetNo ? ` · FA-${String(i.assetNo).padStart(4, "0")}` : ""}`)
    : i.count !== undefined ? L(`${i.count} سطر`, `${i.count} line(s)`) : i.kind === "ALREADY_IN_LEDGER" ? L("السجل", "register") : i.ref;
  const diffs = (rec.data?.accounts ?? []).filter((a) => a.difference !== "0.00").length;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L("سجل الأصول الثابتة", "Fixed-asset register")}
          sub={L(`التكلفة والمجمّع وصافي القيمة الدفترية · بيانات تجريبية في البيئة المحلية`, "Cost, accumulated depreciation and net book value · synthetic data in the local environment")}
          right={<>
            <Link href="/dashboard/accounting/assets/setup"><Button>{L("الفئات والسياسات", "Classes & policies")}</Button></Link>
            <Link href="/dashboard/accounting/assets/runs"><Button>{L("قيود الإهلاك", "Depreciation runs")}</Button></Link>
            {can("fa_prepare") && <Link href="/dashboard/accounting/assets/new"><Button kind="primary" icon={Plus}>{L("أصل جديد", "New asset")}</Button></Link>}
          </>} />
        <div className="flex flex-wrap gap-3 items-end">
          <Field label={L("الفئة", "Class")}><select aria-label={L("الفئة", "Class")} className={INPUT} value={cls} onChange={(e) => setCls(e.target.value)}><option value="ALL">{L("كل الفئات", "All classes")}</option>{classes.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label={L("الحالة", "Status")}><select aria-label={L("الحالة", "Status")} className={INPUT} value={status} onChange={(e) => setStatus(e.target.value)}><option value="ALL">{L("الكل", "All")}</option>{Object.entries(ASSET_STATUS).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
        </div>
        {reg.error ? <ErrorState error={reg.error} onRetry={reg.reload} /> : !reg.data ? <LoadingState /> : rows.length === 0 ? <EmptyState title={L("لا أصول بعد", "No assets yet")} body={L("سجّل أصلاً من بند فاتورة مورد مرحّلة أو من حساب مقابل.", "Register an asset from a posted supplier-bill line or a counter account.")} /> : (
          <Table>
            <thead><tr><Th>{L("رقم الأصل", "Asset no.")}</Th><Th>{L("الأصل", "Asset")}</Th><Th>{L("الفئة", "Class")}</Th><Th>{L("بدء الخدمة", "In service")}</Th><Th num>{L("التكلفة", "Cost")}</Th><Th num>{L("مجمع الإهلاك", "Accumulated")}</Th><Th num>{L("صافي القيمة", "Net book value")}</Th><Th>{L("الحالة", "Status")}</Th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <Td><Link className="font-bold text-orange hover:underline" href={`/dashboard/accounting/assets/${r.id}`}>{faNo(r.assetNo)}</Link></Td>
                <Td>{r.name}</Td><Td>{r.classCode}</Td><Td>{day(r.inServiceDate)}</Td>
                <Td num>{amt(r.cost)}</Td><Td num>{r.status === "DRAFT" || r.status === "SUBMITTED" ? "—" : amt(r.accumulated)}</Td><Td num>{r.nbv && r.status === "CAPITALISED" ? amt(r.nbv) : "—"}</Td>
                <Td><Pill map={ASSET_STATUS} v={r.status} />{r.disposedOn && <span className="block text-[11px] text-brown mt-1">{day(r.disposedOn)}</span>}</Td>
              </tr>))}</tbody>
          </Table>)}
      </Card>
      <Card>
        <CardTitle title={L("مطابقة السجل مع الأستاذ العام", "Register ↔ general ledger")}
          sub={L("لكل حساب أصل ومجمّع: رصيد السجل مقابل رصيد الأستاذ، وكل فرق مفسَّر بسطره", "For each cost and accumulated-depreciation account: the register against the ledger, every difference itemised")}
          right={<Field label={L("كما في", "As of")}><input aria-label={L("كما في", "As of")} type="date" className={INPUT} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>} />
        {rec.error ? <ErrorState error={rec.error} onRetry={rec.reload} /> : !rec.data ? <LoadingState /> : rec.data.accounts.length === 0 ? <EmptyState title={L("لا فئات أصول بعد", "No asset classes yet")} /> : (<>
          {diffs > 0 && <Notice tone="warn">{L(`${diffs} حساب فيه فرق — التفسير في كل سطر`, `${diffs} account(s) differ — explained line by line`)}</Notice>}
          <Table>
            <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("السجل", "Register")}</Th><Th num>{L("الأستاذ", "Ledger")}</Th><Th num>{L("الفرق", "Difference")}</Th><Th>{L("التفسير", "Explanation")}</Th></tr></thead>
            <tbody>{rec.data.accounts.map((a) => (
              <tr key={a.accountId} className="border-t border-border align-top">
                <Td><span className="font-bold">{a.code}</span> · {L(a.nameAr ?? a.name, a.name)}</Td>
                <Td num>{amt(a.register)}</Td><Td num>{amt(a.ledger)}</Td><Td num className={a.difference !== "0.00" ? "font-bold" : ""}>{amt(a.difference)}</Td>
                <Td>{a.items.length === 0 ? L("مطابق", "Agrees") : (
                  <ul className="flex flex-col gap-1">{a.items.map((i, k) => <li key={k}>{L(ITEM[i.kind]?.[0] ?? i.kind, ITEM[i.kind]?.[1] ?? i.kind)} · {refOf(i)}{i.amount && ` · ${amt(i.amount)}`}{i.kind === "JOURNAL_NOT_POSTED" && i.note ? ` · ${i.note}` : ""}</li>)}
                    {a.unexplained !== "0.00" && <li className="font-bold text-red-700">{L("غير مفسَّر", "Unexplained")}: {amt(a.unexplained)}</li>}</ul>)}</Td>
              </tr>))}</tbody>
          </Table></>)}
      </Card>
    </div>
  );
}
