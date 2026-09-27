"use client";

import { useState } from "react";
import { Button, Dialog, Field, INPUT, Notice, api, useL, withBranch } from "../_components/ui";

type Account = { id: string; code: string; nameEn: string; nameAr: string | null; type?: string; isRestricted?: boolean; branchKey?: string };
type Preview = {
  header: string[]; rowCount: number;
  summary: { new: number; duplicate: number; flagged: number; existing: number; errors: number };
  rows: { rowNo: number; txnDate: string; amount: number; status: string; flaggedReason?: string; description: string | null }[];
  errors: { rowNo: number; field: string; message: string; raw: string }[];
};

/** Header only — the server does the real parsing, validation and duplicate detection. */
function firstLine(text: string): string[] {
  const line = text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  const d = [",", ";", "\t", "|"].map((c) => [c, line.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  return line.split(d).map((s) => s.replace(/^"|"$/g, "").trim()).filter(Boolean);
}
const FIELD: Record<string, [string, string]> = { date: ["التاريخ", "Date"], amount: ["المبلغ", "Amount"], account: ["الحساب", "Account"] };
const guess = (h: string[], words: string[]) => h.find((x) => words.some((w) => x.toLowerCase().includes(w))) ?? "";

type Props = { open: boolean; onClose: () => void; accounts: Account[]; onDone: () => void; branch: string };

/** Mounted only while open, so every opening starts from a clean form. */
export function ImportDialog(props: Props) {
  return props.open ? <ImportDialogBody {...props} /> : null;
}

function ImportDialogBody({ open, onClose, accounts, onDone, branch }: Props) {
  const { L, name } = useL();
  const [accountPick, setAccountId] = useState("");
  const accountId = accountPick || (accounts.find((a) => a.type === "BANK" && !a.isRestricted && a.branchKey === "COMPANY") ?? accounts.find((a) => a.type === "BANK" && !a.isRestricted) ?? accounts[0])?.id || "";
  const [fileName, setFileName] = useState(""); const [csv, setCsv] = useState("");
  const [header, setHeader] = useState<string[]>([]);
  const [map, setMap] = useState({ date: "", amount: "", debit: "", credit: "", reference: "", description: "", account: "" });
  const [fmt, setFmt] = useState("YYYY-MM-DD");
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null);

  async function onFile(f: File) {
    const text = await f.text();
    setFileName(f.name); setCsv(text); setPreview(null); setDone(null);
    const h = firstLine(text); setHeader(h);
    setMap({
      date: guess(h, ["date", "تاريخ"]), amount: guess(h, ["amount", "مبلغ"]), debit: guess(h, ["debit", "مدين"]), credit: guess(h, ["credit", "دائن"]),
      reference: guess(h, ["ref", "مرجع"]), description: guess(h, ["desc", "narr", "وصف", "بيان"]), account: "",
    });
  }
  const body = () => ({
    cashAccountId: accountId, csv, fileName, importAsPending: pending,
    mapping: { ...(map.amount ? { amount: map.amount } : { debit: map.debit, credit: map.credit }), date: map.date, reference: map.reference || undefined, description: map.description || undefined, account: map.account || undefined, dateFormat: fmt, hasHeader: true },
  });
  async function doPreview() {
    setBusy(true); setErr(null);
    try { setPreview(await api<Preview>(withBranch("/api/finance/imports/preview", branch), { method: "POST", json: body() })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function commit() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ importedCount: number; attachedCount: number; duplicateCount: number; flaggedCount: number; errorCount: number }>(withBranch("/api/finance/imports", branch), { method: "POST", json: body() });
      setDone(L(`استُورد ${r.importedCount} سطراً · أكّد ${r.attachedCount} سطراً مسجّلاً · تُجوهل ${r.duplicateCount} مكرراً · ${r.flaggedCount} للمراجعة · ${r.errorCount} أخطاء`, `Imported ${r.importedCount} · confirmed ${r.attachedCount} recorded lines · skipped ${r.duplicateCount} duplicates · ${r.flaggedCount} flagged · ${r.errorCount} errors`));
      setPreview(null); onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const col = (k: keyof typeof map, label: string) => (
    <Field label={label}>
      <select className={INPUT} value={map[k]} onChange={(e) => setMap({ ...map, [k]: e.target.value })}>
        <option value="">—</option>{header.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </Field>
  );
  const rowError = (e: { field: string; message: string }) => {
    if (e.field === "date") return /not found/i.test(e.message) ? L("عمود التاريخ غير موجود", e.message) : L(`تاريخ غير صالح للصيغة ${fmt}`, e.message);
    if (e.field === "amount") return /both a debit/i.test(e.message) ? L("السطر يحوي مديناً ودائناً معاً", e.message) : /Zero/i.test(e.message) ? L("مبلغ صفري", e.message) : /Map either/i.test(e.message) ? L("اربط عمود مبلغ موقّع أو عمودي المدين والدائن", e.message) : L("ليس مبلغاً صالحاً (خانتان عشريتان كحد أقصى)", e.message);
    if (e.field === "account") return L("الحساب غير معروف أو خارج فروعك", e.message);
    return e.message;
  };
  const importable = preview ? preview.summary.new + preview.summary.flagged + preview.summary.existing : 0;
  return (
    <Dialog open={open} onClose={onClose} width="max-w-[760px]" title={L("استيراد كشف بنكي (CSV)", "Import bank statement (CSV)")} sub={L("معاينة قبل الحفظ · لا يُرفض سطر لمجرد تطابق التاريخ والمبلغ", "Preview before saving · no line is rejected just because its date and amount match")}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label={L("الحساب", "Account")}><select className={INPUT} value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {name(a)}</option>)}</select></Field>
        <Field label={L("الملف", "File")}><input type="file" accept=".csv,text/csv" className={`${INPUT} !py-1.5`} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} /></Field>
        <Field label={L("صيغة التاريخ", "Date format")}><select className={INPUT} value={fmt} onChange={(e) => setFmt(e.target.value)}><option>YYYY-MM-DD</option><option>DD/MM/YYYY</option><option>MM/DD/YYYY</option></select></Field>
      </div>
      {header.length > 0 && (
        <>
          <h3 className="text-[13px] font-extrabold">{L("ربط الأعمدة", "Column mapping")}</h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {col("date", L("التاريخ", "Date"))}
            {col("amount", L("المبلغ (موجب/سالب)", "Amount (signed)"))}
            {col("reference", L("المرجع", "Reference"))}
            {col("description", L("الوصف", "Description"))}
            {col("account", L("الحساب (اختياري)", "Account (optional)"))}
          </div>
          {!map.amount && <div className="grid grid-cols-2 gap-3">{col("debit", L("عمود المدين", "Debit column"))}{col("credit", L("عمود الدائن", "Credit column"))}</div>}
        </>
      )}
      {preview && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[[L("جديد", "New"), preview.summary.new, "bg-green-100"], [L("يؤكد سطراً مسجّلاً", "Confirms a recorded line"), preview.summary.existing, "bg-orange-light"], [L("مكرر (يُتجاهل)", "Duplicate (skipped)"), preview.summary.duplicate, "bg-cream-dark"], [L("للمراجعة (تطابق محتمل)", "To review (possible match)"), preview.summary.flagged, "bg-amber-100"], [L("أخطاء", "Errors"), preview.summary.errors, "bg-red-100"]].map(([l, v, c]) => (
              <div key={String(l)} className={`rounded-[10px] px-3 py-2.5 ${c}`}><p className="text-[11px] font-bold text-brown">{l}</p><p className="text-lg font-extrabold tabular-nums">{v}</p></div>
            ))}
          </div>
          {preview.errors.length > 0 && (
            <div className="rounded-[10px] bg-red-100 p-3 flex flex-col gap-1.5 max-h-40 overflow-y-auto">
              <p className="text-xs font-extrabold text-red-600">{L("تقرير الأخطاء", "Error report")}</p>
              {preview.errors.map((e, i) => <p key={i} className="text-xs text-red-600">{e.rowNo ? L(`السطر ${e.rowNo}`, `Row ${e.rowNo}`) : L("الربط", "Mapping")} · {FIELD[e.field] ? L(FIELD[e.field][0], FIELD[e.field][1]) : e.field}: «{e.raw}» — {rowError(e)}</p>)}
            </div>
          )}
          {preview.rows.filter((r) => r.status === "FLAGGED").length > 0 && (
            <div className="rounded-[10px] bg-amber-100 p-3 flex flex-col gap-1 max-h-32 overflow-y-auto">
              {preview.rows.filter((r) => r.status === "FLAGGED").map((r) => <p key={r.rowNo} className="text-xs text-amber-700">{L(`السطر ${r.rowNo}`, `Row ${r.rowNo}`)} · {r.txnDate} · {r.description}: {r.flaggedReason}</p>)}
            </div>
          )}
        </>
      )}
      {err && <Notice tone="bad">{err}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      <div className="flex items-center gap-2 flex-wrap">
        {!preview ? <Button kind="primary" busy={busy} disabled={!csv || !map.date || (!map.amount && !(map.debit && map.credit))} onClick={doPreview}>{L("معاينة", "Preview")}</Button>
          : <Button kind="primary" busy={busy} disabled={importable === 0} onClick={commit}>{L(`استيراد ${importable} سطراً`, `Import ${importable} lines`)}</Button>}
        <Button onClick={onClose}>{L("إغلاق", "Close")}</Button>
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} />{L("استيراد كمعلّق", "Import as pending")}</label>
      </div>
      <p className="text-xs text-brown">{L("تُدخل الأسطر الجديدة والمحتملة التكرار إلى قائمة المراجعة ولا تُخصص قبل تصنيفها. السطر الذي يطابق دفعة أو إيصالاً مسجّلاً مسبقاً (المبلغ نفسه والمرجع نفسه، أو خلال 3 أيام قبل و7 بعد) يؤكّده ولا يُنشئ سطراً ثانياً.", "New and possibly duplicate lines enter the review queue and are not allocated before they are classified. A line that matches a payment or receipt already recorded (same amount and reference, or within 3 days before / 7 after) confirms it instead of creating a second line.")}</p>
    </Dialog>
  );
}
