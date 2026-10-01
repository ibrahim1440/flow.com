"use client";

// Seller profile for e-invoicing (Figma ACC-71): entered by one person, approved by another; an
// approved version never changes. Environment LOCAL_ONLY (nothing sent) or SANDBOX (a test target
// configured on the server); production is not available in this branch.
import { useState } from "react";
import { api, ApiError, Badge, Button, Card, CardTitle, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, useApi, useL } from "../../../finance/_components/ui";
import { useCan, useDay } from "../../_components/kit";
import { LocalOnlyBanner, TaxNav } from "../_ui";

type Profile = { id: string; version: number; status: string; sellerName: string; sellerNameEn: string | null; vatNumber: string; crNumber: string; street: string; buildingNo: string; district: string; city: string; postalCode: string; countryCode: string; egsSerial: string; environment: string; preparedBy: string; approvedBy: string | null; approvedAt: string | null };
const FIELDS: [keyof Profile, string, string, number][] = [["sellerName", "الاسم القانوني", "Legal name", 260], ["vatNumber", "الرقم الضريبي", "VAT number", 200], ["crNumber", "السجل التجاري", "Commercial registration", 180], ["egsSerial", "وحدة إصدار الفواتير (EGS)", "Invoice generation unit (EGS)", 200],
  ["street", "الشارع", "Street", 200], ["buildingNo", "رقم المبنى", "Building no.", 120], ["district", "الحي", "District", 160], ["city", "المدينة", "City", 140], ["postalCode", "الرمز البريدي", "Postal code", 120], ["countryCode", "الدولة", "Country", 80]];
const blank = { sellerName: "", sellerNameEn: "", vatNumber: "", crNumber: "", street: "", buildingNo: "", district: "", city: "", postalCode: "", countryCode: "SA", egsSerial: "", environment: "LOCAL_ONLY" };

export default function SellerProfilePage() {
  const { L } = useL();
  const day = useDay();
  const { can, user } = useCan();
  const list = useApi<Profile[]>("/api/accounting/tax/profile");
  const [f, setF] = useState<typeof blank | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const approved = list.data?.find((p) => p.status === "APPROVED");
  const draft = list.data?.find((p) => p.status === "DRAFT");
  const shown = draft ?? approved;
  const act = async (fn: () => Promise<unknown>, done: string) => { setBusy(true); setMsg(null); try { await fn(); setF(null); list.reload(); setMsg({ tone: "ok", text: done }); } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); } setBusy(false); };

  return (
    <div className="flex flex-col gap-4">
      <TaxNav />
      <Card>
        <CardTitle title={L("ملف البائع للفوترة الإلكترونية", "E-invoicing seller profile")} sub={L("بيانات الشركة يدخلها المسؤول ويعتمدها شخص آخر؛ القيم في البيئة المحلية تجريبية وليست بيانات الشركة", "Company data entered by one person and approved by another; values in the local environment are synthetic, not the company's")}
          right={shown ? (shown.status === "DRAFT" ? <Badge tone="warn">{L(`v${shown.version} مسودة — بانتظار اعتماد شخص آخر`, `v${shown.version} draft — awaiting someone else's approval`)}</Badge> : <Badge tone="ok">{L(`v${shown.version} معتمد`, `v${shown.version} approved`)}</Badge>) : <Badge tone="bad">{L("لا ملف — لا يُنشأ أي مستند", "No profile — nothing is generated")}</Badge>} />
        <LocalOnlyBanner />
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <LoadingState /> : f ? (
          <div className="flex flex-col gap-3" data-testid="profile-form">
            <div className="flex flex-wrap gap-3">{FIELDS.map(([k, ar, en]) => <Field key={k} label={L(ar, en)}><input aria-label={L(ar, en)} className={INPUT} value={String(f[k as keyof typeof blank] ?? "")} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}</div>
            <Field label={L("بيئة الإرسال", "Submission environment")} hint={L("الإنتاج غير متاح في هذا الفرع", "Production is not available in this branch")}>
              <select aria-label={L("بيئة الإرسال", "Submission environment")} className={INPUT} value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}>
                <option value="LOCAL_ONLY">{L("محلي فقط (لا إرسال)", "Local only (nothing sent)")}</option>
                <option value="SANDBOX">{L("بيئة اختبار (تتطلب CSID اختبار وعنواناً مسموحاً على الخادم)", "Test environment (needs a test CSID and an allowed URL on the server)")}</option>
              </select></Field>
            <div className="flex gap-2 justify-end"><Button onClick={() => setF(null)}>{L("إلغاء", "Cancel")}</Button><Button kind="primary" busy={busy} onClick={() => act(() => api("/api/accounting/tax/profile", { method: "POST", json: f }), L("أُعدّ الملف؛ بانتظار اعتماد شخص آخر.", "Profile prepared; waiting for someone else to approve it."))}>{L("إعداد الملف", "Prepare the profile")}</Button></div>
          </div>
        ) : shown ? (<>
          <Table>
            <tbody>{FIELDS.map(([k, ar, en]) => <tr key={k} className="border-t border-border"><Td><b>{L(ar, en)}</b></Td><Td>{String(shown[k])}</Td></tr>)}
              <tr className="border-t border-border"><Td><b>{L("بيئة الإرسال", "Submission environment")}</b></Td><Td>{shown.environment === "LOCAL_ONLY" ? L("محلي فقط (لا إرسال)", "Local only (nothing sent)") : L("بيئة اختبار", "Test environment")}</Td></tr>
              <tr className="border-t border-border"><Td><b>{L("الإنتاج", "Production")}</b></Td><Td>{L("ممنوع في هذا الفرع — لا يوجد إعداد يسمح به", "Refused in this branch — no setting allows it")}</Td></tr>
              {shown.approvedAt && <tr className="border-t border-border"><Td><b>{L("اعتُمد", "Approved")}</b></Td><Td>{day(shown.approvedAt)}</Td></tr>}</tbody>
          </Table>
          <div className="flex gap-2 justify-end flex-wrap">
            {draft && can("einv_profile_prepare") && <Button onClick={() => act(() => api(`/api/accounting/tax/profile/${draft.id}/discard`, { method: "POST", json: {} }), L("أُلغيت المسودة.", "Draft discarded."))}>{L("إلغاء المسودة", "Discard draft")}</Button>}
            {draft && can("einv_profile_approve") && draft.preparedBy !== user?.id && <Button kind="primary" busy={busy} onClick={() => act(() => api(`/api/accounting/tax/profile/${draft.id}/approve`, { method: "POST", json: {} }), L("اعتُمد الملف.", "Profile approved."))}>{L("اعتماد الملف", "Approve the profile")}</Button>}
            {draft && draft.preparedBy === user?.id && <span className="text-[12px] text-brown">{L("أنت أعددت هذا الإصدار؛ يعتمده شخص آخر.", "You prepared this version; someone else approves it.")}</span>}
            {!draft && can("einv_profile_prepare") && <Button kind="primary" onClick={() => setF(approved ? { ...blank, ...Object.fromEntries(Object.keys(blank).map((k) => [k, String((approved as unknown as Record<string, unknown>)[k] ?? "")])) } as typeof blank : { ...blank })}>{L("إصدار جديد", "New version")}</Button>}
          </div></>
        ) : can("einv_profile_prepare") ? <Button kind="primary" onClick={() => setF({ ...blank })}>{L("إعداد ملف البائع", "Prepare the seller profile")}</Button> : null}
      </Card>
    </div>
  );
}
