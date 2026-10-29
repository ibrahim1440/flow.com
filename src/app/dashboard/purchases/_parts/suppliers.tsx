"use client";
// «الموردين» — the purchases screen's supplier list (phase 2): VAT number, payment terms, contact and, for an AP
// reader, the open balance (approved, unpaid) and what awaits approval. Add and edit with the existing gates:
// the name and contact are catalogue maintenance (POST /api/suppliers, PATCH /api/purchases/suppliers — inventory ›
// receive or adjust); the VAT number and terms belong to accounts payable (PATCH /api/accounting/ap/suppliers).
import { useState } from "react";
import { Btn, Field, Notice, OpsLoading } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { acctFetch, money, useApi, useLang } from "../../accounting/_ui/shell";
import type { PurchaseCan } from "./invoices";
import Link from "next/link";
import { ReliabilityBlock } from "./claims";
import { useAccountantView } from "../../accounting/_ui/qoyod-pages";

export type SupplierRow = { id: string; name: string; contact: string | null; vatNumber: string | null; isNonResident?: boolean; kind?: string; paymentTermsDays: number | null; receipts: number; openBalance: string | null; awaitingApproval: string | null; openClaims?: string | null };

/** Create or edit a supplier: name and contact (inventory duty), VAT number and terms (accounts payable). */
export function SupplierDialog({ initial, can, onClose, onSaved }: { initial: SupplierRow | null; can: PurchaseCan; onClose: () => void; onSaved: (s: { id: string; name: string }) => void }) {
  const { L } = useLang();
  const [f, setF] = useState({ name: initial?.name ?? "", contact: initial?.contact ?? "", vatNumber: initial?.vatNumber ?? "", terms: initial?.paymentTermsDays?.toString() ?? "", nonResident: !!initial?.isNonResident, kind: initial?.kind ?? "GOODS_SERVICES" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canName = can.suppliers;
  async function save() {
    setBusy(true); setError("");
    try {
      let id = initial?.id ?? "";
      if (!initial) id = (await acctFetch<{ id: string }>("/api/suppliers", { method: "POST", json: { name: f.name.trim(), contact: f.contact.trim() || null } })).id;
      else if (canName && (f.name.trim() !== initial.name || (f.contact.trim() || null) !== initial.contact)) await acctFetch("/api/purchases/suppliers", { method: "PATCH", json: { id, name: f.name.trim(), contact: f.contact.trim() || null } });
      if (can.ap && (!initial || f.vatNumber.trim() !== (initial.vatNumber ?? "") || f.terms.trim() !== (initial.paymentTermsDays?.toString() ?? "") || f.nonResident !== !!initial.isNonResident || f.kind !== (initial.kind ?? "GOODS_SERVICES"))) {
        await acctFetch("/api/accounting/ap/suppliers", { method: "PATCH", json: { id, vatNumber: f.vatNumber.trim() || null, paymentTermsDays: f.terms.trim() === "" ? null : Number(f.terms), isNonResident: f.nonResident, kind: f.kind } });
      }
      onSaved({ id, name: f.name.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open title={initial ? L("تعديل المورد", "Edit supplier") : L("مورد جديد", "New supplier")} onClose={onClose} testId="supplier-dialog"
      actions={<><Btn variant="primary" busy={busy} disabled={!f.name.trim() || (!initial && !canName)} onClick={save} data-testid="supplier-save">{L("حفظ المورد", "Save supplier")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="hr-form">
        <Field label={`${L("اسم المورد", "Supplier name")} *`} wide>
          <input className="hr-input" value={f.name} disabled={!canName} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={L("مثال: شركة المحاصيل الخضراء", "e.g. Green Harvest Co.")} data-testid="supplier-name" />
        </Field>
        <Field label={L("التواصل", "Contact")}>
          <input className="hr-input" dir="ltr" value={f.contact} disabled={!canName} onChange={(e) => setF({ ...f, contact: e.target.value })} placeholder="+966 5x xxx xxxx" />
        </Field>
        <Field label={L("الرقم الضريبي", "VAT number")} help={can.ap ? L("15 رقمًا", "15 digits") : L("يضبطه محاسب الذمم الدائنة", "Set by accounts payable")}>
          <input className="hr-input hr-id" dir="ltr" inputMode="numeric" value={f.vatNumber} disabled={!can.ap} onChange={(e) => setF({ ...f, vatNumber: e.target.value })} placeholder="3xxxxxxxxxxxxx3" data-testid="supplier-vat" />
        </Field>
        <Field label={L("شروط الدفع (يوم)", "Payment terms (days)")} help={L("فارغ = 30 يومًا", "Empty = 30 days")}>
          <input className="hr-input" type="number" min={0} max={365} value={f.terms} disabled={!can.ap} onChange={(e) => setF({ ...f, terms: e.target.value })} data-testid="supplier-terms" />
        </Field>
        <Field label={L("نوع المورد", "Supplier kind")} help={L("ضريبة الاستيراد تُفوتر من الجمارك أو المخلّص فقط", "Import VAT is billed by customs or a clearing agent only")}>
          <Select value={f.kind} disabled={!can.ap} onChange={(e) => setF({ ...f, kind: e.target.value })} data-testid="supplier-kind" aria-label={L("نوع المورد", "Supplier kind")}>
            <option value="GOODS_SERVICES">{L("مورد بضائع أو خدمات", "Goods or services supplier")}</option>
            <option value="CUSTOMS">{L("الجمارك (هيئة الزكاة والضريبة والجمارك)", "Customs (ZATCA customs)")}</option>
            <option value="CLEARING_AGENT">{L("مخلّص جمركي", "Clearing agent")}</option>
          </Select>
        </Field>
        <label className="pur-check">
          <input type="checkbox" checked={f.nonResident} disabled={!can.ap} onChange={(e) => setF({ ...f, nonResident: e.target.checked })} data-testid="supplier-nonresident" />
          <span>{L("مورد غير مقيم (خارج المملكة) — خدماته باحتساب عكسي", "Non-resident supplier (outside the Kingdom) — its services are reverse-charged")}</span>
        </label>
      </div>
    </Dialog>
  );
}

export function SuppliersTab() {
  const { L } = useLang();
  const list = useApi<{ can: PurchaseCan; rows: SupplierRow[] }>("/api/purchases/suppliers");
  // Qoyod parity (accountant workspace only): each name opens «تفاصيل المورد», and «متأخرة» (the AP aging past due) sits
  // beside the open balance. Everyone else keeps this tab as it was.
  const qoyod = useAccountantView();
  const aging = useApi<{ suppliers: { supplierId: string; buckets: Record<string, string>; total: string }[] }>(qoyod && list.data?.can.read ? "/api/accounting/ap/aging" : null);
  const overdueOf = (id: string) => { const a = aging.data?.suppliers.find((x) => x.supplierId === id); return a ? Number(a.total) - Number(a.buckets.current ?? 0) : 0; };
  const [edit, setEdit] = useState<SupplierRow | "new" | null>(null);
  const [q, setQ] = useState("");
  const [done, setDone] = useState("");
  if (list.error && !list.data) return <Notice tone="danger">{list.error}</Notice>;
  if (!list.data) return <OpsLoading />;
  const { can } = list.data;
  const rows = list.data.rows.filter((r) => `${r.name} ${r.vatNumber ?? ""} ${r.contact ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  const open = rows.reduce((a, r) => a + Number(r.openBalance ?? 0), 0);
  return (
    <div className="hr-stack pur-tab" data-testid="suppliers-tab">
      {done ? <Notice tone="success">{done}</Notice> : null}
      <div className="stk-tool">
        <input type="search" className="hr-input hr-search" placeholder={L("اسم المورد أو الرقم الضريبي", "Supplier name or VAT number")} aria-label={L("بحث في الموردين", "Search suppliers")} value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="stk-end">{can.suppliers ? <Btn variant="primary" onClick={() => setEdit("new")} data-testid="supplier-new">+ {L("مورد جديد", "New supplier")}</Btn> : null}</span>
      </div>
      <div className="hr-tablewrap">
        <table className="hr-table is-mrow" data-testid="suppliers-table" aria-label={L("الموردون", "Suppliers")}>
          <thead><tr>
            <th>{L("المورد", "Supplier")}</th><th>{L("الرقم الضريبي", "VAT number")}</th><th className="hr-hide-compact">{L("شروط الدفع", "Terms")}</th>
            <th className="hr-hide-compact">{L("التواصل", "Contact")}</th><th className="num hr-hide-compact">{L("الاستلامات", "Receipts")}</th>
            {can.read ? <><th className="num hr-hide-compact">{L("بانتظار الاعتماد", "Awaiting approval")}</th><th className="num">{qoyod ? L("الرصيد", "Balance") : L("الرصيد المفتوح", "Open balance")}</th>{qoyod ? <th className="num">{L("متأخرة", "Overdue")}</th> : null}<th className="num">{L("مطالبات مفتوحة", "Open claims")}</th></> : null}
            <th />
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="m-title">{qoyod ? <Link className="strong" href={`/dashboard/purchases/suppliers/${r.id}`} data-testid={`supplier-open-${r.id}`}>{r.name}</Link> : <span className="strong">{r.name}</span>}<span className="hr-msub">{r.vatNumber ? <bdi className="acct-code">{r.vatNumber}</bdi> : L("بلا رقم ضريبي", "No VAT number")} · {L(`${r.paymentTermsDays ?? 30} يومًا`, `${r.paymentTermsDays ?? 30} days`)}</span></td>
                <td>{r.vatNumber ? <bdi className="acct-code">{r.vatNumber}</bdi> : <span className="hr-caption">—</span>}{r.isNonResident ? <span className="pur-tag">{L("غير مقيم", "Non-resident")}</span> : null}{r.kind === "CUSTOMS" ? <span className="pur-tag">{L("جمارك", "Customs")}</span> : r.kind === "CLEARING_AGENT" ? <span className="pur-tag">{L("مخلّص", "Clearing agent")}</span> : null}</td>
                <td className="hr-hide-compact">{L(`${r.paymentTermsDays ?? 30} يومًا`, `${r.paymentTermsDays ?? 30} days`)}{r.paymentTermsDays === null ? <span className="hr-caption"> {L("(افتراضي)", "(default)")}</span> : null}</td>
                <td className="hr-hide-compact">{r.contact ? <bdi dir="ltr">{r.contact}</bdi> : "—"}</td>
                <td className="num hr-hide-compact hr-num">{r.receipts}</td>
                {can.read ? <><td className="num hr-hide-compact hr-num">{money(r.awaitingApproval ?? 0)}</td><td className="num hr-num m-end" style={{ fontWeight: 600 }}>{money(r.openBalance ?? 0)}</td>{qoyod ? <td className="num hr-num" data-testid={`supplier-overdue-${r.id}`}>{aging.data ? (overdueOf(r.id) ? <span className="acct-bad">{money(overdueOf(r.id))}</span> : <span className="hr-caption">—</span>) : "…"}</td> : null}
                  <td className="num hr-num" data-testid={`supplier-claims-${r.id}`}>{Number(r.openClaims ?? 0) ? <Link className="pur-inv-link" href={`/dashboard/purchases?tab=claims&supplier=${r.id}`}>{money(r.openClaims ?? 0)}</Link> : <span className="hr-caption">—</span>}</td></> : null}
                <td>{can.suppliers || can.ap ? <Btn size="sm" variant="ghost" onClick={() => setEdit(r)} data-testid={`supplier-edit-${r.id}`}>{L("تعديل", "Edit")}</Btn> : null}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={9} className="acct-hint">{q ? L("لا نتائج.", "No results.") : L("لا موردين بعد.", "No suppliers yet.")}</td></tr> : null}
          </tbody>
          {can.read ? <tfoot><tr><td colSpan={6}>{L(`${rows.length} مورد`, `${rows.length} suppliers`)}</td><td className="num stk-tot hr-num">{money(open)}</td>{qoyod ? <td /> : null}<td className="num hr-num">{money(rows.reduce((a, r) => a + Number(r.openClaims ?? 0), 0))}</td><td /></tr></tfoot> : null}
        </table>
      </div>
      <p className="acct-hint">{L("الرصيد المفتوح: الفواتير المعتمدة غير المسددة (بعد الإشعارات الدائنة). مطالبات مفتوحة: ما فوترَه المورد ولم يصل بعد. الرصيد الافتتاحي للمورد وكشف حسابه من «المحاسبة › الذمم الدائنة».", "Open balance: approved invoices not yet paid (after credit notes). Open claims: what the supplier billed and has not delivered. The supplier's opening balance and statement are under «Accounting › Payables».")}</p>
      {can.read ? <ReliabilityBlock /> : null}
      {edit ? <SupplierDialog initial={edit === "new" ? null : edit} can={can} onClose={() => setEdit(null)} onSaved={(s) => { setEdit(null); setDone(L(`حُفظ المورد «${s.name}».`, `Supplier «${s.name}» saved.`)); list.reload(); }} /> : null}
    </div>
  );
}
