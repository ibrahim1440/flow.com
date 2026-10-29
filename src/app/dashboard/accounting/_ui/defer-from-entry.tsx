"use client";

// «حفظ مع التأجيل» — the second half (batch 22 WP-J, QOYOD-REF §8.9). The deferrals service links a schedule to a POSTED
// journal line only (council F1: the amount must already sit on the balance-sheet account, and a line's schedules never
// exceed it), so the schedule is made here, on the entry page, once the entry is posted — prefilled from what the editor
// asked for (the URL, or this device's note), and offered for any posted manual entry with a line on a deferral
// template's balance-sheet account that no live schedule uses yet. Creating goes through the existing
// POST /api/accounting/deferrals/schedules (sourceType JOURNAL_LINE): every rule of the service applies.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { Btn } from "@/components/ops/ui";
import { Msg, money, useApi, useLang, useWrite } from "./shell";
import { deferKey, type DeferIntent } from "./journal-editor";

type Line = { id: string; lineNo: number | null; debit: string; credit: string; account: { id: string; code: string; nameAr: string | null; nameEn: string } };
type Entry = { id: string; status: string; entryDate: string; description: string | null; lines: Line[] };
type Template = { id: string; nameAr: string; nameEn: string | null; kind: string; months: number; isActive: boolean; balanceAccount: { id: string; code: string } | null };
type Schedule = { id: string; number: string; sourceType: string; sourceId: string | null; status: string; totalAmount: string };

export function DeferFromEntry({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const { L } = useLang();
  const q = useSearchParams();
  const tpls = useApi<{ templates: Template[] }>("/api/accounting/deferrals/templates?active=1");
  const sch = useApi<{ rows?: Schedule[]; items?: Schedule[] }>("/api/accounting/deferrals/schedules?take=200");
  const w = useWrite();
  const [intent, setIntent] = useState<DeferIntent | null>(null);
  useEffect(() => {
    const fromUrl = q?.get("defer") ? { templateId: q.get("defer") as string, lineNo: Number(q.get("line") ?? 0), startDate: q.get("start") ?? entry.entryDate, description: entry.description ?? "" } : null;
    let stored: DeferIntent | null = null;
    try { const raw = localStorage.getItem(deferKey(entry.id)); stored = raw ? (JSON.parse(raw) as DeferIntent) : null; } catch { stored = null; }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the URL / this device's note
    setIntent(fromUrl ?? stored);
  }, [q, entry.id, entry.entryDate, entry.description]);
  const [form, setForm] = useState<{ templateId: string; lineId: string; startDate: string; description: string } | null>(null);

  const schedules = useMemo(() => (sch.data?.rows ?? sch.data?.items ?? []), [sch.data]);
  const linked = schedules.filter((s) => s.sourceType === "JOURNAL_LINE" && entry.lines.some((l) => l.id === s.sourceId) && s.status !== "CANCELLED");
  const templates = (tpls.data?.templates ?? []).filter((t) => t.isActive && t.balanceAccount);
  const lineNo = (l: Line, i: number) => l.lineNo ?? i + 1;
  const candidates = entry.lines.map((l, i) => ({ l, n: lineNo(l, i) })).filter(({ l }) => templates.some((t) => t.balanceAccount!.id === l.account.id) && !linked.some((s) => s.sourceId === l.id));

  useEffect(() => {
    if (form || !tpls.data || entry.status !== "POSTED") return;
    const t = intent ? templates.find((x) => x.id === intent.templateId) : null;
    const c = intent ? candidates.find((x) => x.n === intent.lineNo) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the form is prefilled once the data is in
    if (t && c) setForm({ templateId: t.id, lineId: c.l.id, startDate: intent!.startDate, description: intent!.description || entry.description || "" });
  }, [form, tpls.data, intent, entry.status, entry.description, templates, candidates]);

  if (!tpls.data || !sch.data) return null;
  if (entry.status === "REVERSED") return null;
  const forget = () => { try { localStorage.removeItem(deferKey(entry.id)); } catch { /* nothing kept */ } setIntent(null); };
  const tplName = (id: string) => { const t = templates.find((x) => x.id === id); return t ? L(t.nameAr, t.nameEn ?? t.nameAr) : id; };

  if (entry.status !== "POSTED") {
    if (!intent) return null;
    return (
      <section className="acct-card" data-testid="je-defer-pending">
        <h3>{L("تأجيل بانتظار الترحيل", "Deferral waiting for posting")}</h3>
        <p>{L(`يُنشأ جدول التأجيل «${tplName(intent.templateId)}» من السطر #${intent.lineNo} بنقرة واحدة هنا بعد اعتماد القيد وترحيله (الجدول يرتبط بسطر قيد مرحّل فقط).`, `The deferral schedule «${tplName(intent.templateId)}» is made from line #${intent.lineNo} in one click here once the entry is approved and posted (a schedule links to a posted journal line only).`)}</p>
        <span className="acct-actions"><Btn variant="ghost" size="sm" onClick={forget}>{L("تجاهل التأجيل", "Drop the deferral")}</Btn></span>
      </section>
    );
  }
  if (!linked.length && !candidates.length) return null;

  async function create() {
    if (!form) return;
    const l = entry.lines.find((x) => x.id === form.lineId);
    if (!l) return;
    const amount = Number(l.debit) > 0 ? l.debit : l.credit;
    const r = await w.run("create", "/api/accounting/deferrals/schedules", "POST", { templateId: form.templateId, amount, startDate: form.startDate, description: form.description, sourceType: "JOURNAL_LINE", sourceId: l.id }, L("أُنشئ جدول التأجيل من سطر القيد.", "The deferral schedule is made from the journal line."));
    if (r) { forget(); setForm(null); sch.reload(); onDone(); }
  }
  const lineTpls = form ? templates.filter((t) => t.balanceAccount!.id === entry.lines.find((l) => l.id === form.lineId)?.account.id) : [];
  return (
    <section className="acct-card" data-testid="je-defer">
      <h3>{L("التأجيل من هذا القيد", "Deferral from this entry")}</h3>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {linked.length ? <p>{L("جداول التأجيل المرتبطة:", "Linked deferral schedules:")} {linked.map((s) => <Link key={s.id} className="acct-code" style={{ marginInlineEnd: 8 }} href="/dashboard/accounting/deferrals" data-testid="je-defer-linked">{s.number}</Link>)}</p> : null}
      {candidates.length ? (form ? (
        <>
          <div className="acct-row">
            <label className="hr-field"><span className="hr-label">{L("السطر", "Line")}</span>
              <Select value={form.lineId} onChange={(e) => setForm({ ...form, lineId: e.target.value, templateId: "" })} aria-label={L("السطر", "Line")} data-testid="je-defer-create-line">
                {candidates.map(({ l, n }) => <option key={l.id} value={l.id}>{`#${n} · ${l.account.code} · ${money(Number(l.debit) > 0 ? l.debit : l.credit)}`}</option>)}
              </Select></label>
            <label className="hr-field"><span className="hr-label">{L("قالب التأجيل", "Deferral template")}</span>
              <Select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} aria-label={L("قالب التأجيل", "Deferral template")} data-testid="je-defer-create-template">
                <option value="">{L("اختر القالب", "Choose the template")}</option>
                {lineTpls.map((t) => <option key={t.id} value={t.id}>{`${L(t.nameAr, t.nameEn ?? t.nameAr)} · ${t.months} ${L("شهر", "months")}`}</option>)}
              </Select></label>
            <label className="hr-field"><span className="hr-label">{L("بداية التأجيل", "Deferral start")}</span>
              <input type="date" className="hr-input" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></label>
            <label className="hr-field acct-grow"><span className="hr-label">{L("الوصف", "Description")}</span>
              <input className="hr-input" maxLength={300} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} data-testid="je-defer-create-desc" /></label>
          </div>
          <span className="acct-actions">
            <Btn variant="primary" disabled={!form.templateId || !form.description.trim()} busy={w.busy === "create"} onClick={create} data-testid="je-defer-create">{L("إنشاء جدول التأجيل", "Create the deferral schedule")}</Btn>
            <Btn variant="ghost" onClick={() => setForm(null)}>{L("رجوع", "Back")}</Btn>
          </span>
        </>
      ) : (
        <span className="acct-actions"><Btn onClick={() => setForm({ templateId: templates.find((t) => t.balanceAccount!.id === candidates[0].l.account.id)?.id ?? "", lineId: candidates[0].l.id, startDate: entry.entryDate, description: entry.description ?? "" })} data-testid="je-defer-open">{L("إنشاء جدول تأجيل من هذا القيد", "Make a deferral schedule from this entry")}</Btn></span>
      )) : null}
    </section>
  );
}
