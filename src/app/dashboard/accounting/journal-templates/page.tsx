"use client";

// «القيود السهلة» (Qoyod parity, phase 4 item 1): reusable journal templates. «استخدام» opens the manual journal form
// prefilled (the user enters the date and, for a percentage template, the total); «تكرار» makes it a recurring
// transaction. Creating / editing needs accounting › recurring; using one needs journal_create; the API re-checks every duty.
import Link from "next/link";
import { useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { AcctShell, Msg, money, useApi, useLang, useWrite, type Setup } from "../_ui/shell";
import { TemplateEditor, type TplValue } from "../_ui/template-editor";

type Line = { accountId: string; side: "D" | "C"; amount: string | null; percent: string | null; description: string | null; branchId: string | null; costCenterId: string | null; partyType: string | null; partyId: string | null; account: { code: string; nameAr: string | null; nameEn: string } };
type Template = { id: string; name: string; description: string | null; amountMode: "FIXED" | "PERCENT"; isActive: boolean; schedules: number; fixedTotal: string | null; updatedAt: string; lines: Line[] };

const toValue = (t: Template): TplValue => ({
  name: t.name, description: t.description ?? "", amountMode: t.amountMode,
  lines: t.lines.map((l) => ({ accountId: l.accountId, side: l.side, amount: l.amount ?? "", percent: l.percent ? l.percent.replace(/\.?0+$/, "") : "", description: l.description ?? "", branchId: l.branchId ?? "", costCenterId: l.costCenterId ?? "", partyType: l.partyType ?? "", partyId: l.partyId ?? "" })),
});

export default function JournalTemplatesPage() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const [archived, setArchived] = useState(false);
  const list = useApi<{ items: Template[] }>(`/api/accounting/journal-templates${archived ? "?archived=1" : ""}`);
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const w = useWrite();
  const can = setup.data?.can;

  async function archive(t: Template, on: boolean) {
    if (await w.run(`a-${t.id}`, `/api/accounting/journal-templates/${t.id}/archive`, "POST", { archived: on }, on ? L("أُرشف القالب.", "Template archived.") : L("أُعيد القالب.", "Template restored."))) list.reload();
  }
  async function remove(t: Template) {
    if (!window.confirm(L(`حذف القالب «${t.name}»؟`, `Delete the template «${t.name}»?`))) return;
    if (await w.run(`d-${t.id}`, `/api/accounting/journal-templates/${t.id}`, "DELETE", {}, L("حُذف القالب.", "Template deleted."))) list.reload();
  }

  return (
    <AcctShell setup={setup.data} title={L("القيود السهلة", "Journal templates")}
      meta={<span className="acct-meta">{L("قوالب قيود جاهزة: اختر القالب وأدخل التاريخ والإجمالي فقط.", "Ready-made journals: pick a template and enter only the date and the total.")}</span>}
      actions={can?.recurring && !editing ? <button type="button" className="hr-btn is-primary" onClick={() => setEditing("new")} data-testid="tpl-new">+ {L("قالب جديد", "New template")}</button> : undefined}>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {setup.data && !setup.data.manualJournalsEnabled ? <p className="acct-hint" role="status">{L("القيود اليدوية معطّلة حاليًا: يمكن إعداد القوالب، ولا يُنشأ منها قيد حتى تُفعَّل.", "Manual journals are disabled for now: templates can be set up, but no journal is made from them until they are enabled.")}</p> : null}
      {editing ? (
        <TemplateEditor
          key={editing === "new" ? "new" : editing.id}
          id={editing === "new" ? undefined : editing.id}
          expectedUpdatedAt={editing === "new" ? undefined : editing.updatedAt}
          initial={editing === "new" ? undefined : toValue(editing)}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); w.setDone(L("حُفظ القالب.", "Template saved.")); list.reload(); }}
        />
      ) : null}
      <div className="acct-row">
        <label className="hr-field"><span className="hr-label"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} data-testid="tpl-show-archived" /> {L("إظهار المؤرشفة", "Show archived")}</span></label>
      </div>
      {list.error ? <p role="alert" className="hr-err">{list.error}</p> : null}
      {!list.data ? <OpsLoading /> : list.data.items.length === 0 ? (
        <div className="acct-card" data-testid="tpl-empty">
          <p><strong>{L("لا توجد قوالب بعد.", "No templates yet.")}</strong></p>
          <p className="acct-hint">{L("أنشئ قالبًا للقيود التي تتكرر: الإيجار، الاستهلاك، توزيع المصروفات على الفروع بالنسب…", "Create a template for journals you repeat: rent, depreciation, splitting an expense across branches by percentage…")}</p>
        </div>
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense is-mrow" data-testid="tpl-table">
            <thead><tr><th>{L("الإسم", "Name")}</th><th>{L("طريقة المبالغ", "Amounts")}</th><th>{L("السطور", "Lines")}</th><th className="num">{L("الإجمالي", "Total")}</th><th>{L("الحالة", "Status")}</th><th>{L("الخيارات", "Options")}</th></tr></thead>
            <tbody>
              {list.data.items.map((t) => (
                <tr key={t.id} data-testid={`tpl-row-${t.id}`}>
                  <td className="m-title"><strong>{t.name}</strong>{t.description ? <span className="hr-msub">{t.description}</span> : null}</td>
                  <td>{t.amountMode === "PERCENT" ? L("نسب", "Percentages") : L("مبالغ ثابتة", "Fixed")}</td>
                  <td className="hr-caption">{t.lines.map((l) => `${l.side === "D" ? L("مدين", "Dr") : L("دائن", "Cr")} ${l.account.code}${l.percent ? ` ${l.percent.replace(/\.?0+$/, "")}٪` : ""}`).join(" · ")}</td>
                  <td className="num hr-num">{t.fixedTotal ? money(t.fixedTotal) : L("يُدخل عند الاستخدام", "Entered at use")}</td>
                  <td className="m-end">{t.isActive ? <span className="hr-dot tone-success"><span>{L("نشط", "Active")}</span></span> : <span className="hr-dot tone-cancelled"><span>{L("مؤرشف", "Archived")}</span></span>}
                    {t.schedules ? <span className="hr-msub">{L(`في ${t.schedules} معاملة متكررة`, `In ${t.schedules} recurring`)}</span> : null}</td>
                  <td className="ops-actions">
                    <span className="acct-actions">
                      {t.isActive && can?.journalCreate ? <Link className="hr-btn is-sm is-primary" href={`/dashboard/accounting/journals/new?template=${t.id}`} data-testid={`tpl-use-${t.id}`}>{L("استخدام", "Use")}</Link> : null}
                      {t.isActive && can?.recurring && can?.journalCreate ? <Link className="hr-btn is-sm" href={`/dashboard/accounting/recurring/new?template=${t.id}`} data-testid={`tpl-recur-${t.id}`}>{L("تكرار", "Repeat")}</Link> : null}
                      {t.isActive && can?.recurring ? <button type="button" className="hr-btn is-sm is-ghost" onClick={() => setEditing(t)} data-testid={`tpl-edit-${t.id}`}>{L("تعديل", "Edit")}</button> : null}
                      {can?.recurring ? <button type="button" className="hr-btn is-sm is-ghost" disabled={w.busy === `a-${t.id}`} onClick={() => archive(t, t.isActive)}>{t.isActive ? L("أرشفة", "Archive") : L("إعادة", "Restore")}</button> : null}
                      {can?.recurring && !t.schedules ? <button type="button" className="hr-btn is-sm is-ghost" disabled={w.busy === `d-${t.id}`} onClick={() => remove(t)}>{L("حذف", "Delete")}</button> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AcctShell>
  );
}
