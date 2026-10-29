"use client";

// «دليل الحسابات» (Figma ACC-23 / 23a): the tree with type, control kind, manual-journal rule, postable / header,
// posting roles and posted balance; filters (all · postable · control · inactive), search and type; «حساب جديد»
// and the edit dialog (code / type / normal balance locked once the account has lines). An empty chart offers
// «تهيئة دليل الحسابات» — the default roastery + café chart, on request only.
import { useMemo, useState } from "react";
import { GROUP_LABEL } from "@/lib/accounting/report-groups";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { roleDef } from "@/lib/accounting/roles";
import { AcctShell, ACCOUNT_TYPE_AR, CONTROL_AR, Msg, money, useApi, useLang, useWrite, type Setup } from "../_ui/shell";
import { Section, useTerm } from "@/components/chrome";
import { useAccountantView } from "../_ui/qoyod-pages";

type Acc = { id: string; code: string; nameAr: string | null; nameEn: string; type: string; normalBalance: string; parentId: string | null; allowPosting: boolean; isActive: boolean; controlType: string | null; allowManualJournal: boolean; description: string | null; reportGroup?: string | null; lines: number; balance: string; roles: string[]; children: number };
type Form = { id?: string; code: string; nameAr: string; nameEn: string; type: string; parentId: string; allowPosting: boolean; isActive: boolean; normalBalance: string; controlType: string; allowManualJournal: boolean; description: string; reportGroup: string };
const CONTROLS = ["AR", "AP", "INVENTORY", "VAT_INPUT", "VAT_OUTPUT", "CASH", "BANK", "FIXED_ASSET", "PAYROLL", "COMMISSION", "CLEARING"];

export default function ChartPage() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const chart = useApi<Acc[]>("/api/accounting/coa");
  const w = useWrite();
  // Qoyod parity (accountant workspace): «شجرة الحسابات», «الخيارات»; the same tree, columns and actions.
  const qoyod = useAccountantView();
  const t = useTerm();
  const [filter, setFilter] = useState<"all" | "postable" | "control" | "inactive">("all");
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [seed, setSeed] = useState<null | { accounts: number; postable: number; roles: number }>(null);
  const can = setup.data?.can;
  const all = useMemo(() => chart.data ?? [], [chart.data]);
  const byId = useMemo(() => new Map(all.map((a) => [a.id, a])), [all]);
  const depth = (a: Acc) => { let n = 0, p = a.parentId; while (p && n < 8) { n++; p = byId.get(p)?.parentId ?? null; } return n; };
  // Tree order: each account after its parent (codes sort within a level).
  const ordered = useMemo(() => {
    const kids = new Map<string | null, Acc[]>();
    for (const a of all) kids.set(a.parentId && byId.has(a.parentId) ? a.parentId : null, [...(kids.get(a.parentId && byId.has(a.parentId) ? a.parentId : null) ?? []), a]);
    const out: Acc[] = [];
    const walk = (p: string | null) => { for (const a of (kids.get(p) ?? []).sort((x, y) => x.code.localeCompare(y.code))) { out.push(a); walk(a.id); } };
    walk(null);
    return out;
  }, [all, byId]);
  const shown = ordered.filter((a) => {
    if (filter === "postable" && !(a.allowPosting && a.children === 0 && a.isActive)) return false;
    if (filter === "control" && !a.controlType) return false;
    if (filter === "inactive" && a.isActive) return false;
    if (type && a.type !== type) return false;
    const t = q.trim().toLowerCase();
    return !t || a.code.toLowerCase().includes(t) || (a.nameAr ?? "").includes(t) || a.nameEn.toLowerCase().includes(t);
  });
  const counts = { all: all.length, postable: all.filter((a) => a.allowPosting && a.children === 0 && a.isActive).length, control: all.filter((a) => a.controlType).length, inactive: all.filter((a) => !a.isActive).length };
  const headers = all.filter((a) => !a.allowPosting);

  async function preview() {
    const r = await w.run<{ accounts: number; postable: number; roles: number }>("preview", "/api/accounting/coa/seed", "POST", { dryRun: true });
    if (r) setSeed(r);
  }
  async function doSeed() {
    const r = await w.run("seed", "/api/accounting/coa/seed", "POST", {}, L("هُيّئ دليل الحسابات وربطت الحسابات.", "The chart is set up and the accounts mapped."));
    if (r) { setSeed(null); chart.reload(); setup.reload(); }
  }
  async function save() {
    if (!form) return;
    const body = { code: form.code, nameAr: form.nameAr || null, nameEn: form.nameEn, type: form.type, parentId: form.parentId || null, allowPosting: form.allowPosting, isActive: form.isActive, normalBalance: form.normalBalance, controlType: form.controlType || null, allowManualJournal: form.allowManualJournal, description: form.description || null, reportGroup: form.reportGroup || null };
    const r = form.id
      ? await w.run("save", `/api/accounting/coa/${form.id}`, "PATCH", body, L("حُفظ الحساب.", "Account saved."))
      : await w.run("save", "/api/accounting/coa", "POST", body, L("أُضيف الحساب.", "Account added."));
    if (r) { setForm(null); chart.reload(); }
  }
  const edit = (a?: Acc) => setForm(a ? { id: a.id, code: a.code, nameAr: a.nameAr ?? "", nameEn: a.nameEn, type: a.type, parentId: a.parentId ?? "", allowPosting: a.allowPosting, isActive: a.isActive, normalBalance: a.normalBalance, controlType: a.controlType ?? "", allowManualJournal: a.allowManualJournal, description: a.description ?? "", reportGroup: a.reportGroup ?? "" }
    : { code: "", nameAr: "", nameEn: "", type: "EXPENSE", parentId: "", allowPosting: true, isActive: true, normalBalance: "AUTO", controlType: "", allowManualJournal: true, description: "", reportGroup: "" });
  const editing = form?.id ? byId.get(form.id) : undefined;
  const locked = !!editing && editing.lines > 0;

  const coaTable = (
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="coa-table">
              <thead><tr><th>{L("الرمز", "Code")}</th><th>{L("الحساب", "Account")}</th><th className="acct-hide-m">{L("النوع", "Type")}</th><th className="acct-hide-m">{L("المراقبة", "Control")}</th><th className="acct-hide-m">{L("القيد اليدوي", "Manual journal")}</th><th className="acct-hide-m">{L("يُرحَّل عليه تلقائيًا", "Posted to automatically for")}</th><th className="num">{L("الرصيد", "Balance")}</th>{can?.coa ? <th>{qoyod ? t("colOptions") : <span className="hr-sr">{L("تعديل", "Edit")}</span>}</th> : null}</tr></thead>
              <tbody>
                {shown.map((a) => {
                  const header = !a.allowPosting || a.children > 0;
                  return (
                    <tr key={a.id} className={`${header ? "is-header" : ""}${a.isActive ? "" : " is-muted"}`} data-code={a.code}>
                      <td className="acct-code">{a.code}</td>
                      <td><span className="acct-indent" style={{ paddingInlineStart: depth(a) * 16 }}>{L(a.nameAr ?? a.nameEn, a.nameEn)}</span></td>
                      <td className="acct-hide-m">{L(ACCOUNT_TYPE_AR[a.type]?.[0] ?? a.type, ACCOUNT_TYPE_AR[a.type]?.[1] ?? a.type)}{header ? <span className="acct-hint"> · {L("رئيسي · لا يُرحَّل عليه", "Header · not postable")}</span> : null}</td>
                      <td className="acct-hide-m">{a.controlType ? L(CONTROL_AR[a.controlType]?.[0] ?? a.controlType, CONTROL_AR[a.controlType]?.[1] ?? a.controlType) : "—"}</td>
                      <td className="acct-hide-m">{header ? "" : a.allowManualJournal ? L("مسموح", "Allowed") : <span className="hr-flag tone-warning"><span>{L("لا قيد يدوي", "No manual journal")}</span></span>}</td>
                      <td className="acct-hide-m acct-hint" title={a.roles.join(" · ") || undefined}>{a.roles.map((k) => { const d = roleDef(k); return d ? L(d.ar, d.en) : k; }).join(" · ")}</td>
                      <td className="num hr-num">{a.lines ? money(a.balance) : <span className="acct-hint">{header ? "" : L("لا حركات", "No movement")}</span>}</td>
                      {can?.coa ? <td><button type="button" className="hr-btn is-ghost is-sm" onClick={() => edit(a)} aria-label={L(`تعديل ${a.code}`, `Edit ${a.code}`)}>{L("تعديل", "Edit")}</button></td> : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
  );
  return (
    <AcctShell setup={setup.data} title={qoyod ? t("chart") : undefined}
      meta={<span className="acct-meta"><span className="hr-num">{counts.all}</span> {L("حسابًا", "accounts")} · <span className="hr-num">{counts.postable}</span> {L("قابلًا للترحيل", "postable")}{setup.data?.settings.coaSeededAt ? <> · {L("من القالب الافتراضي", "from the default template")}</> : null}</span>}
      actions={can?.coa && all.length > 0 ? <Btn variant="primary" onClick={() => edit()} data-testid="coa-new">+ {L("حساب جديد", "New account")}</Btn> : undefined}>
      <Msg error={w.error ?? chart.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!chart.data ? <OpsLoading /> : all.length === 0 ? (
        <section className="acct-card" data-testid="coa-empty">
          <h2>{L("دليل الحسابات فارغ", "The chart of accounts is empty")}</h2>
          <p className="acct-hint">{L("يمكنك تهيئة الدليل الافتراضي لمحمصة ومقهى في المملكة (SOCPA / IFRS للمنشآت الصغيرة والمتوسطة) ثم تعديله، أو إضافة حساباتك بنفسك. لا يُهيّأ شيء تلقائيًا.", "You may set up the default chart for a KSA roastery + café (SOCPA / IFRS for SMEs) and edit it, or add your own accounts. Nothing is set up automatically.")}</p>
          {can?.coa ? <span className="acct-actions"><Btn variant="primary" busy={w.busy === "preview"} onClick={preview} data-testid="coa-seed">{L("تهيئة دليل الحسابات", "Set up the chart of accounts")}</Btn><Btn onClick={() => edit()}>{L("إضافة حساب", "Add an account")}</Btn></span> : null}
        </section>
      ) : (
        <>
          <div className="acct-row">
            <div className="acct-seg" role="group" aria-label={L("تصفية", "Filter")}>
              {(["all", "postable", "control", "inactive"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {L({ all: "الكل", postable: "قابلة للترحيل", control: "مراقبة", inactive: "غير نشطة" }[k], { all: "All", postable: "Postable", control: "Control", inactive: "Inactive" }[k])} <span className="hr-num">{counts[k]}</span>
                </button>
              ))}
            </div>
            <label className="hr-field acct-grow"><span className="hr-sr">{L("بحث", "Search")}</span><input className="hr-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("الرمز أو اسم الحساب", "Code or account name")} data-testid="coa-search" /></label>
            <label className="hr-field"><span className="hr-sr">{L("النوع", "Type")}</span>
              <Select value={type} onChange={(e) => setType(e.target.value)} placeholder={L("النوع: الكل", "Type: all")}>
                <option value="">{L("النوع: الكل", "Type: all")}</option>
                {Object.entries(ACCOUNT_TYPE_AR).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
              </Select></label>
          </div>
          {qoyod ? <Section title={t("chart")} testId="coa-section">{coaTable}</Section> : coaTable}
          <p className="acct-hint">{L("لا يُحذف حساب عليه حركات، ولا يتغير رمزه أو نوعه أو طبيعة رصيده بعد أول حركة. الحساب الرئيسي لا يُرحَّل عليه.", "An account with movements is never deleted, and its code, type and normal balance are fixed after its first movement. A header account is not posted to.")}</p>
        </>
      )}
      <Dialog open={!!seed} title={L("تهيئة دليل الحسابات", "Set up the chart of accounts")} onClose={() => setSeed(null)}
        sub={L("القالب الافتراضي لمحمصة ومقهى في المملكة. يمكن تعديل كل حساب بعد التهيئة.", "The default KSA roastery + café template. Every account stays editable.")}
        actions={<><Btn variant="primary" busy={w.busy === "seed"} onClick={doSeed} data-testid="coa-seed-confirm">{L("تهيئة", "Set up")}</Btn><Btn onClick={() => setSeed(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        {seed ? <p>{L(`سيُنشأ ${seed.accounts} حسابًا (${seed.postable} قابلًا للترحيل) ويُربط ${seed.roles} بندًا بحساباتها.`, `${seed.accounts} accounts (${seed.postable} postable) will be created and ${seed.roles} items mapped to their accounts.`)}</p> : null}
      </Dialog>
      <Dialog open={!!form} title={form?.id ? L(`تعديل حساب · ${form.code}`, `Edit account · ${form?.code}`) : L("حساب جديد", "New account")} onClose={() => setForm(null)}
        actions={<><Btn variant="primary" busy={w.busy === "save"} onClick={save} data-testid="coa-save">{L("حفظ", "Save")}</Btn><Btn onClick={() => setForm(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        {form ? (
          <div className="hr-form">
            <Field label={L("الرمز", "Code")} help={locked ? L("مقفل: على الحساب حركات", "Locked: the account has movements") : undefined}><input className="hr-input" dir="ltr" value={form.code} readOnly={locked} onChange={(e) => setForm({ ...form, code: e.target.value })} data-testid="coa-code" /></Field>
            <Field label={L("النوع", "Type")}>
              <Select value={form.type} disabled={locked} onChange={(e) => setForm({ ...form, type: e.target.value })}>{Object.entries(ACCOUNT_TYPE_AR).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</Select>
            </Field>
            <Field label={L("الاسم بالعربية", "Arabic name")}><input className="hr-input" value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} data-testid="coa-name-ar" /></Field>
            <Field label={L("الاسم بالإنجليزية", "English name")}><input className="hr-input" dir="ltr" value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} data-testid="coa-name-en" /></Field>
            <Field label={L("الحساب الأب (رئيسي)", "Parent (header)")}>
              <Select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })} placeholder="—">
                <option value="">—</option>
                {headers.filter((h) => h.type === form.type && h.id !== form.id).map((h) => <option key={h.id} value={h.id}>{`${h.code} · ${L(h.nameAr ?? h.nameEn, h.nameEn)}`}</option>)}
              </Select>
            </Field>
            <Field label={L("طبيعة الرصيد", "Normal balance")}>
              <Select value={form.normalBalance} disabled={locked} onChange={(e) => setForm({ ...form, normalBalance: e.target.value })}>
                <option value="AUTO">{L("حسب النوع", "From the type")}</option><option value="DEBIT">{L("مدين", "Debit")}</option><option value="CREDIT">{L("دائن", "Credit")}</option>
              </Select>
            </Field>
            <Field label={L("نوع المراقبة", "Control kind")}>
              <Select value={form.controlType} onChange={(e) => setForm({ ...form, controlType: e.target.value })} placeholder="—">
                <option value="">—</option>{CONTROLS.map((c) => <option key={c} value={c}>{L(CONTROL_AR[c][0], CONTROL_AR[c][1])} ({c})</option>)}
              </Select>
            </Field>
            {/* A5: the statement line; empty = inferred from the account's place in the chart and its posting role. */}
            <Field label={L("بند القوائم المالية", "Statement line")} help={L("فارغ = يُستنتج من موقع الحساب في الدليل ودوره", "Empty = inferred from its place in the chart and its role")}>
              <Select value={form.reportGroup} onChange={(e) => setForm({ ...form, reportGroup: e.target.value })} placeholder={L("تلقائي", "Automatic")} data-testid="coa-report-group">
                <option value="">{L("تلقائي", "Automatic")}</option>
                {Object.entries(GROUP_LABEL).map(([k, [ar, en]]) => <option key={k} value={k}>{L(ar, en)}</option>)}
              </Select>
            </Field>
            <Field label={L("الوصف", "Description")}><input className="hr-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <label className="hr-field"><span className="hr-label"><input type="checkbox" checked={form.allowPosting} onChange={(e) => setForm({ ...form, allowPosting: e.target.checked })} /> {L("قابل للترحيل (حساب فرعي)", "Postable (leaf account)")}</span></label>
            <label className="hr-field"><span className="hr-label"><input type="checkbox" checked={form.allowManualJournal} onChange={(e) => setForm({ ...form, allowManualJournal: e.target.checked })} /> {L("يقبل القيد اليدوي", "Accepts manual journals")}</span></label>
            <label className="hr-field"><span className="hr-label"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> {L("نشط", "Active")}</span></label>
          </div>
        ) : null}
      </Dialog>
    </AcctShell>
  );
}
