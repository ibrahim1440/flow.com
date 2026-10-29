"use client";

// «استيراد الأصول من قيود» (batch 22 WP-G) — ?view=import. Easier than retyping the register: download the template (or
// use Qoyod's export with the same headers, Arabic or English), pick the file, see every row checked at once (errors per
// row and column, warnings), type Qoyod's trial-balance totals beside the file's, import in one click — all or nothing;
// the same file again replays. Then the tie-out to the opening grid, and «تطبيق على الأرصدة الافتتاحية». Undo is offered
// only until the opening is posted.
import Link from "next/link";
import { useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Section } from "@/components/chrome";
import { Msg, money, useApi, useLang, useWrite } from "../../_ui/shell";
import { Money, type Can } from "./fa";

type Issue = { row: number; column: string | null; en: string; ar: string };
type Group = { key: string; categories: string[]; costAccount: { code: string; name: string } | null; accumAccount: { code: string; name: string } | null; cost: string; accumulated: string; rows: number; controlCost: string | null; controlAccumulated: string | null; costDiff: string | null; accumulatedDiff: string | null };
type Row = { row: number; code: string; nameAr: string; category: string | null; location: string | null; acquisitionDate: string; inServiceDate: string; cost: string; residualValue: string; usefulLifeMonths: number | null; accumulated: string; method: string; expected: string | null; ok: boolean };
type ImportRow = { id: string; fileName: string; rows: number; totalCost: string; totalAccumulated: string; createdAt: string; createdBy: string; revertedAt: string | null; assets?: number };
type Preview = { goLiveDate: string | null; valuedAt: string | null; openingPosted: boolean; ok: boolean; rows: Row[]; issues: Issue[]; warnings: Issue[]; totals: { rows: number; valid: number; cost: string; accumulated: string; netBookValue: string }; groups: Group[]; checksum: string; replayOf: ImportRow | null };
type State = {
  imports: ImportRow[]; can: Can & { import: boolean };
  tieOut: { groups: Group[]; doubleCountRisk: boolean; opening: { goLiveDate: string | null; openingPosted: boolean; inGrid: boolean; unmapped: boolean; otherGridLines: { count: number; debit: string; credit: string }; lines: unknown[] } };
};

const acc = (a: { code: string; name: string } | null, L: (a: string, b: string) => string) => (a ? <><span className="acct-code">{a.code}</span> {a.name}</> : <span className="acct-warn">{L("غير مربوط", "Not mapped")}</span>);
const Diff = ({ v }: { v: string | null }) => (v === null ? <span className="acct-hint">—</span> : Number(v) === 0 ? <span className="acct-good">✓ 0.00</span> : <span className="acct-bad">{money(v)}</span>);

export function Import() {
  const { L, ar } = useLang();
  const st = useApi<State>("/api/accounting/fixed-assets/import");
  const w = useWrite();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [p, setP] = useState<Preview | null>(null);
  const [controls, setControls] = useState<Record<string, { cost: string; accumulated: string }>>({});
  const [confirmOther, setConfirmOther] = useState(false);
  const [undoing, setUndoing] = useState<{ id: string; reason: string } | null>(null);
  const d = st.data;
  const controlList = () => Object.entries(controls).map(([key, v]) => ({ key, cost: v.cost || null, accumulated: v.accumulated || null }));

  async function preview(f = file, c = controlList()) {
    if (!f) return;
    const r = await w.run<Preview>("preview", "/api/accounting/fixed-assets/import/preview", "POST", { text: f.text, fileName: f.name, controlTotals: c });
    if (r) setP(r);
  }
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const next = { name: f.name, text };
    setFile(next); setP(null); setControls({});
    await preview(next, []);
  }
  async function commit() {
    if (!file) return;
    const r = await w.run<{ replayed: boolean; assets: number }>("commit", "/api/accounting/fixed-assets/import", "POST", { text: file.text, fileName: file.name, controlTotals: controlList() });
    if (r) {
      w.setDone(r.replayed ? L(`هذا الملف مستورد من قبل: لم يُضف شيء (${r.assets} أصل).`, `This file was imported already: nothing added (${r.assets} assets).`) : L(`استُورد ${r.assets} أصل افتتاحي.`, `${r.assets} opening assets imported.`));
      setFile(null); setP(null); st.reload();
    }
  }
  async function undo() {
    if (!undoing) return;
    const r = await w.run("undo", `/api/accounting/fixed-assets/import/${undoing.id}/undo`, "POST", { reason: undoing.reason }, L("أُلغي الاستيراد وحُذفت أصوله.", "The import is undone; its assets are removed."));
    if (r) { setUndoing(null); st.reload(); }
  }
  async function apply() {
    if (await w.run("apply", "/api/accounting/fixed-assets/opening", "POST", { confirmOtherLines: confirmOther }, L("كُتبت أسطر الأصول الثابتة في الأرصدة الافتتاحية.", "The fixed-asset lines are in the opening balances."))) st.reload();
  }

  if (!d) return st.error ? <Msg error={st.error} /> : <OpsLoading />;
  const posted = d.tieOut.opening.openingPosted;
  const byRow = new Map<number, Issue[]>();
  for (const i of p?.issues ?? []) byRow.set(i.row, [...(byRow.get(i.row) ?? []), i]);
  const fileLevel = (p?.issues ?? []).filter((i) => i.row === 0);
  return (
    <>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <Section title={L("استيراد الأصول الثابتة من قيود", "Import fixed assets from Qoyod")} testId="faimp">
        <div className="fa-body">
          <ol className="faimp-steps">
            <li>{L("نزّل القالب أو صدّر سجل الأصول من قيود بنفس العناوين (عربية أو إنجليزية).", "Download the template, or export the register from Qoyod with the same headers (Arabic or English).")} <a className="hr-btn is-sm" href="/api/accounting/fixed-assets/import/template?format=csv" download data-testid="faimp-template">{L("تنزيل القالب (CSV)", "Download the template (CSV)")}</a></li>
            <li>{L(`لكل أصل: التكلفة ومجمع الإهلاك كما في قيود في ${d.tieOut.opening.goLiveDate ? `اليوم السابق لبدء المحاسبة (${d.tieOut.opening.goLiveDate})` : "اليوم السابق لبدء المحاسبة"}، والعمر الإنتاجي الكلي بالأشهر.`, `Per asset: the cost and the accumulated depreciation as Qoyod holds them on the day before go-live${d.tieOut.opening.goLiveDate ? ` (${d.tieOut.opening.goLiveDate})` : ""}, and the total useful life in months.`)}</li>
            <li>{L("اختر الملف: يُفحص كل صف قبل أي حفظ، ويُستورد الملف كله أو لا شيء.", "Choose the file: every row is checked before anything is saved; the whole file comes in, or none of it.")}</li>
          </ol>
          {posted ? <p className="acct-hint" data-testid="faimp-final">{L("رُحّلت الأرصدة الافتتاحية: الاستيراد مغلق (افتتاحي السجل نهائي).", "The opening is posted: the import is closed (the register's opening is final).")}</p>
            : !d.can.import ? <p className="acct-hint">{L("الاستيراد يحتاج صلاحيتي «الأصول الثابتة» و«الأرصدة الافتتاحية».", "Importing needs both «Fixed assets» and «Opening balances».")}</p> : (
            <div className="acct-row">
              <Field label={L("ملف الأصول (CSV)", "Asset file (CSV)")} help={file ? file.name : L("UTF-8، صف عناوين ثم صف لكل أصل", "UTF-8, a header row then one row per asset")}>
                <input type="file" accept=".csv,text/csv" className="hr-input" onChange={pick} data-testid="faimp-file" />
              </Field>
              {file ? <Btn busy={w.busy === "preview"} onClick={() => preview()} data-testid="faimp-recheck">{L("إعادة الفحص", "Check again")}</Btn> : null}
            </div>
          )}
        </div>
      </Section>

      {p ? (
        <Section title={L("المعاينة", "Preview")} testId="faimp-preview" actions={<span className="acct-hint" style={{ color: "inherit" }}>{L(`${p.totals.valid} من ${p.totals.rows} صف صالح`, `${p.totals.valid} of ${p.totals.rows} rows valid`)}</span>}>
          <div className="fa-body">
            {p.replayOf ? <p className="acct-warn" data-testid="faimp-replay">{L(`هذا الملف نفسه مستورد في ${p.replayOf.createdAt.slice(0, 10)} (${p.replayOf.rows} أصل): الاستيراد مرة أخرى لا يضيف شيئًا.`, `This same file was imported on ${p.replayOf.createdAt.slice(0, 10)} (${p.replayOf.rows} assets): importing it again adds nothing.`)}</p> : null}
            {fileLevel.map((i, k) => <p key={k} className="acct-bad" role="alert">{ar ? i.ar : i.en}</p>)}
            <div className="acct-metrics">
              <div className="acct-metric"><span className="k">{L("التكلفة", "Cost")}</span><span className="v">{money(p.totals.cost)}</span></div>
              <div className="acct-metric"><span className="k">{L("مجمع الإهلاك", "Accumulated depreciation")}</span><span className="v">{money(p.totals.accumulated)}</span></div>
              <div className="acct-metric"><span className="k">{L("صافي القيمة الدفترية", "Net book value")}</span><span className="v">{money(p.totals.netBookValue)}</span><span className="s">{L(`ر.س · في ${p.valuedAt ?? "—"}`, `SAR · at ${p.valuedAt ?? "—"}`)}</span></div>
            </div>
            {p.rows.length ? (
              <div className="hr-tablewrap"><table className="hr-table is-dense" data-testid="faimp-rows">
                <thead><tr><th>{L("الصف", "Row")}</th><th>{L("الرمز", "Code")}</th><th>{L("الاسم", "Name")}</th><th className="acct-hide-m">{L("التصنيف", "Category")}</th><th className="acct-hide-m">{L("الموقع", "Location")}</th><th className="acct-hide-m">{L("بدء الاستخدام", "In service")}</th><th className="num">{L("التكلفة", "Cost")}</th><th className="num">{L("مجمع الإهلاك", "Accumulated")}</th><th className="num acct-hide-m">{L("حسب الجدول", "Per schedule")}</th><th>{L("الحالة", "State")}</th></tr></thead>
                <tbody>{p.rows.map((r) => (
                  <tr key={r.row} data-testid="faimp-row" className={r.ok ? undefined : "is-bad"}>
                    <td className="hr-num">{r.row}</td><td><bdi className="acct-code">{r.code}</bdi></td><td>{r.nameAr}</td><td className="acct-hide-m">{r.category ?? "—"}</td><td className="acct-hide-m">{r.location ?? "—"}</td>
                    <td className="acct-hide-m"><bdi>{r.inServiceDate}</bdi></td><td className="num"><Money v={r.cost} /></td><td className="num"><Money v={r.accumulated} /></td><td className="num acct-hide-m">{r.expected ? <Money v={r.expected} /> : "—"}</td>
                    <td>{r.ok ? <span className="acct-good">✓</span> : <span className="acct-bad">{(byRow.get(r.row) ?? []).map((i) => (ar ? i.ar : i.en)).join(" · ")}</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : null}
            {p.warnings.length ? <ul className="faimp-warn" data-testid="faimp-warnings">{p.warnings.map((i, k) => <li key={k} className="acct-warn">{i.row ? L(`الصف ${i.row}: `, `Row ${i.row}: `) : ""}{ar ? i.ar : i.en}</li>)}</ul> : null}
            {p.groups.length ? (
              <>
                <h3 className="faimp-h">{L("المطابقة مع ميزان مراجعة قيود", "Tie-out to Qoyod's trial balance")}</h3>
                <p className="acct-hint">{L("اكتب رصيد كل حساب كما في ميزان مراجعة قيود في اليوم السابق لبدء المحاسبة (اختياري): يظهر الفرق قبل الاستيراد.", "Type each account's balance from Qoyod's trial balance on the day before go-live (optional): the difference shows before you import.")}</p>
                <div className="hr-tablewrap"><table className="hr-table is-dense" data-testid="faimp-groups">
                  <thead><tr><th>{L("حساب التكلفة", "Cost account")}</th><th className="num">{L("الملف", "File")}</th><th className="num">{L("قيود", "Qoyod")}</th><th className="num">{L("الفرق", "Diff")}</th><th>{L("حساب مجمع الإهلاك", "Accumulated account")}</th><th className="num">{L("الملف", "File")}</th><th className="num">{L("قيود", "Qoyod")}</th><th className="num">{L("الفرق", "Diff")}</th></tr></thead>
                  <tbody>{p.groups.map((g) => (
                    <tr key={g.key}>
                      <td>{acc(g.costAccount, L)}<span className="acct-th-sub">{g.categories.join(" · ")}</span></td><td className="num"><Money v={g.cost} /></td>
                      <td><input className="hr-input acct-amount" inputMode="decimal" dir="ltr" aria-label={L("تكلفة قيود", "Qoyod cost")} value={controls[g.key]?.cost ?? ""} onChange={(e) => setControls({ ...controls, [g.key]: { cost: e.target.value.replace(/[^\d.]/g, ""), accumulated: controls[g.key]?.accumulated ?? "" } })} onBlur={() => preview()} data-testid="faimp-ctl-cost" /></td>
                      <td className="num"><Diff v={g.costDiff} /></td>
                      <td>{acc(g.accumAccount, L)}</td><td className="num"><Money v={g.accumulated} /></td>
                      <td><input className="hr-input acct-amount" inputMode="decimal" dir="ltr" aria-label={L("مجمع إهلاك قيود", "Qoyod accumulated")} value={controls[g.key]?.accumulated ?? ""} onChange={(e) => setControls({ ...controls, [g.key]: { accumulated: e.target.value.replace(/[^\d.]/g, ""), cost: controls[g.key]?.cost ?? "" } })} onBlur={() => preview()} data-testid="faimp-ctl-accum" /></td>
                      <td className="num"><Diff v={g.accumulatedDiff} /></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </>
            ) : null}
            <div className="acct-foot">
              <span>{p.replayOf ? <span className="acct-warn">{L("الملف نفسه مستورد: إعادة الاستيراد تعيد النتيجة نفسها ولا تضيف أصلًا.", "The same file is imported: importing it again returns the same result and adds no asset.")}</span> : p.ok ? <span className="acct-good">{L("كل الصفوف صالحة.", "Every row is valid.")}</span> : <span className="acct-bad" data-testid="faimp-blocked">{L("لن يُستورد شيء حتى تُصحَّح الصفوف المذكورة (كله أو لا شيء).", "Nothing is imported until the rows listed are fixed (all or nothing).")}</span>}</span>
              <span className="acct-actions">
                <Btn variant="ghost" onClick={() => { setFile(null); setP(null); }}>{L("إلغاء", "Cancel")}</Btn>
                <Btn variant="primary" disabled={!(p.ok || p.replayOf) || !d.can.import} busy={w.busy === "commit"} onClick={commit} data-testid="faimp-commit">{p.replayOf ? L("إعادة الاستيراد (لن يتكرر)", "Import again (nothing doubles)") : L(`استيراد ${p.totals.valid} أصل`, `Import ${p.totals.valid} assets`)}</Btn>
              </span>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title={L("المطابقة مع الأرصدة الافتتاحية", "Tie-out to the opening balances")} testId="faimp-tie">
        <div className="fa-body">
          {d.tieOut.groups.length === 0 ? <p className="acct-hint">{L("لا أصول مستوردة بعد.", "No imported assets yet.")}</p> : (
            <div className="hr-tablewrap"><table className="hr-table is-dense">
              <thead><tr><th>{L("حساب التكلفة", "Cost account")}</th><th className="num">{L("السجل", "Register")}</th><th className="num">{L("قيود", "Qoyod")}</th><th>{L("حساب مجمع الإهلاك", "Accumulated account")}</th><th className="num">{L("السجل", "Register")}</th><th className="num">{L("قيود", "Qoyod")}</th><th className="num">{L("الأصول", "Assets")}</th></tr></thead>
              <tbody>{d.tieOut.groups.map((g) => (
                <tr key={g.key}><td>{acc(g.costAccount, L)}</td><td className="num"><Money v={g.cost} /></td><td className="num">{g.controlCost ? <><Money v={g.controlCost} /> <Diff v={g.costDiff} /></> : "—"}</td>
                  <td>{acc(g.accumAccount, L)}</td><td className="num"><Money v={g.accumulated} /></td><td className="num">{g.controlAccumulated ? <><Money v={g.controlAccumulated} /> <Diff v={g.accumulatedDiff} /></> : "—"}</td><td className="num">{g.rows}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {d.tieOut.doubleCountRisk && !posted ? (
            <div className="faimp-risk" role="alert" data-testid="faimp-double">
              <strong>{L("خطر احتساب الأصول مرتين", "Risk of counting the assets twice")}</strong>
              <p>{L(`في الأرصدة الافتتاحية ${d.tieOut.opening.otherGridLines.count} سطرًا أُدخل يدويًا على حسابات الأصول الثابتة (مدين ${money(d.tieOut.opening.otherGridLines.debit)} · دائن ${money(d.tieOut.opening.otherGridLines.credit)}). احذفها من «الأرصدة الافتتاحية»، أو أكّد أنها ليست أصولًا من هذا السجل.`, `The opening grid has ${d.tieOut.opening.otherGridLines.count} line(s) entered by hand on the fixed-asset accounts (debit ${money(d.tieOut.opening.otherGridLines.debit)} · credit ${money(d.tieOut.opening.otherGridLines.credit)}). Remove them in «Opening balances», or confirm they are not assets of this register.`)}</p>
              <label className="faimp-check"><input type="checkbox" checked={confirmOther} onChange={(e) => setConfirmOther(e.target.checked)} data-testid="faimp-confirm-other" /> {L("أؤكد أن هذه الأسطر شيء آخر وليست أصولًا مستوردة", "I confirm these lines are something else, not imported assets")}</label>
            </div>
          ) : null}
          <div className="acct-foot">
            <span>{posted ? L("رُحّلت الأرصدة الافتتاحية: المطابقة نهائية.", "The opening is posted: the tie-out is final.") : d.tieOut.opening.inGrid ? <span className="acct-good">{L("الأرصدة الافتتاحية تحمل أسطر السجل الحالية.", "The opening grid carries the register's current lines.")}</span> : <span className="acct-warn" data-testid="faimp-not-in-grid">{L("الأرصدة الافتتاحية لا تحمل أسطر السجل الحالية بعد.", "The opening grid does not carry the register's current lines yet.")}</span>}</span>
            <span className="acct-actions">
              <Link className="hr-btn" href="/dashboard/accounting/opening">{L("الأرصدة الافتتاحية", "Opening balances")}</Link>
              {d.can.opening && !posted && d.tieOut.opening.lines.length ? <Btn variant="primary" disabled={d.tieOut.doubleCountRisk && !confirmOther} busy={w.busy === "apply"} onClick={apply} data-testid="faimp-apply">{L("تطبيق على الأرصدة الافتتاحية", "Apply to the opening balances")}</Btn> : null}
            </span>
          </div>
        </div>
      </Section>

      <Section title={L("عمليات الاستيراد", "Imports")} testId="faimp-list">
        {d.imports.length === 0 ? <div className="fa-body"><p className="acct-hint">{L("لا عمليات استيراد بعد.", "No imports yet.")}</p></div> : (
          <div className="hr-tablewrap"><table className="hr-table is-dense">
            <thead><tr><th>{L("الملف", "File")}</th><th>{L("التاريخ", "Date")}</th><th className="num">{L("الأصول", "Assets")}</th><th className="num">{L("التكلفة", "Cost")}</th><th className="num">{L("مجمع الإهلاك", "Accumulated")}</th><th>{L("الحالة", "Status")}</th><th>{L("الخيارات", "Options")}</th></tr></thead>
            <tbody>{d.imports.map((i) => (
              <tr key={i.id} data-testid="faimp-import">
                <td><bdi>{i.fileName}</bdi></td><td><bdi>{i.createdAt.slice(0, 10)}</bdi></td><td className="num">{i.rows}</td><td className="num"><Money v={i.totalCost} /></td><td className="num"><Money v={i.totalAccumulated} /></td>
                <td>{i.revertedAt ? <span className="hr-dot tone-cancelled"><span>{L("أُلغي", "Undone")}</span></span> : <span className="hr-dot tone-success"><span>{posted ? L("نهائي", "Final") : L("مستورد", "Imported")}</span></span>}</td>
                <td>{!i.revertedAt && !posted && d.can.import ? <Btn size="sm" variant="danger" onClick={() => setUndoing({ id: i.id, reason: "" })} data-testid="faimp-undo">{L("إلغاء الاستيراد", "Undo import")}</Btn> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {undoing ? (
          <div className="fa-body" data-testid="faimp-undo-box">
            <p>{L("يُحذف كل أصل من هذا الاستيراد (يبقى السجل في سجل التدقيق). يُرفض إن سُجّل على أحدها شيء بعده.", "Every asset of this import is removed (the audit trail keeps them). Refused if anything was recorded on one since.")}</p>
            <div className="acct-row">
              <Field label={L("السبب", "Reason")}><input className="hr-input" value={undoing.reason} maxLength={500} onChange={(e) => setUndoing({ ...undoing, reason: e.target.value })} data-testid="faimp-undo-reason" /></Field>
              <Btn variant="danger" disabled={undoing.reason.trim().length < 3} busy={w.busy === "undo"} onClick={undo} data-testid="faimp-undo-confirm">{L("تأكيد الإلغاء", "Confirm the undo")}</Btn>
              <Btn variant="ghost" onClick={() => setUndoing(null)}>{L("رجوع", "Back")}</Btn>
            </div>
          </div>
        ) : null}
      </Section>
    </>
  );
}
