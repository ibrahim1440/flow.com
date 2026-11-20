"use client";

// «قواعد حسابات المبيعات» — the accountant's request: the revenue and cost-of-sales account by SALES ACTIVITY (the
// roastery's B2B sales, the web shop, the café), then by product category or one SKU. Order when an entry is posted:
// the activity's SKU rule, else its category rule, else the activity's own accounts, else the general account of the
// role mapping. A change applies to entries posted AFTER it; posted entries keep the account they were posted to.
import { useMemo, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { AcctShell, Msg, useApi, useLang, useWrite, type Setup } from "../_ui/shell";

type AccRef = { id: string; code: string; referenceCode: string | null; nameAr: string | null; nameEn: string } | null;
type Activity = "ROASTERY_B2B" | "WEBSITE" | "CAFE";
type Rule = { id: string; activity: Activity; scope: "ACTIVITY" | "CATEGORY" | "SKU"; category: { id: string; nameAr: string; nameEn: string | null } | null; sku: { id: string; skuCode: string; name: string | null } | null; revenueAccount: AccRef; cogsAccount: AccRef };
type Data = {
  activities: Activity[];
  enabled?: Activity[];
  general: { revenue: AccRef; cogs: AccRef };
  rules: Rule[];
  categories: { id: string; nameAr: string; nameEn: string | null; isActive: boolean }[];
  skus: { id: string; skuCode: string; name: string | null; isActive: boolean; categoryId: string | null }[];
};
type Acc = { id: string; code: string; referenceCode?: string | null; nameAr: string | null; nameEn: string; type: string; allowPosting: boolean; isActive: boolean; children: number; controlType?: string | null };
type Scope = { categoryId?: string; productSkuId?: string };
type CostLine = { orderItemId: string; orderNumber: number; customer: string; activity: Activity; skuCode: string | null; name: string; categoryId: string | null };
type Unmapped = { orderLines: CostLine[]; documents: { invoiceId: string; kind: string; customer: string; orderNumber: number | null; activity: Activity | null; lines: { lineId: string; position: number; description: string; lineNet: string; salesCategoryId: string | null; reasonAr: string; reasonEn: string }[] }[] };

export default function SalesAccountRulesPage() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const data = useApi<Data>("/api/accounting/sales-account-rules");
  const coa = useApi<Acc[]>("/api/accounting/coa");
  const review = useApi<Unmapped>("/api/accounting/sales-account-rules/lines");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const w = useWrite();
  const [adding, setAdding] = useState<Record<string, string>>({});
  const can = setup.data?.can.settings;
  const usable = useMemo(() => (coa.data ?? []).filter((a) => a.isActive && a.allowPosting && a.children === 0 && !a.controlType), [coa.data]);
  const revenue = usable.filter((a) => a.type === "REVENUE"), expense = usable.filter((a) => a.type === "EXPENSE");
  const label = (a: { code: string; referenceCode?: string | null; nameAr: string | null; nameEn: string }) => `${a.code}${a.referenceCode ? ` (${L("مرجع", "ref")} ${a.referenceCode})` : ""} · ${L(a.nameAr ?? a.nameEn, a.nameEn)}`;
  const name = (a: AccRef) => (a ? label(a) : L("غير مربوط", "not mapped"));
  const ACT: Record<Activity, string> = { ROASTERY_B2B: L("المحمصة — مبيعات الجملة", "Roastery — B2B"), WEBSITE: L("الموقع الإلكتروني", "Website"), CAFE: L("الكافيه", "Café") };

  async function save(activity: Activity, scope: Scope, field: "revenueAccountId" | "cogsAccountId", value: string) {
    const key = `${activity}:${scope.productSkuId ?? scope.categoryId ?? ""}:${field}`;
    const r = await w.run(key, "/api/accounting/sales-account-rules", "PUT", { activity, ...scope, [field]: value || null }, L("حُفظ. يسري على القيود التي تُرحَّل من الآن.", "Saved. It applies to entries posted from now on."));
    if (r) { setAdding((a) => ({ ...a, [activity]: "" })); data.reload(); review.reload(); }
  }
  async function classify(lineId: string, salesCategoryId: string) {
    const r = await w.run(`line:${lineId}`, "/api/accounting/sales-account-rules/lines", "PUT", { lineId, salesCategoryId: salesCategoryId || null }, L("صُنّف البند.", "The line is classified."));
    if (r) review.reload();
  }
  async function decideCost(orderItemId: string) {
    const r = await w.run(`cost:${orderItemId}`, "/api/accounting/sales-account-rules/lines", "PUT", { orderItemId, costAccountReason: reasons[orderItemId] ?? "" }, L("سُجّل قرار استخدام الحساب العام لتكلفة هذا البند باسمك.", "The decision to use the general account for this line's cost is recorded under your name."));
    if (r) review.reload();
  }
  async function decide(lineId: string) {
    const r = await w.run(`decide:${lineId}`, "/api/accounting/sales-account-rules/lines", "PUT", { lineId, generalAccountReason: reasons[lineId] ?? "" }, L("سُجّل قرار استخدام الحساب العام باسمك على البند.", "The decision to use the general account is recorded on the line under your name."));
    if (r) review.reload();
  }
  const picker = (activity: Activity, scope: Scope, field: "revenueAccountId" | "cogsAccountId", current: AccRef, list: Acc[], inherit: string) => (
    <Select value={current?.id ?? ""} disabled={!can || w.busy !== null} onChange={(e) => save(activity, scope, field, e.target.value)} data-testid={`sar-${activity}-${scope.productSkuId ?? scope.categoryId ?? "default"}-${field}`}>
      <option value="">{inherit}</option>
      {list.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
    </Select>
  );
  const row = (activity: Activity, scope: Scope, title: React.ReactNode, r: Rule | undefined, inherit: string) => (
    <tr key={`${activity}:${scope.productSkuId ?? scope.categoryId ?? "default"}`}>
      <td>{title}</td>
      <td>{picker(activity, scope, "revenueAccountId", r?.revenueAccount ?? null, revenue, inherit)}</td>
      <td>{picker(activity, scope, "cogsAccountId", r?.cogsAccount ?? null, expense, inherit)}</td>
    </tr>
  );

  return (
    <AcctShell setup={setup.data} title={L("قواعد حسابات المبيعات", "Sales account rules")}>
      <Msg error={w.error ?? data.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!data.data || !coa.data ? <OpsLoading /> : (
        <>
          <section className="acct-card">
            <p className="acct-hint">{L("عند ترحيل قيد بيع أو تكلفة مبيعات لمستند محدَّد النشاط يُؤخذ حساب قاعدة الصنف في ذلك النشاط إن وُجدت، وإلا قاعدة تصنيفه، وإلا حساب النشاط نفسه، وإلا الحساب العام في «ربط الحسابات». المستند الذي لم يُسجَّل له نشاط يُرحَّل على الحساب العام؛ لا يُخمَّن النشاط. التغيير يسري على ما يُرحَّل بعده فقط؛ القيود المرحّلة تحتفظ بحسابها ونشاطها.", "When a sale or its cost is posted for a document with a recorded activity, the activity's SKU rule applies if there is one, else its category rule, else the activity's own accounts, else the general account of the role mapping. A document with no recorded activity posts to the general account; the activity is never guessed. A change applies to what is posted after it only; posted entries keep their account and activity.")}</p>
            <p className="acct-hint" data-testid="sar-general">{L("الحساب العام — الإيراد: ", "General account — revenue: ")}{name(data.data.general.revenue)} · {L("تكلفة المبيعات: ", "cost of sales: ")}{name(data.data.general.cogs)}</p>
          </section>
          <section className="acct-card" data-testid="sar-review">
            <h2>{L("بنود غير مربوطة — للمراجعة قبل الإصدار", "Unmapped lines — to review before issue")}</h2>
            <p className="acct-hint">{L("بنود مسودات محدَّدة النشاط لا تغطيها قاعدة لصنفها أو تصنيفها. لا يصدر المستند حتى يُصنَّف كل بند، أو يسجّل صاحب صلاحية ربط الحسابات قرار استخدام الحساب العام مع السبب. المستندات الصادرة لا تتغير.", "Lines of drafts posted under an activity that no rule of their SKU or category covers. The document is not issued until every line is classified, or the account-mapping duty records the decision to use the general account, with a reason. Issued documents never change.")}</p>
            {!review.data ? <OpsLoading /> : review.data.documents.length === 0 ? <p className="acct-hint" data-testid="sar-review-empty">{L("لا توجد بنود غير مربوطة.", "No unmapped lines.")}</p> : (
              <div className="hr-tablewrap"><table className="hr-table is-dense">
                <thead><tr><th>{L("المستند", "Document")}</th><th>{L("البند", "Line")}</th><th className="num">{L("الصافي", "Net")}</th><th>{L("السبب", "Why")}</th><th>{L("تصنيف المبيعات", "Sales category")}</th><th>{L("أو: قرار الحساب العام", "Or: general-account decision")}</th></tr></thead>
                <tbody>{review.data.documents.flatMap((d) => d.lines.map((l) => (
                  <tr key={l.lineId} data-testid={`sar-line-${l.lineId}`}>
                    <td>{d.customer}{d.orderNumber ? ` · ${L("طلب", "order")} ${d.orderNumber}` : ""}{d.activity ? ` · ${ACT[d.activity]}` : ""}</td>
                    <td>{l.position}. {l.description}</td>
                    <td className="num hr-num">{l.lineNet}</td>
                    <td className="acct-hint">{L(l.reasonAr, l.reasonEn)}</td>
                    <td>
                      <Select value={l.salesCategoryId ?? ""} disabled={w.busy !== null} onChange={(e) => classify(l.lineId, e.target.value)} data-testid={`sar-line-${l.lineId}-category`}>
                        <option value="">{L("اختر تصنيفًا", "Choose a category")}</option>
                        {data.data!.categories.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
                      </Select>
                    </td>
                    <td>{can ? (
                      <span style={{ display: "flex", gap: 8 }}>
                        <input className="hr-input" value={reasons[l.lineId] ?? ""} onChange={(e) => setReasons((r) => ({ ...r, [l.lineId]: e.target.value }))} placeholder={L("سبب القرار", "Reason")} aria-label={L("سبب القرار", "Reason")} data-testid={`sar-line-${l.lineId}-reason`} />
                        <button type="button" className="hr-btn" disabled={w.busy !== null || (reasons[l.lineId] ?? "").trim().length < 5} onClick={() => decide(l.lineId)} data-testid={`sar-line-${l.lineId}-decide`}>{L("تسجيل القرار", "Record")}</button>
                      </span>
                    ) : <span className="acct-hint">{L("لصاحب صلاحية ربط الحسابات", "For the account-mapping duty")}</span>}</td>
                  </tr>
                )))}</tbody>
              </table></div>
            )}
            <h2 style={{ marginTop: 24 }}>{L("تكلفة المبيعات — بنود طلبات بلا حساب تكلفة", "Cost of sales — order lines with no cost account")}</h2>
            <p className="acct-hint">{L("بنود مفتوحة في طلبات محدَّدة النشاط لا تعطي قواعد النشاط لصنفها أو تصنيفها حساب تكلفة مبيعات. تسليم عبوة لها تكلفة يُرفض حتى تُضاف قاعدة، أو يسجَّل هنا قرار استخدام الحساب العام لهذا البند. هذا توجيه لحساب التكلفة فقط؛ لا يحتسب تكلفة المشروبات أو ما لا مصدر تكلفة له.", "Open lines of orders posted under an activity whose rules give their SKU or category no cost-of-sales account. A delivery of a costed lot for them is refused until a rule is added, or the decision to use the general account for the line is recorded here. This routes the cost account only; it does not cost drinks or anything with no cost source.")}</p>
            {!review.data ? null : review.data.orderLines.length === 0 ? <p className="acct-hint" data-testid="sar-cost-empty">{L("لا توجد بنود.", "None.")}</p> : (
              <div className="hr-tablewrap"><table className="hr-table is-dense">
                <thead><tr><th>{L("الطلب", "Order")}</th><th>{L("الصنف", "SKU")}</th><th>{L("النشاط", "Activity")}</th><th>{L("قرار الحساب العام", "General-account decision")}</th></tr></thead>
                <tbody>{review.data.orderLines.map((o) => (
                  <tr key={o.orderItemId} data-testid={`sar-cost-${o.orderItemId}`}>
                    <td>{o.orderNumber} · {o.customer}</td><td><span className="acct-code">{o.skuCode}</span> {o.name}</td><td>{ACT[o.activity]}</td>
                    <td>{can ? (
                      <span style={{ display: "flex", gap: 8 }}>
                        <input className="hr-input" value={reasons[o.orderItemId] ?? ""} onChange={(e) => setReasons((r) => ({ ...r, [o.orderItemId]: e.target.value }))} placeholder={L("سبب القرار", "Reason")} aria-label={L("سبب القرار", "Reason")} data-testid={`sar-cost-${o.orderItemId}-reason`} />
                        <button type="button" className="hr-btn" disabled={w.busy !== null || (reasons[o.orderItemId] ?? "").trim().length < 5} onClick={() => decideCost(o.orderItemId)} data-testid={`sar-cost-${o.orderItemId}-decide`}>{L("تسجيل القرار", "Record")}</button>
                      </span>
                    ) : <span className="acct-hint">{L("لصاحب صلاحية ربط الحسابات", "For the account-mapping duty")}</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
          {data.data.activities.map((activity) => {
            const rules = data.data!.rules.filter((r) => r.activity === activity);
            const pending = adding[activity] ?? "";
            const taken = new Set(rules.map((r) => (r.sku ? `S:${r.sku.id}` : r.category ? `C:${r.category.id}` : "")));
            const pendingScope: Scope | null = pending.startsWith("C:") ? { categoryId: pending.slice(2) } : pending.startsWith("S:") ? { productSkuId: pending.slice(2) } : null;
            const pendingTitle = pendingScope?.categoryId ? data.data!.categories.find((c) => c.id === pendingScope.categoryId)?.nameAr : data.data!.skus.find((s) => s.id === pendingScope?.productSkuId)?.skuCode;
            return (
              <section className="acct-card" key={activity} data-testid={`sar-${activity}`}>
                <h2>{ACT[activity]}</h2>
                <p className="hr-muted" data-testid={`sar-state-${activity}`}>{(data.data!.enabled ?? []).includes(activity)
                  ? L("مفعّل: يُعرض هذا النشاط عند إنشاء الطلب، ويُقبل على المستندات الجديدة.", "Activated: offered on the order form and accepted on new documents.")
                  : L("غير مفعّل: لا يُعرض هذا النشاط للمستخدمين ولا يُقبل على مستند جديد. القواعد أدناه تُجهَّز وتُعتمد أولًا، ثم يفعّله المالك من إعدادات التشغيل (SALES_ACTIVITIES_ENABLED).", "Not activated: not offered to users and not accepted on a new document. Prepare and approve the rules below first; the owner then activates it in the deployment settings (SALES_ACTIVITIES_ENABLED).")}</p>
                <div className="hr-tablewrap"><table className="hr-table is-dense">
                  <thead><tr><th>{L("النطاق", "Scope")}</th><th>{L("حساب الإيراد", "Revenue account")}</th><th>{L("حساب تكلفة المبيعات", "Cost-of-sales account")}</th></tr></thead>
                  <tbody>
                    {row(activity, {}, L("كل أصناف النشاط (الافتراضي)", "Every product of the activity (default)"), rules.find((r) => r.scope === "ACTIVITY"), L("الحساب العام", "General account"))}
                    {rules.filter((r) => r.scope === "CATEGORY").map((r) => row(activity, { categoryId: r.category!.id }, <>{L("تصنيف: ", "Category: ")}{r.category!.nameAr}</>, r, L("حسب النشاط", "By the activity")))}
                    {rules.filter((r) => r.scope === "SKU").map((r) => row(activity, { productSkuId: r.sku!.id }, <><span className="acct-code">{r.sku!.skuCode}</span> {r.sku!.name}</>, r, L("حسب التصنيف أو النشاط", "By category or activity")))}
                    {pendingScope ? row(activity, pendingScope, <>{pendingScope.categoryId ? L("تصنيف: ", "Category: ") : ""}{pendingTitle}</>, undefined, L("اختر حسابًا", "Choose an account")) : null}
                  </tbody>
                </table></div>
                {can ? (
                  <div className="acct-foot">
                    <Select value={pending} onChange={(e) => setAdding((a) => ({ ...a, [activity]: e.target.value }))} data-testid={`sar-${activity}-add`}>
                      <option value="">{L("إضافة قاعدة لتصنيف أو صنف…", "Add a rule for a category or a SKU…")}</option>
                      {data.data!.categories.filter((c) => c.isActive && !taken.has(`C:${c.id}`)).map((c) => <option key={c.id} value={`C:${c.id}`}>{L("تصنيف: ", "Category: ")}{c.nameAr}</option>)}
                      {data.data!.skus.filter((s) => s.isActive && !taken.has(`S:${s.id}`)).map((s) => <option key={s.id} value={`S:${s.id}`}>{s.skuCode} · {s.name}</option>)}
                    </Select>
                  </div>
                ) : null}
              </section>
            );
          })}
        </>
      )}
    </AcctShell>
  );
}
