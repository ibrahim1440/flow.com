"use client";

// Figma: ACC-03. Manual journal editor for a new entry or a draft. Totals are integer
// halalas (parseMoney), so the balance shown is exact; the server re-validates everything.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { riyadhToday } from "./kit";
import { Plus, X, AlertTriangle } from "lucide-react";
import { parseMoney } from "@/lib/finance/money";
import { ApiError, Button, Card, CardTitle, Field, INPUT, Notice, Table, Td, Th, api, useL } from "../../finance/_components/ui";

type Account = { id: string; code: string; nameEn: string; nameAr: string | null; allowPosting: boolean; isActive: boolean; controlKind: string; allowManualPosting: boolean; parentId: string | null };
type Dim = { id: string; code: string; nameEn: string; nameAr: string | null };
export type EditorLine = { accountId: string; description: string; debit: string; credit: string; branchId: string; costCenterId: string };
export type EditorValue = { entryDate: string; type: "MANUAL" | "ADJUSTMENT" | "OPENING"; description: string; lines: EditorLine[] };

const blank = (): EditorLine => ({ accountId: "", description: "", debit: "", credit: "", branchId: "", costCenterId: "" });

export function JournalEditor({ initial, entryId, onSaved }: { initial?: EditorValue; entryId?: string; onSaved: (id: string, submitted: boolean) => void }) {
  const { L, money, name } = useL();
  const [v, setV] = useState<EditorValue>(() => initial ?? { entryDate: riyadhToday(), type: "MANUAL", description: "", lines: [blank(), blank()] });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [dims, setDims] = useState<{ branches: Dim[]; costCenters: Dim[] }>({ branches: [], costCenters: [] });
  const [busy, setBusy] = useState<null | "draft" | "submit">(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    api<Account[]>("/api/accounting/coa").then(setAccounts).catch(() => setAccounts([]));
    api<{ branches: Dim[]; costCenters: Dim[] }>("/api/accounting/dimensions").then(setDims).catch(() => {});
  }, []);
  const parents = useMemo(() => new Set(accounts.map((a) => a.parentId).filter(Boolean)), [accounts]);
  // Control accounts closed to manual posting are not offered at all (ACC-03 note).
  const postable = accounts.filter((a) => a.isActive && a.allowPosting && !parents.has(a.id) && (a.controlKind === "NONE" || a.allowManualPosting));

  const parsed = v.lines.map((l) => ({ d: l.debit.trim() ? parseMoney(l.debit) : 0, c: l.credit.trim() ? parseMoney(l.credit) : 0 }));
  const lineErrors = v.lines.map((l, i) => {
    const p = parsed[i];
    if (p.d === null || p.c === null) return L("مبلغ غير صالح (خانتان عشريتان كحد أقصى)", "Invalid amount (at most two decimals)");
    if ((p.d ?? 0) < 0 || (p.c ?? 0) < 0) return L("لا مبالغ سالبة", "No negative amounts");
    if (!l.accountId && (p.d || p.c)) return L("اختر الحساب", "Choose an account");
    if (l.accountId && ((p.d! > 0) === (p.c! > 0))) return L("مدين أو دائن — واحد فقط", "Debit or credit — exactly one");
    return null;
  });
  const totalD = parsed.reduce((s, p) => s + (p.d ?? 0), 0);
  const totalC = parsed.reduce((s, p) => s + (p.c ?? 0), 0);
  const used = v.lines.filter((l) => l.accountId);
  const balanced = totalD === totalC && totalD > 0;
  const valid = balanced && used.length >= 2 && lineErrors.every((e) => !e);

  const set = (i: number, patch: Partial<EditorLine>) => setV((s) => ({ ...s, lines: s.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const save = async (submit: boolean) => {
    setTouched(true);
    if (!valid) return;
    setBusy(submit ? "submit" : "draft"); setError(null);
    try {
      const body = { ...v, lines: used.map((l) => ({ ...l, debit: l.debit || "0", credit: l.credit || "0", branchId: l.branchId || null, costCenterId: l.costCenterId || null })) };
      const saved = entryId
        ? await api<{ id: string }>(`/api/accounting/journals/${entryId}`, { method: "PUT", json: body })
        : await api<{ id: string }>("/api/accounting/journals", { method: "POST", json: body });
      if (submit) await api(`/api/accounting/journals/${saved.id}/submit`, { method: "POST", json: {} });
      onSaved(saved.id, submit);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(null); }
  };

  return (
    <Card>
      <CardTitle title={entryId ? L("تعديل المسودة", "Edit draft") : L("قيد يومية جديد", "New journal entry")} sub={L("يُحفظ كمسودة · يعتمده شخص آخر قبل الترحيل · خانتان عشريتان كحد أقصى", "Saved as a draft · approved by someone else before posting · at most two decimals")} />
      <div className="grid gap-3 grid-cols-1 md:grid-cols-[150px_150px_1fr]">
        <Field label={L("تاريخ القيد", "Entry date")}><input type="date" className={INPUT} value={v.entryDate} onChange={(e) => setV({ ...v, entryDate: e.target.value })} required /></Field>
        <Field label={L("النوع", "Type")}>
          <select className={INPUT} value={v.type} onChange={(e) => setV({ ...v, type: e.target.value as EditorValue["type"] })} disabled={!!entryId}>
            <option value="MANUAL">{L("يدوي", "Manual")}</option><option value="ADJUSTMENT">{L("تسوية", "Adjustment")}</option><option value="OPENING">{L("افتتاحي", "Opening")}</option>
          </select>
        </Field>
        <Field label={L("الوصف", "Description")}><input className={INPUT} maxLength={500} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
      </div>
      <Table>
        <thead><tr><Th>#</Th><Th>{L("الحساب", "Account")}</Th><Th>{L("الوصف", "Description")}</Th><Th>{L("الفرع", "Branch")}</Th><Th>{L("مركز التكلفة", "Cost centre")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th><Th></Th></tr></thead>
        <tbody>
          {v.lines.map((l, i) => (
            <tr key={i} className="align-top">
              <Td className="text-brown">{i + 1}</Td>
              <Td className="min-w-[240px]">
                <select aria-label={L(`حساب السطر ${i + 1}`, `Line ${i + 1} account`)} className={INPUT} value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })}>
                  <option value="">{L("اختر حساباً…", "Choose an account…")}</option>
                  {postable.map((a) => <option key={a.id} value={a.id}>{a.code} · {name(a)}</option>)}
                </select>
                {touched && lineErrors[i] && <span role="alert" className="block text-[11px] text-red-700 mt-1">{lineErrors[i]}</span>}
              </Td>
              <Td className="min-w-[160px]"><input aria-label={L(`وصف السطر ${i + 1}`, `Line ${i + 1} description`)} className={INPUT} value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></Td>
              <Td className="min-w-[120px]"><select aria-label={L(`فرع السطر ${i + 1}`, `Line ${i + 1} branch`)} className={INPUT} value={l.branchId} onChange={(e) => set(i, { branchId: e.target.value })}><option value="">—</option>{dims.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</select></Td>
              <Td className="min-w-[120px]"><select aria-label={L(`مركز تكلفة السطر ${i + 1}`, `Line ${i + 1} cost centre`)} className={INPUT} value={l.costCenterId} onChange={(e) => set(i, { costCenterId: e.target.value })}><option value="">—</option>{dims.costCenters.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</select></Td>
              <Td num className="min-w-[120px]"><input inputMode="decimal" dir="ltr" aria-label={L(`مدين السطر ${i + 1}`, `Line ${i + 1} debit`)} className={`${INPUT} text-end ${touched && parsed[i].d === null ? "border-red-300" : ""}`} value={l.debit} onChange={(e) => set(i, { debit: e.target.value, ...(e.target.value ? { credit: "" } : {}) })} /></Td>
              <Td num className="min-w-[120px]"><input inputMode="decimal" dir="ltr" aria-label={L(`دائن السطر ${i + 1}`, `Line ${i + 1} credit`)} className={`${INPUT} text-end ${touched && parsed[i].c === null ? "border-red-300" : ""}`} value={l.credit} onChange={(e) => set(i, { credit: e.target.value, ...(e.target.value ? { debit: "" } : {}) })} /></Td>
              <Td><button type="button" aria-label={L(`حذف السطر ${i + 1}`, `Remove line ${i + 1}`)} disabled={v.lines.length <= 2} onClick={() => setV({ ...v, lines: v.lines.filter((_, j) => j !== i) })} className="p-2 text-brown hover:text-red-700 disabled:opacity-30"><X size={16} /></button></Td>
            </tr>
          ))}
          <tr className="bg-cream-dark font-bold">
            <Td></Td><Td>{L("المجموع", "Total")}</Td><Td></Td><Td></Td><Td></Td>
            <Td num>{money(totalD)}</Td><Td num className={balanced || !touched ? "" : "text-red-700"}>{money(totalC)}</Td><Td></Td>
          </tr>
        </tbody>
      </Table>
      <div><Button kind="ghost" icon={Plus} onClick={() => setV({ ...v, lines: [...v.lines, blank()] })} disabled={v.lines.length >= 500}>{L("سطر", "Line")}</Button></div>
      {touched && !balanced && totalD + totalC > 0 && (
        <div role="alert" className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl bg-red-50 border border-red-200 text-[13px] font-bold text-red-700">
          <AlertTriangle size={16} />
          {L(`المدين (${money(totalD)}) لا يساوي الدائن (${money(totalC)}) — الفرق ${money(Math.abs(totalD - totalC))} ر.س. لا يمكن الحفظ قبل التوازن.`, `Debits (${money(totalD)}) do not equal credits (${money(totalC)}) — difference ${money(Math.abs(totalD - totalC))} SAR. It cannot be saved until it balances.`)}
        </div>
      )}
      <Notice tone="info">{L("حسابات المراقبة (الذمم، المخزون، العمولات المستحقة، الدفعات المقدمة) لا تظهر في القائمة: تُرحّل من دفاترها الفرعية فقط.", "Control accounts (receivables, inventory, commissions payable, customer advances) are not listed: they are posted from their subledgers only.")}</Notice>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="flex gap-2 justify-end flex-wrap">
        <Link href="/dashboard/accounting/journals"><Button kind="ghost">{L("إلغاء", "Cancel")}</Button></Link>
        <Button busy={busy === "draft"} disabled={!!busy} onClick={() => save(false)}>{L("حفظ كمسودة", "Save draft")}</Button>
        <Button kind="primary" busy={busy === "submit"} disabled={!!busy || (touched && !valid)} onClick={() => save(true)}>{L("حفظ وتقديم للاعتماد", "Save and submit for approval")}</Button>
      </div>
    </Card>
  );
}
