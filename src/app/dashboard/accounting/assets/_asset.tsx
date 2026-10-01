"use client";

// Asset editor and detail (Figma ACC-61) with its disposals (ACC-63). Registered as a draft,
// submitted, and capitalised by someone other than the preparer; disposals and every reversal are
// likewise decided by someone else. The server enforces all of it; buttons only reflect duties.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { api, ApiError, Button, Card, CardTitle, Dialog, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../finance/_components/ui";
import { riyadhToday, useAmount, useCan, useDay } from "../_components/kit";
import { ASSET_STATUS, DISPOSAL_KIND, DISPOSAL_MONTH, DOC_STATUS, LEDGER, METHOD, Pill, SOURCE_KIND, START } from "./_ui";

type Acc = { id: string; code: string; name: string; type: string; controlKind: string };
type BillLine = { id: string; label: string; net: string; account: string; billDate: string };
type Cls = { id: string; code: string; name: string; nameAr: string | null; isActive: boolean; cost?: { code: string }; policies: { id: string; version: number; status: string; method: string; usefulLifeMonths: number; residualPercent: string; decliningFactor: string | null; startConvention: string; disposalConvention: string; capitalisationThreshold: string }[] };
type Src = { kind: string; billLineId: string; counterAccountId: string; amount: string; description: string };
export type Asset = {
  id: string; assetNo: number; number: string; name: string; status: string; branchId: string | null;
  class: { id: string; code: string; name: string; cost?: { code: string; name: string }; accum?: { code: string; name: string }; expense?: { code: string; name: string } };
  policy: { version: number; method: string; usefulLifeMonths: number; residualPercent: string; decliningFactor: string | null } | null; capitalisedUnder: number | null;
  inServiceDate: string; cost: string; residualValue: string; method: string; usefulLifeMonths: number; decliningFactor: string | null; startConvention: string; disposalConvention: string; deviationReason: string | null;
  openingAccumulated: string; openingMonths: number; openingCounter: { code: string; name: string } | null;
  preparedBy: string; preparedByName: string | null; approvedByName: string | null; capitalisedAt: string | null; cancelReason: string | null; accumulated: string; nbv: string;
  sources: { lineNo: number; kind: string; amount: string; description: string | null; billLineId: string | null; counterAccountId: string | null; reference: string | null; counter: { code: string; name: string } | null; postsOnCapitalisation: boolean }[];
  depreciation: { runId: string; runNo: number; period: string; status: string; amount: string; months: number; accumulatedAfter: string; nbvAfter: string; note: string | null }[];
  schedule: { month: string; amount: string; accumulated: string; nbv: string; note: string | null }[];
  disposals: { id: string; status: string; disposalDate: string; kind: string; proceeds: string; proceedsAccount: { code: string; name: string } | null; reason: string; cost: string | null; accumulated: string | null; nbv: string | null; gainLoss: string | null; preparedBy: string; preparedByName: string | null; approvedByName: string | null; reversalRequestedBy: string | null; reversalReason: string | null }[];
  ledger: { eventType: string; status: string; message: string | null }[];
};
const blankSource = (): Src => ({ kind: "BILL_LINE", billLineId: "", counterAccountId: "", amount: "", description: "" });

export function AssetEditor({ asset, onSaved }: { asset?: Asset; onSaved?: () => void }) {
  const { L } = useL();
  const amt = useAmount();
  const router = useRouter();
  const classes = useApi<Cls[]>("/api/accounting/fixed-assets/classes");
  const accounts = useApi<Acc[]>("/api/accounting/fixed-assets/pickers?what=accounts");
  const billLines = useApi<BillLine[]>("/api/accounting/fixed-assets/pickers?what=bill-lines");
  const [f, setF] = useState(() => ({
    name: asset?.name ?? "", classId: asset?.class.id ?? "", inServiceDate: asset?.inServiceDate ?? riyadhToday(),
    usefulLifeMonths: asset ? String(asset.usefulLifeMonths) : "", residualValue: asset?.residualValue ?? "", method: asset?.method ?? "", deviationReason: asset?.deviationReason ?? "",
    openingAccumulated: asset && asset.openingAccumulated !== "0.00" ? asset.openingAccumulated : "", openingMonths: asset?.openingMonths ? String(asset.openingMonths) : "",
  }));
  const [sources, setSources] = useState<Src[]>(() => asset?.sources.map((s) => ({ kind: s.kind, billLineId: s.billLineId ?? "", counterAccountId: s.counterAccountId ?? "", amount: s.amount, description: s.description ?? "" })) ?? [blankSource()]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const withPolicy = (classes.data ?? []).filter((c) => c.isActive && c.policies.some((p) => p.status === "APPROVED"));
  const pol = (classes.data ?? []).find((c) => c.id === f.classId)?.policies.find((p) => p.status === "APPROVED");
  const lines = [...(billLines.data ?? []), ...(asset?.sources.filter((s) => s.billLineId).map((s) => ({ id: s.billLineId!, label: s.reference ?? "", net: s.amount, account: "", billDate: "" })) ?? [])];
  const cost = sources.reduce((s, x) => s + (Number(x.amount || (x.kind === "BILL_LINE" ? lines.find((l) => l.id === x.billLineId)?.net : 0) || 0)), 0);
  const deviates = !!pol && ((f.method && f.method !== pol.method) || (f.usefulLifeMonths && Number(f.usefulLifeMonths) !== pol.usefulLifeMonths) || (f.residualValue !== "" && Math.abs(Number(f.residualValue) - Math.round(cost * Number(pol.residualPercent)) / 100) > 0.004));
  const upd = (i: number, p: Partial<Src>) => setSources((s) => s.map((x, k) => (k === i ? { ...x, ...p } : x)));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { ...f, method: f.method || undefined, usefulLifeMonths: f.usefulLifeMonths || undefined, residualValue: f.residualValue || undefined, deviationReason: f.deviationReason || undefined,
        openingAccumulated: f.openingAccumulated || undefined, openingMonths: f.openingMonths || undefined, sources: sources.map((s) => ({ kind: s.kind, billLineId: s.billLineId || undefined, counterAccountId: s.counterAccountId || undefined, amount: s.amount || undefined, description: s.description || undefined })) };
      const out = await api<{ id: string }>(asset ? `/api/accounting/fixed-assets/${asset.id}` : "/api/accounting/fixed-assets", { method: asset ? "PATCH" : "POST", json: body });
      if (asset) onSaved?.(); else router.push(`/dashboard/accounting/assets/${out.id}`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    setBusy(false);
  };

  if (classes.error) return <ErrorState error={classes.error} onRetry={classes.reload} />;
  if (!classes.data || !accounts.data) return <LoadingState />;
  return (
    <div className="flex flex-col gap-3" data-testid="asset-editor">
      {withPolicy.length === 0 && <Notice tone="warn">{L("لا توجد فئة أصول بسياسة إهلاك معتمدة؛ أنشئ فئة واعتمد سياستها أولاً.", "No asset class has an approved depreciation policy; create a class and have its policy approved first.")}</Notice>}
      <div className="grid md:grid-cols-4 gap-3">
        <Field label={L("اسم الأصل", "Asset name")}><input aria-label={L("اسم الأصل", "Asset name")} className={INPUT} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={L("الفئة", "Class")}><select aria-label={L("الفئة", "Class")} className={INPUT} value={f.classId} onChange={(e) => setF({ ...f, classId: e.target.value })}><option value="">—</option>{withPolicy.map((c) => <option key={c.id} value={c.id}>{c.code} · {L(c.nameAr ?? c.name, c.name)}</option>)}</select></Field>
        <Field label={L("تاريخ بدء الخدمة", "In-service date")}><input aria-label={L("تاريخ بدء الخدمة", "In-service date")} type="date" className={INPUT} value={f.inServiceDate} onChange={(e) => setF({ ...f, inServiceDate: e.target.value })} /></Field>
        <Field label={L("الطريقة", "Method")} hint={pol ? L(`سياسة الفئة: ${METHOD[pol.method][0]}`, `Class policy: ${METHOD[pol.method][1]}`) : undefined}>
          <select aria-label={L("الطريقة", "Method")} className={INPUT} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="">{L("حسب الفئة", "As the class")}</option>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
        <Field label={L("العمر الإنتاجي (شهر)", "Useful life (months)")} hint={pol ? L(`سياسة الفئة: ${pol.usefulLifeMonths}`, `Class policy: ${pol.usefulLifeMonths}`) : undefined}><input aria-label={L("العمر الإنتاجي (شهر)", "Useful life (months)")} inputMode="numeric" className={INPUT} value={f.usefulLifeMonths} placeholder={pol ? String(pol.usefulLifeMonths) : ""} onChange={(e) => setF({ ...f, usefulLifeMonths: e.target.value })} /></Field>
        <Field label={L("القيمة المتبقية", "Residual value")} hint={pol ? L(`سياسة الفئة: ${pol.residualPercent}%`, `Class policy: ${pol.residualPercent}%`) : undefined}><input aria-label={L("القيمة المتبقية", "Residual value")} inputMode="decimal" className={INPUT} value={f.residualValue} placeholder={pol ? (Math.round(cost * Number(pol.residualPercent)) / 100).toFixed(2) : ""} onChange={(e) => setF({ ...f, residualValue: e.target.value })} /></Field>
        <Field label={L("إهلاك سابق (للأصول المنقولة عند البدء)", "Opening depreciation (assets brought in at cutover)")}><input aria-label={L("إهلاك سابق", "Opening depreciation")} inputMode="decimal" className={INPUT} value={f.openingAccumulated} onChange={(e) => setF({ ...f, openingAccumulated: e.target.value })} /></Field>
        <Field label={L("أشهر الإهلاك السابق", "Months already depreciated")}><input aria-label={L("أشهر الإهلاك السابق", "Months already depreciated")} inputMode="numeric" className={INPUT} value={f.openingMonths} onChange={(e) => setF({ ...f, openingMonths: e.target.value })} /></Field>
      </div>
      {deviates && (<>
        <Notice tone="warn">{L("يختلف الأصل عن سياسة الفئة المعتمدة — يظهر للمعتمد مع السبب", "The asset departs from the class's approved policy — the approver sees it with the reason")}</Notice>
        <Field label={L("سبب الاختلاف عن الفئة", "Reason for departing from the class")}><input aria-label={L("سبب الاختلاف عن الفئة", "Reason for departing from the class")} className={INPUT} value={f.deviationReason} onChange={(e) => setF({ ...f, deviationReason: e.target.value })} /></Field>
      </>)}
      <div className="flex items-center justify-between"><h3 className="font-extrabold text-[14px]">{L("مصادر التكلفة", "Cost sources")}</h3><span className="text-[13px] text-brown">{L("المجموع", "Total")}: <b>{amt(cost.toFixed(2))}</b></span></div>
      <Table>
        <thead><tr><Th>{L("النوع", "Kind")}</Th><Th>{L("المرجع / الحساب المقابل", "Reference / counter account")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{L("الوصف", "Description")}</Th><Th /></tr></thead>
        <tbody>{sources.map((s, i) => (
          <tr key={i} className="border-t border-border" data-testid={`source-${i}`}>
            <Td><select aria-label={L("نوع المصدر", "Source kind")} className={INPUT} value={s.kind} onChange={(e) => upd(i, { kind: e.target.value, billLineId: "", counterAccountId: "" })}>{Object.entries(SOURCE_KIND).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Td>
            <Td>{s.kind === "BILL_LINE" ? (
              <select aria-label={L("بند الفاتورة", "Bill line")} className={INPUT} value={s.billLineId} onChange={(e) => upd(i, { billLineId: e.target.value })}><option value="">—</option>{lines.map((l) => <option key={l.id} value={l.id}>{l.label} · {l.net}</option>)}</select>
            ) : s.kind === "ACCOUNT" ? (
              <select aria-label={L("الحساب المقابل", "Counter account")} className={INPUT} value={s.counterAccountId} onChange={(e) => upd(i, { counterAccountId: e.target.value })}><option value="">—</option>{(accounts.data ?? []).filter((a) => !["RECEIVABLE", "PAYABLE", "CASH", "COMMISSION_PAYABLE", "CUSTOMER_ADVANCES"].includes(a.controlKind)).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
            ) : <span className="text-brown text-[12px]">{L("على حساب الأصل أصلاً (مثل الرصيد الافتتاحي) — لا قيد", "Already on the asset account (e.g. the opening balance) — no entry")}</span>}</Td>
            <Td num><input aria-label={L("المبلغ", "Amount")} inputMode="decimal" className={INPUT} value={s.amount} placeholder={s.kind === "BILL_LINE" ? lines.find((l) => l.id === s.billLineId)?.net ?? "" : ""} onChange={(e) => upd(i, { amount: e.target.value })} /></Td>
            <Td><input aria-label={L("الوصف", "Description")} className={INPUT} value={s.description} onChange={(e) => upd(i, { description: e.target.value })} /></Td>
            <Td>{sources.length > 1 && <button type="button" aria-label={L("حذف المصدر", "Remove source")} onClick={() => setSources((x) => x.filter((_, k) => k !== i))}><Trash2 size={16} /></button>}</Td>
          </tr>))}</tbody>
      </Table>
      <div><Button icon={Plus} onClick={() => setSources((s) => [...s, blankSource()])}>{L("إضافة مصدر", "Add a source")}</Button></div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2 justify-end">
        {!asset && <Link href="/dashboard/accounting/assets"><Button>{L("إلغاء", "Cancel")}</Button></Link>}
        <Button kind="primary" busy={busy} onClick={save}>{asset ? L("حفظ المسودة", "Save draft") : L("تسجيل كمسودة", "Register as draft")}</Button>
      </div>
    </div>
  );
}

export function AssetDetail({ id }: { id: string }) {
  const { L } = useL();
  const day = useDay();
  const amt = useAmount();
  const { can, user } = useCan();
  const a = useApi<Asset>(`/api/accounting/fixed-assets/${id}`);
  const accounts = useApi<Acc[]>("/api/accounting/fixed-assets/pickers?what=accounts");
  const [busy, setBusy] = useState(""); const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [dlg, setDlg] = useState<null | { kind: "return" | "cancel" | "reverse-disposal"; id?: string }>(null);
  const [reason, setReason] = useState("");
  const [disposing, setDisposing] = useState(false);
  const [d, setD] = useState({ disposalDate: riyadhToday(), kind: "SALE", proceeds: "", proceedsAccountId: "", reason: "" });
  const x = a.data;
  const me = user?.id;
  const post = async (path: string, json: unknown = {}, done?: string) => {
    setBusy(path); setMsg(null);
    try {
      const out = await api<{ ledger?: { status: string; message?: string } | null }>(path, { method: "POST", json });
      setDlg(null); setReason(""); a.reload();
      const l = out?.ledger;
      if (l && (l.status === "BLOCKED" || l.status === "FAILED")) setMsg({ tone: "warn", text: L(`تمت العملية، لكن القيد لم يُرحَّل بعد: ${l.message ?? ""}`, `Done, but the journal has not posted yet: ${l.message ?? ""}`) });
      else if (done) setMsg({ tone: "ok", text: done });
      setBusy("");
      return true;
    } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy("");
    return false;
  };
  const proceedsAccounts = useMemo(() => (accounts.data ?? []).filter((c) => !["RECEIVABLE", "PAYABLE", "CASH", "COMMISSION_PAYABLE", "CUSTOMER_ADVANCES"].includes(c.controlKind)), [accounts.data]);
  const noteOf = (months: number, note: string | null) => [months > 1 ? L(`يشمل تعويض ${months - 1} شهر سابق`, `includes ${months - 1} earlier month(s)`) : "", note?.includes("last month") ? L("آخر شهر في العمر", "last month of life") : ""].filter(Boolean).join(" · ");
  if (a.error) return <ErrorState error={a.error} onRetry={a.reload} />;
  if (!x) return <LoadingState />;
  const own = x.preparedBy === me;
  const gain = d.proceeds === "" ? null : (Number(d.proceeds) - Number(x.nbv)).toFixed(2);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={`${x.number} · ${x.name}`} sub={L(`أعدّه: ${x.preparedByName ?? "—"}${x.approvedByName ? ` · رسمله: ${x.approvedByName} في ${day(x.capitalisedAt)}` : " · يعتمده ويُرسمله شخص آخر"}`, `Prepared by ${x.preparedByName ?? "—"}${x.approvedByName ? ` · capitalised by ${x.approvedByName} on ${day(x.capitalisedAt)}` : " · approved and capitalised by someone else"}`)}
          right={<><Pill map={ASSET_STATUS} v={x.status} /><Link href="/dashboard/accounting/assets"><Button>{L("السجل", "Register")}</Button></Link></>} />
        {msg && !(disposing && msg.tone === "bad") && !(dlg && msg.tone === "bad") && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {x.status === "DRAFT" && can("fa_prepare") ? <AssetEditor asset={x} onSaved={() => { a.reload(); setMsg({ tone: "ok", text: L("حُفظت المسودة.", "Draft saved.") }); }} /> : (
          <div className="grid md:grid-cols-4 gap-3 text-[13px]">
            <Info k={L("الفئة", "Class")} v={`${x.class.code} · ${x.class.name}`} />
            <Info k={L("تاريخ بدء الخدمة", "In-service date")} v={day(x.inServiceDate)} />
            <Info k={L("الطريقة", "Method")} v={`${L(METHOD[x.method][0], METHOD[x.method][1])}${x.decliningFactor ? ` ×${x.decliningFactor}` : ""} · ${L(START[x.startConvention][0], START[x.startConvention][1])}`} />
            <Info k={L("العمر الإنتاجي (شهر)", "Useful life (months)")} v={`${x.usefulLifeMonths}${x.policy && x.policy.usefulLifeMonths !== x.usefulLifeMonths ? L(` · سياسة الفئة ${x.policy.usefulLifeMonths}`, ` · class policy ${x.policy.usefulLifeMonths}`) : ""}`} />
            <Info k={L("التكلفة", "Cost")} v={amt(x.cost)} />
            <Info k={L("القيمة المتبقية", "Residual value")} v={amt(x.residualValue)} />
            <Info k={L("مجمع الإهلاك", "Accumulated")} v={amt(x.accumulated)} />
            <Info k={L("صافي القيمة الدفترية", "Net book value")} v={amt(x.nbv)} />
            {x.openingMonths > 0 && <Info k={L("إهلاك سابق", "Opening depreciation")} v={`${amt(x.openingAccumulated)} · ${x.openingMonths} ${L("شهر", "months")}`} />}
            <Info k={L("شهر الاستبعاد", "Disposal month")} v={L(DISPOSAL_MONTH[x.disposalConvention][0], DISPOSAL_MONTH[x.disposalConvention][1])} />
          </div>)}
        {x.deviationReason && x.status !== "DRAFT" && <Notice tone="warn">{L(`يختلف عن سياسة الفئة — السبب: ${x.deviationReason}`, `Departs from the class policy — reason: ${x.deviationReason}`)}</Notice>}
        {x.status !== "DRAFT" && (<>
          <h3 className="font-extrabold text-[14px]">{L("مصادر التكلفة", "Cost sources")}</h3>
          <Table>
            <thead><tr><Th>{L("النوع", "Kind")}</Th><Th>{L("المرجع", "Reference")}</Th><Th>{L("الحساب الحالي", "Where it sits")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{L("أثر الرسملة", "On capitalisation")}</Th></tr></thead>
            <tbody>{x.sources.map((s) => (
              <tr key={s.lineNo} className="border-t border-border"><Td>{L(SOURCE_KIND[s.kind][0], SOURCE_KIND[s.kind][1])}</Td><Td>{s.reference ?? "—"}</Td><Td>{s.counter ? `${s.counter.code} · ${s.counter.name}` : x.class.cost?.code ?? "—"}</Td><Td num>{amt(s.amount)}</Td>
                <Td>{s.postsOnCapitalisation ? L(`مدين ${x.class.cost?.code} / دائن ${s.counter?.code}`, `Dr ${x.class.cost?.code} / Cr ${s.counter?.code}`) : L("لا قيد: التكلفة على حساب الأصل أصلاً", "No entry: already on the asset account")}</Td></tr>))}</tbody>
          </Table>
        </>)}
        <div className="flex gap-2 justify-end flex-wrap">
          {x.status === "DRAFT" && can("fa_prepare") && <Button kind="primary" busy={busy.endsWith("submit")} onClick={() => post(`/api/accounting/fixed-assets/${x.id}/submit`, {}, L("قُدّم الأصل للاعتماد.", "Submitted for approval."))}>{L("تقديم للاعتماد", "Submit for approval")}</Button>}
          {x.status === "SUBMITTED" && can("fa_approve") && !own && <>
            <Button onClick={() => { setReason(""); setDlg({ kind: "return" }); }}>{L("إرجاع للتعديل", "Return for changes")}</Button>
            <Button kind="primary" busy={busy.endsWith("capitalise")} onClick={() => post(`/api/accounting/fixed-assets/${x.id}/capitalise`, {}, L("اعتُمد الأصل ورُسمل.", "Approved and capitalised."))}>{L("اعتماد ورسملة", "Approve and capitalise")}</Button></>}
          {x.status === "SUBMITTED" && own && <span className="text-[12px] text-brown">{L("أنت أعددت هذا الأصل؛ يعتمده شخص آخر.", "You prepared this asset; someone else approves it.")}</span>}
          {x.status === "CAPITALISED" && can("fa_approve") && !own && x.depreciation.every((l) => ["REVERSED", "CANCELLED"].includes(l.status)) && <Button onClick={() => { setReason(""); setDlg({ kind: "cancel" }); }}>{L("إلغاء الرسملة", "Cancel capitalisation")}</Button>}
          {x.status === "CAPITALISED" && can("fa_prepare") && !x.disposals.some((q) => q.status === "DRAFT") && <Button kind="primary" onClick={() => { setDisposing(true); setMsg(null); }}>{L("استبعاد الأصل…", "Dispose of the asset…")}</Button>}
        </div>
      </Card>

      {disposing && (
        <Card>
          <CardTitle title={L(`استبعاد أصل — ${x.number} · ${x.name}`, `Dispose of ${x.number} · ${x.name}`)} sub={L("بيع أو إتلاف أو شطب · يعتمده شخص غير المُعِدّ", "Sale, scrap or write-off · approved by someone other than the preparer")} />
          <div className="grid md:grid-cols-5 gap-3">
            <Field label={L("تاريخ الاستبعاد", "Disposal date")}><input aria-label={L("تاريخ الاستبعاد", "Disposal date")} type="date" className={INPUT} value={d.disposalDate} onChange={(e) => setD({ ...d, disposalDate: e.target.value })} /></Field>
            <Field label={L("النوع", "Kind")}><select aria-label={L("نوع الاستبعاد", "Disposal kind")} className={INPUT} value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value, proceeds: e.target.value === "SALE" ? d.proceeds : "" })}>{Object.entries(DISPOSAL_KIND).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
            <Field label={L("المتحصلات (صافي، دون ضريبة)", "Proceeds (net of VAT)")}><input aria-label={L("المتحصلات", "Proceeds")} inputMode="decimal" className={INPUT} disabled={d.kind !== "SALE"} value={d.proceeds} onChange={(e) => setD({ ...d, proceeds: e.target.value })} /></Field>
            <Field label={L("حساب المتحصلات", "Proceeds account")} hint={L("لا تُقبل حسابات البنك أو حسابات مراقبة العملاء", "Bank accounts and customer controls are not accepted")}><select aria-label={L("حساب المتحصلات", "Proceeds account")} className={INPUT} disabled={d.kind !== "SALE"} value={d.proceedsAccountId} onChange={(e) => setD({ ...d, proceedsAccountId: e.target.value })}><option value="">—</option>{proceedsAccounts.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></Field>
            <Field label={L("السبب", "Reason")}><input aria-label={L("سبب الاستبعاد", "Disposal reason")} className={INPUT} value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} /></Field>
          </div>
          <Table>
            <tbody>
              <tr className="border-t border-border"><Td>{L("التكلفة", "Cost")}</Td><Td num>{amt(x.cost)}</Td></tr>
              <tr className="border-t border-border"><Td>{L("مجمع الإهلاك حتى الآن", "Accumulated so far")}</Td><Td num>{amt(x.accumulated)}</Td></tr>
              <tr className="border-t border-border"><Td>{L("صافي القيمة الدفترية", "Net book value")}</Td><Td num>{amt(x.nbv)}</Td></tr>
              {gain !== null && <tr className="border-t border-border bg-cream"><Td><b>{Number(gain) >= 0 ? L("ربح الاستبعاد (تقديري)", "Gain (estimate)") : L("خسارة الاستبعاد (تقديرية)", "Loss (estimate)")}</b></Td><Td num><b>{amt(gain.replace("-", ""))}</b></Td></tr>}
            </tbody>
          </Table>
          {msg?.tone === "bad" && <Notice tone="bad">{msg.text}</Notice>}
          <Notice tone="info">{L("يُحسب المجمّع وصافي القيمة والربح أو الخسارة نهائياً عند الاعتماد. يجب أن يكون الإهلاك مرحّلاً حتى الشهر السابق للاستبعاد (أو شهر الاستبعاد حسب سياسة الفئة).", "The accumulated depreciation, NBV and gain or loss are fixed at approval. Depreciation must have posted up to the month before the disposal (or the disposal month, by the class's policy).")}</Notice>
          <div className="flex gap-2 justify-end">
            <Button onClick={() => setDisposing(false)}>{L("إلغاء", "Cancel")}</Button>
            <Button kind="primary" busy={busy.endsWith("disposals")} onClick={async () => { if (await post("/api/accounting/fixed-assets/disposals", { assetId: x.id, ...d }, L("سُجّل الاستبعاد؛ بانتظار اعتماد شخص آخر.", "Disposal recorded; waiting for someone else to approve it."))) setDisposing(false); }}>{L("تقديم للاعتماد", "Submit for approval")}</Button>
          </div>
        </Card>)}

      {x.disposals.length > 0 && (
        <Card>
          <CardTitle title={L("الاستبعاد", "Disposal")} />
          <Table>
            <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("النوع", "Kind")}</Th><Th num>{L("المتحصلات", "Proceeds")}</Th><Th num>{L("صافي القيمة", "NBV")}</Th><Th num>{L("ربح / (خسارة)", "Gain / (loss)")}</Th><Th>{L("أعدّه / اعتمده", "Prepared / approved")}</Th><Th>{L("الحالة", "Status")}</Th><Th>{L("إجراء", "Action")}</Th></tr></thead>
            <tbody>{x.disposals.map((q) => (
              <tr key={q.id} className="border-t border-border" data-testid={`disposal-${q.status}`}>
                <Td>{day(q.disposalDate)}</Td><Td>{L(DISPOSAL_KIND[q.kind][0], DISPOSAL_KIND[q.kind][1])}{q.proceedsAccount && <span className="block text-[11px] text-brown">{q.proceedsAccount.code} · {q.proceedsAccount.name}</span>}</Td>
                <Td num>{amt(q.proceeds)}</Td><Td num>{q.nbv ? amt(q.nbv) : "—"}</Td><Td num>{q.gainLoss ? amt(q.gainLoss) : "—"}</Td>
                <Td>{q.preparedByName ?? "—"} / {q.approvedByName ?? "—"}</Td>
                <Td><Pill map={{ ...DOC_STATUS, DRAFT: ["بانتظار الاعتماد", "Awaiting approval", "warn"] }} v={q.status} />{q.reversalReason && <span className="block text-[11px] text-brown">{q.reversalReason}</span>}</Td>
                <Td><div className="flex gap-1 flex-wrap">
                  {q.status === "DRAFT" && can("fa_approve") && q.preparedBy !== me && <Button kind="primary" busy={busy.includes(q.id)} onClick={() => post(`/api/accounting/fixed-assets/disposals/${q.id}/approve`, {}, L("اعتُمد الاستبعاد ورُحّل.", "Disposal approved and posted."))}>{L("اعتماد وترحيل", "Approve and post")}</Button>}
                  {q.status === "DRAFT" && can("fa_prepare") && <Button onClick={() => post(`/api/accounting/fixed-assets/disposals/${q.id}/discard`)}>{L("إلغاء", "Discard")}</Button>}
                  {q.status === "POSTED" && can("fa_prepare") && <Button onClick={() => { setReason(""); setDlg({ kind: "reverse-disposal", id: q.id }); }}>{L("طلب عكس الاستبعاد", "Request reversal")}</Button>}
                  {q.status === "REVERSAL_REQUESTED" && can("fa_approve") && q.reversalRequestedBy !== me && <>
                    <Button kind="primary" onClick={() => post(`/api/accounting/fixed-assets/disposals/${q.id}/reversal-decision`, { approve: true }, L("عُكس الاستبعاد؛ الأصل مُرسمل من جديد.", "Disposal reversed; the asset is capitalised again."))}>{L("اعتماد العكس", "Approve reversal")}</Button>
                    <Button onClick={() => post(`/api/accounting/fixed-assets/disposals/${q.id}/reversal-decision`, { approve: false })}>{L("رفض", "Reject")}</Button></>}
                </div></Td>
              </tr>))}</tbody>
          </Table>
        </Card>)}

      {(x.depreciation.length > 0 || x.schedule.length > 0) && (
        <Card>
          <CardTitle title={L("الإهلاك", "Depreciation")} sub={L("المرحّل، ثم الجدول المتوقع للأشهر القادمة", "Posted, then the expected schedule for the coming months")} />
          <Table>
            <thead><tr><Th>{L("الشهر", "Month")}</Th><Th num>{L("إهلاك الشهر", "Charge")}</Th><Th num>{L("المجمع", "Accumulated")}</Th><Th num>{L("صافي القيمة", "NBV")}</Th><Th>{L("ملاحظة", "Note")}</Th><Th>{L("الحالة", "Status")}</Th></tr></thead>
            <tbody>
              {x.depreciation.map((l) => <tr key={l.runId} className="border-t border-border"><Td>{l.period}</Td><Td num>{amt(l.amount)}</Td><Td num>{amt(l.accumulatedAfter)}</Td><Td num>{amt(l.nbvAfter)}</Td><Td>{noteOf(l.months, l.note)}</Td><Td><Link className="text-orange hover:underline" href={`/dashboard/accounting/assets/runs?run=${l.runId}`}>#{l.runNo}</Link> <Pill map={DOC_STATUS} v={l.status} /></Td></tr>)}
              {x.schedule.map((s) => <tr key={s.month} className="border-t border-border text-brown"><Td>{s.month}</Td><Td num>{amt(s.amount)}</Td><Td num>{amt(s.accumulated)}</Td><Td num>{amt(s.nbv)}</Td><Td>{noteOf(1, s.note)}</Td><Td>{L("متوقع", "Expected")}</Td></tr>)}
            </tbody>
          </Table>
        </Card>)}

      {x.ledger.length > 0 && (
        <Card>
          <CardTitle title={L("الأثر في الحسابات", "In the accounts")} />
          <ul className="flex flex-col gap-1 text-[13px]">{x.ledger.map((e, i) => <li key={i} className="flex gap-2 items-center"><Pill map={LEDGER} v={e.status} /> <span>{e.eventType}</span>{e.message && <span className="text-brown">· {e.message}</span>}</li>)}</ul>
        </Card>)}

      <Dialog open={!!dlg} onClose={() => setDlg(null)} title={dlg?.kind === "return" ? L("إرجاع للتعديل", "Return for changes") : dlg?.kind === "cancel" ? L("إلغاء الرسملة", "Cancel capitalisation") : L("طلب عكس الاستبعاد", "Request reversal of the disposal")}>
        <Field label={L("السبب", "Reason")}><textarea aria-label={L("السبب", "Reason")} className={INPUT} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {msg?.tone === "bad" && <Notice tone="bad">{msg.text}</Notice>}
        <div className="flex gap-2 justify-end mt-3">
          <Button onClick={() => setDlg(null)}>{L("إغلاق", "Close")}</Button>
          <Button kind="primary" onClick={() => {
            if (dlg?.kind === "return") post(`/api/accounting/fixed-assets/${x.id}/return`, { reason }, L("أُرجع الأصل للتعديل.", "Returned for changes."));
            else if (dlg?.kind === "cancel") post(`/api/accounting/fixed-assets/${x.id}/cancel`, { reason }, L("أُلغيت الرسملة وعُكس قيدها.", "Capitalisation cancelled and its journal reversed."));
            else if (dlg?.id) post(`/api/accounting/fixed-assets/disposals/${dlg.id}/reverse`, { reason }, L("طُلب عكس الاستبعاد؛ يقرّه شخص آخر.", "Reversal requested; someone else decides it."));
          }}>{L("تأكيد", "Confirm")}</Button>
        </div>
      </Dialog>
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return <div><div className="text-[12px] font-bold text-brown">{k}</div><div className="mt-1 font-medium">{v}</div></div>;
}
