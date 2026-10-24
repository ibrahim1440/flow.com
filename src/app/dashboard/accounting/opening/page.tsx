"use client";

// «الأرصدة الافتتاحية»: the trial balance carried in from the old books at the go-live date — entered in the grid
// or imported from CSV (preview first), AR / AP per customer / supplier; the difference goes to opening balance
// equity; posted ONCE (step-up), then the grid is final.
import { useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { AcctShell, Msg, money, useApi, useLang, useWrite, type Setup } from "../_ui/shell";

type Opening = {
  goLiveDate: string | null; active: boolean; posted: boolean; entry: { id: string; postingYear: number | null; postingSeq: number | null; entryDate: string } | null;
  equityAccount: { id: string; code: string; name: string } | null;
  lines: { accountId: string; account: { code: string; nameAr: string | null; nameEn: string; controlType: string | null }; debit: string; credit: string; partyType: string | null; partyId: string | null; description: string | null }[];
  totals: { debit: string; credit: string; difference: string };
};
type Dims = { accounts: { id: string; code: string; nameAr: string | null; nameEn: string; controlType: string | null }[]; customers: { id: string; name: string }[]; suppliers: { id: string; name: string }[] };
type Row = { accountId: string; debit: string; credit: string; party: string; description: string };
const SAMPLE = "account_code,debit,credit,party_type,party,description\n1121,50000.00,,,,Bank balance\n1140,2300.00,,CUSTOMER,<customer name or id>,Customer balance\n2110,,12000.00,SUPPLIER,<supplier name or id>,Supplier balance\n3100,,30000.00,,,Capital";

export default function OpeningPage() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const op = useApi<Opening>("/api/accounting/opening");
  const dims = useApi<Dims>("/api/accounting/dimensions");
  // A locked line shows its party by name (the id when the party is not listed, e.g. an employee).
  const partyName = (party: string) => {
    const [pt, pid] = party.split(":");
    const list = pt === "CUSTOMER" ? dims.data?.customers : pt === "SUPPLIER" ? dims.data?.suppliers : undefined;
    return list?.find((p) => p.id === pid)?.name ?? pid ?? party;
  };
  const w = useWrite();
  // The grid being edited, tied to the loaded data it started from (a reload starts again from the server's rows).
  const [edit, setEdit] = useState<{ base: Opening; rows: Row[] } | null>(null);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<null | { lines: unknown[]; problems: { row: number; en: string; ar: string }[] }>(null);
  const [confirm, setConfirm] = useState(false);
  const can = setup.data?.can.opening;
  const o = op.data;
  const fromServer = (x: Opening): Row[] => x.lines.map((l) => ({ accountId: l.accountId, debit: Number(l.debit) ? l.debit : "", credit: Number(l.credit) ? l.credit : "", party: l.partyType && l.partyId ? `${l.partyType}:${l.partyId}` : "", description: l.description ?? "" }));
  const rows: Row[] | null = o ? (edit && edit.base === o ? edit.rows : fromServer(o)) : null;
  const setRows = (next: Row[] | null) => setEdit(next && o ? { base: o, rows: next } : null);
  const locked = !!o?.posted || !can;
  const acc = new Map((dims.data?.accounts ?? []).map((a) => [a.id, a]));
  const set = (i: number, patch: Partial<Row>) => setRows((rows ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function saveGrid() {
    const lines = (rows ?? []).filter((r) => r.accountId).map((r) => { const [pt, pid] = r.party ? r.party.split(":") : [null, null]; return { accountId: r.accountId, debit: r.debit || null, credit: r.credit || null, partyType: pt, partyId: pid, description: r.description || null }; });
    const res = await w.run<Opening>("save", "/api/accounting/opening", "PUT", { lines }, L("حُفظ الجدول.", "The grid is saved."));
    if (res) { setRows(null); op.reload(); }
  }
  async function importCsv(apply: boolean) {
    const res = await w.run<{ applied: boolean; lines: unknown[]; problems: { row: number; en: string; ar: string }[] }>("csv", "/api/accounting/opening/import", "POST", { csv, apply }, apply ? L("استُورد الملف إلى الجدول.", "Imported into the grid.") : undefined);
    if (res) {
      if (res.applied) { setPreview(null); setCsv(""); setRows(null); op.reload(); } else setPreview({ lines: res.lines ?? [], problems: res.problems ?? [] });
    }
  }
  async function post() {
    const res = await w.run("post", "/api/accounting/opening/post", "POST", {}, L("رُحّلت الأرصدة الافتتاحية.", "The opening balances are posted."));
    if (res) { setConfirm(false); op.reload(); setup.reload(); }
  }
  const name = (a: { nameAr: string | null; nameEn: string }) => L(a.nameAr ?? a.nameEn, a.nameEn);

  return (
    <AcctShell setup={setup.data}
      meta={o ? <span className="acct-meta">{L("بتاريخ البدء", "At the go-live date")} <span className="hr-num">{o.goLiveDate ?? "—"}</span> · {o.posted ? <span className="acct-pill is-on">{L("مرحّلة", "Posted")}</span> : <span className="acct-pill is-off">{L("لم تُرحَّل", "Not posted")}</span>}</span> : undefined}
      actions={o && !o.posted && can ? <Btn variant="primary" disabled={!o.active || !o.lines.length} onClick={() => setConfirm(true)} data-testid="opening-post">{L("ترحيل الأرصدة الافتتاحية", "Post the opening balances")}</Btn> : undefined}>
      <Msg error={w.error ?? op.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!o || rows === null ? <OpsLoading /> : (
        <>
          {!o.active ? <p className="acct-hint">{L("فعّل المحاسبة بتاريخ البدء أولًا (الإعدادات)؛ يمكنك تجهيز الجدول الآن.", "Activate accounting with its go-live date first (Settings); you may prepare the grid now.")}</p> : null}
          <section className="acct-card">
            <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
              <h2>{L("ميزان المراجعة الافتتاحي", "Opening trial balance")}</h2>
              <span className="hr-num acct-hint" data-testid="opening-totals">{L("مدين", "Debit")} {money(o.totals.debit)} · {L("دائن", "Credit")} {money(o.totals.credit)} · {L("الفرق إلى حقوق الملكية الافتتاحية", "Difference to opening equity")} {money(o.totals.difference)}{o.equityAccount ? ` (${o.equityAccount.code})` : ""}</span>
            </div>
            <div className="hr-tablewrap">
              <table className="hr-table acct-lines" data-testid="opening-grid">
                <thead><tr><th>{L("الحساب", "Account")}</th><th>{L("العميل / المورد", "Customer / supplier")}</th><th className="acct-hide-m">{L("الوصف", "Description")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th>{locked ? null : <th />}</tr></thead>
                <tbody>
                  {rows.map((r, i) => {
                    const a = acc.get(r.accountId);
                    const party = a?.controlType === "AR" ? "CUSTOMER" : a?.controlType === "AP" ? "SUPPLIER" : null;
                    return (
                      <tr key={i}>
                        <td style={{ minWidth: 220 }}>{locked ? <>{a ? `${a.code} · ${name(a)}` : r.accountId}</> : (
                          <Select value={r.accountId} onChange={(e) => set(i, { accountId: e.target.value, party: "" })} aria-label={L("الحساب", "Account")} placeholder={L("اختر الحساب", "Choose the account")}>
                            <option value="">{L("اختر الحساب", "Choose the account")}</option>
                            {(dims.data?.accounts ?? []).map((x) => <option key={x.id} value={x.id}>{`${x.code} · ${name(x)}`}</option>)}
                          </Select>)}</td>
                        <td>{party && !locked ? (
                          <Select value={r.party} onChange={(e) => set(i, { party: e.target.value })} aria-label={L("الطرف", "Party")} placeholder="—">
                            <option value="">—</option>
                            {(party === "CUSTOMER" ? dims.data?.customers ?? [] : dims.data?.suppliers ?? []).map((p) => <option key={p.id} value={`${party}:${p.id}`}>{p.name}</option>)}
                          </Select>) : r.party ? <span className="acct-hint">{partyName(r.party)}</span> : "—"}</td>
                        <td className="acct-hide-m">{locked ? r.description : <input className="hr-input" value={r.description} onChange={(e) => set(i, { description: e.target.value })} aria-label={L("الوصف", "Description")} />}</td>
                        <td>{locked ? <span className="hr-num">{money(r.debit, true)}</span> : <input className="hr-input acct-amount" dir="ltr" inputMode="decimal" value={r.debit} onChange={(e) => set(i, { debit: e.target.value.replace(/[^\d.]/g, ""), ...(e.target.value ? { credit: "" } : {}) })} aria-label={L("مدين", "Debit")} />}</td>
                        <td>{locked ? <span className="hr-num">{money(r.credit, true)}</span> : <input className="hr-input acct-amount" dir="ltr" inputMode="decimal" value={r.credit} onChange={(e) => set(i, { credit: e.target.value.replace(/[^\d.]/g, ""), ...(e.target.value ? { debit: "" } : {}) })} aria-label={L("دائن", "Credit")} />}</td>
                        {locked ? null : <td><button type="button" className="hr-btn is-ghost hr-iconbtn" aria-label={L("حذف السطر", "Remove line")} onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button></td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {locked ? null : (
              <div className="acct-foot" style={{ borderTop: 0 }}>
                <button type="button" className="hr-btn is-ghost" onClick={() => setRows([...rows, { accountId: "", debit: "", credit: "", party: "", description: "" }])} data-testid="opening-add">+ {L("إضافة سطر", "Add line")}</button>
                <Btn variant="primary" busy={w.busy === "save"} onClick={saveGrid} data-testid="opening-save">{L("حفظ الجدول", "Save the grid")}</Btn>
              </div>
            )}
          </section>
          {locked ? null : (
            <section className="acct-card">
              <h2>{L("استيراد من CSV", "Import from CSV")}</h2>
              <p className="acct-hint">{L("الأعمدة: account_code, debit, credit, party_type (CUSTOMER / SUPPLIER / EMPLOYEE), party (الاسم أو المعرّف), branch_code, description. يُعرض الملف أولًا ثم يستبدل الجدول.", "Columns: account_code, debit, credit, party_type (CUSTOMER / SUPPLIER / EMPLOYEE), party (name or id), branch_code, description. It previews first, then replaces the grid.")}</p>
              <pre className="acct-csv">{SAMPLE}</pre>
              <Field label="CSV"><textarea className="hr-input hr-textarea" dir="ltr" rows={6} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} data-testid="opening-csv" /></Field>
              <span className="acct-actions">
                <Btn busy={w.busy === "csv"} disabled={!csv.trim()} onClick={() => importCsv(false)} data-testid="opening-csv-preview">{L("معاينة", "Preview")}</Btn>
                {preview && preview.problems.length === 0 ? <Btn variant="primary" onClick={() => importCsv(true)} data-testid="opening-csv-apply">{L(`استيراد ${preview.lines.length} سطرًا`, `Import ${preview.lines.length} lines`)}</Btn> : null}
              </span>
              {preview?.problems.length ? <ul className="hr-err" data-testid="opening-csv-problems">{preview.problems.map((p, i) => <li key={i}>{L("السطر", "Row")} {p.row}: {L(p.ar, p.en)}</li>)}</ul> : null}
            </section>
          )}
          <p className="acct-hint">{L("أرصدة الذمم تُدخل لكل عميل ومورد على حدة: هي بداية الدفاتر الفرعية. يُرحَّل القيد الافتتاحي مرة واحدة بتاريخ البدء، والفرق إلى «حقوق ملكية الأرصدة الافتتاحية»؛ بعده يصبح الجدول نهائيًا ويُصحَّح أي خطأ بقيد تسوية.", "Receivable and payable balances are entered per customer and supplier: they open the sub-ledgers. The opening entry posts once at the go-live date, the difference to opening balance equity; then the grid is final and an error is corrected by an adjusting journal.")}</p>
        </>
      )}
      <Dialog open={confirm} title={L("ترحيل الأرصدة الافتتاحية", "Post the opening balances")} onClose={() => setConfirm(false)}
        sub={o ? L(`بتاريخ ${o.goLiveDate} · مدين ${money(o.totals.debit)} · دائن ${money(o.totals.credit)} · الفرق ${money(o.totals.difference)} إلى حقوق ملكية الأرصدة الافتتاحية`, `On ${o.goLiveDate} · debit ${money(o.totals.debit)} · credit ${money(o.totals.credit)} · difference ${money(o.totals.difference)} to opening balance equity`) : undefined}
        actions={<><Btn variant="primary" busy={w.busy === "post"} onClick={post} data-testid="opening-post-confirm">{L("ترحيل", "Post")}</Btn><Btn onClick={() => setConfirm(false)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <p>{L("يُرحَّل مرة واحدة ولا يُعدَّل بعده.", "It posts once and never changes after.")}</p>
      </Dialog>
    </AcctShell>
  );
}
