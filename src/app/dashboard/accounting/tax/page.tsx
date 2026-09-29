"use client";

// E-invoices (Figma ACC-70): every posted sales document with its e-invoice, chain position,
// local validation and submission attempts. LOCAL ONLY — nothing is sent to ZATCA.
import { useState } from "react";
import Link from "next/link";
import { api, ApiError, Badge, Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../finance/_components/ui";
import { useAmount, useCan, useDay } from "../_components/kit";
import { JOB, LocalOnlyBanner, OUTCOME, SUBTYPE, TYPE, TaxNav } from "./_ui";

type Rule = { id: string; ok: boolean; en: string; ar: string; detail?: string };
type Row = { salesInvoiceId: string; customerId: string; nationalAddress: Record<string, string> | null; doc: string; kind: string; debitNote: boolean; status: string; customer: string; gross: string; issueDate: string; reversedAfterIssue: boolean;
  einvoice: { id: string; icv: number; typeCode: string; subtype: string; valid: boolean; failed: number; lastSubmission: { outcome: string; attempt: number; environment: string } | null } | null;
  job: { status: string; attempts: number; errors: Rule[] | { message: string }[] | null } | null };
type Detail = { id: string; doc: string; customer: string; uuid: string; icv: number; typeCode: string; subtype: string; invoiceHash: string; previousHash: string; qr: string | null; signer: string; validation: Rule[]; standardsGaps: { id: string; en: string; ar: string }[]; issueDay: string; gross: string; vat: string;
  submissions: { attempt: number; environment: string; endpoint: string | null; outcome: string; httpStatus: number | null; response: unknown; nextAttemptAt: string | null; createdAt: string }[] };

export default function EInvoicesPage() {
  const { L } = useL();
  const amt = useAmount();
  const day = useDay();
  const { can } = useCan();
  const list = useApi<Row[]>("/api/accounting/tax/einvoices");
  const [open, setOpen] = useState<string | null>(null);
  const det = useApi<Detail>(open ? `/api/accounting/tax/einvoices/${open}` : null);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const act = async (key: string, fn: () => Promise<unknown>, done: (r: unknown) => string) => {
    setBusy(key); setMsg(null);
    try { const r = await fn(); list.reload(); det.reload(); setMsg({ tone: "ok", text: done(r) }); } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy("");
  };
  const [addr, setAddr] = useState<null | { row: Row; f: Record<string, string> }>(null);
  const ADDR_FIELDS: [string, string, string][] = [["street", "الشارع", "Street"], ["buildingNo", "رقم المبنى", "Building no."], ["district", "الحي", "District"], ["city", "المدينة", "City"], ["postalCode", "الرمز البريدي", "Postal code"], ["countryCode", "الدولة", "Country"]];
  const d = det.data;
  const shownRules = rules ?? d?.validation ?? [];

  return (
    <div className="flex flex-col gap-4">
      <TaxNav />
      <Card>
        <CardTitle title={L("الفواتير الإلكترونية", "E-invoices")} sub={L("لكل فاتورة وإشعار مرحّل: المستند الإلكتروني وتسلسله وتحققه المحلي · بيانات تجريبية في البيئة المحلية", "For each posted invoice and note: its e-invoice, chain position and local validation · synthetic data locally")} />
        <LocalOnlyBanner />
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <LoadingState /> : list.data.length === 0 ? <EmptyState title={L("لا مستندات مرحّلة بعد", "No posted documents yet")} /> : (
          <Table>
            <thead><tr><Th>{L("المستند", "Document")}</Th><Th>{L("العميل", "Customer")}</Th><Th>{L("النوع", "Type")}</Th><Th num>ICV</Th><Th num>{L("الإجمالي", "Total")}</Th><Th>{L("التحقق المحلي", "Local validation")}</Th><Th>{L("الإرسال", "Submission")}</Th><Th>{L("إجراء", "Action")}</Th></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.salesInvoiceId} className="border-t border-border" data-testid={`einv-${r.doc}`}>
                <Td><Link className="font-bold text-orange hover:underline" href={`/dashboard/accounting/receivables/${r.salesInvoiceId}`}>{r.doc}</Link><span className="block text-[11px] text-brown">{day(r.issueDate)}</span></Td>
                <Td>{r.customer}</Td>
                <Td>{r.einvoice ? `${L(TYPE[r.einvoice.typeCode][0], TYPE[r.einvoice.typeCode][1])} · ${L(SUBTYPE[r.einvoice.subtype][0], SUBTYPE[r.einvoice.subtype][1])} ${r.einvoice.typeCode}` : "—"}</Td>
                <Td num>{r.einvoice?.icv ?? "—"}</Td>
                <Td num>{r.kind === "CREDIT_NOTE" ? `(${amt(r.gross)})` : amt(r.gross)}</Td>
                <Td>{r.einvoice ? (r.einvoice.valid ? <Badge tone="ok">{L("صالح محلياً", "Valid locally")}</Badge> : <Badge tone="bad">{L(`مخالف: ${r.einvoice.failed} قاعدة`, `Invalid: ${r.einvoice.failed} rule(s)`)}</Badge>)
                  : r.job ? <><Badge tone={JOB[r.job.status]?.[2] ?? "info"}>{L(JOB[r.job.status]?.[0] ?? r.job.status, JOB[r.job.status]?.[1] ?? r.job.status)}</Badge>
                    {Array.isArray(r.job.errors) && r.job.errors.length > 0 && <span className="block text-[11px] text-red-700 mt-1">{(r.job.errors as Rule[]).map((e) => e.id ? `${e.id}: ${L(e.ar, e.en)}` : (e as unknown as { message: string }).message).join(" · ")}</span>}</>
                  : <Badge tone="info">{L("لم يُنشأ", "Not generated")}</Badge>}
                  {r.reversedAfterIssue && <span className="block text-[11px] text-amber-700 mt-1">{L("عُكست في الدفاتر بعد إصدارها — يلزم إشعار دائن إلكتروني", "Reversed in the ledger after issue — an e-invoiced credit note is needed")}</span>}</Td>
                <Td>{r.einvoice?.lastSubmission ? <Badge tone={OUTCOME[r.einvoice.lastSubmission.outcome]?.[2] ?? "info"}>{L(OUTCOME[r.einvoice.lastSubmission.outcome]?.[0] ?? "", OUTCOME[r.einvoice.lastSubmission.outcome]?.[1] ?? "")}</Badge> : <span className="text-[12px] text-brown">{L("غير مُرسل — محلي فقط", "Not sent — local only")}</span>}</Td>
                <Td><div className="flex gap-1 flex-wrap">
                  {r.einvoice && <Button onClick={() => { setRules(null); setOpen(r.einvoice!.id); }}>{L("التفاصيل", "Details")}</Button>}
                  {!r.einvoice && r.job?.status === "INVALID" && can("ar_invoice_create") && Array.isArray(r.job.errors) && (r.job.errors as Rule[]).some((e) => e.id === "LOCAL-BUYER-ADDR") &&
                    <Button onClick={() => setAddr({ row: r, f: { street: "", buildingNo: "", district: "", city: "", postalCode: "", countryCode: "SA", ...(r.nationalAddress ?? {}) } })}>{L("عنوان المشتري…", "Buyer address…")}</Button>}
                  {!r.einvoice && can("einv_generate") && <Button kind="primary" busy={busy === r.salesInvoiceId} onClick={() => act(r.salesInvoiceId, () => api("/api/accounting/tax/einvoices/generate", { method: "POST", json: { salesInvoiceId: r.salesInvoiceId } }), (x) => { const s = (x as { status: string }).status; return s === "GENERATED" ? L("أُنشئ المستند الإلكتروني.", "E-invoice generated.") : L(`لم يُنشأ: ${JOB[s]?.[0] ?? s}`, `Not generated: ${JOB[s]?.[1] ?? s}`); })}>{L("إنشاء / إعادة المحاولة", "Generate / retry")}</Button>}
                </div></Td>
              </tr>))}</tbody>
          </Table>)}
      </Card>
      {open && (d ? (
        <Card>
          <CardTitle title={`${d.doc} · ${L(TYPE[d.typeCode][0], TYPE[d.typeCode][1])} ${L(SUBTYPE[d.subtype][0], SUBTYPE[d.subtype][1])}`}
            sub={`UUID ${d.uuid} · ICV ${d.icv} · ${L("أُنشئ عند الترحيل ولا يتغير", "created at posting; never changes")}`}
            right={shownRules.every((x) => x.ok) ? <Badge tone="ok">{L("صالح محلياً", "Valid locally")}</Badge> : <Badge tone="bad">{L("مخالف محلياً", "Invalid locally")}</Badge>} />
          <div className="grid md:grid-cols-3 gap-3 text-[13px]">
            <div><div className="text-[12px] font-bold">{L("تجزئة المستند (SHA-256)", "Document hash (SHA-256)")}</div><code className="block break-all text-[11px] mt-1" dir="ltr">{d.invoiceHash}</code><span className="text-[11px] text-brown">{L("فوق التمثيل المحدد بعد حذف التوقيع والامتداد — المطابقة مع C14N غير متحقق منها", "Over our deterministic serialisation without signature and extension — equivalence with C14N unverified")}</span></div>
            <div><div className="text-[12px] font-bold">{L("تجزئة المستند السابق (PIH)", "Previous-invoice hash (PIH)")}</div><code className="block break-all text-[11px] mt-1" dir="ltr">{d.previousHash}</code></div>
            <div><div className="text-[12px] font-bold">{L("التوقيع", "Signature")}</div><span className="block mt-1">{d.signer === "LOCAL_TEST_KEY" ? L(d.subtype === "0200000" ? "مفتاح اختبار محلي — ليس CSID" : "لا توقيع محلي (قياسية: الختم عند الاعتماد لدى الهيئة)", d.subtype === "0200000" ? "Local test key — not a CSID" : "No local signature (standard: stamped at clearance by ZATCA)") : d.signer}</span></div>
          </div>
          <Table>
            <thead><tr><Th>{L("القاعدة (محلية)", "Rule (local)")}</Th><Th>{L("الوصف", "Description")}</Th><Th>{L("النتيجة", "Result")}</Th></tr></thead>
            <tbody>{shownRules.map((x) => <tr key={x.id} className="border-t border-border"><Td><code dir="ltr">{x.id}</code></Td><Td>{L(x.ar, x.en)}{x.detail && !x.ok && <span className="block text-[11px] text-red-700">{x.detail}</span>}</Td><Td>{x.ok ? <Badge tone="ok">✓</Badge> : <Badge tone="bad">✗</Badge>}</Td></tr>)}</tbody>
          </Table>
          <Notice tone="bad"><strong>{L("غير مطابق للمعيار — تحقق محلي فقط:", "Not standards-compliant — local validation only:")}</strong>
            <ul className="list-disc ps-5 mt-1">{(d.standardsGaps ?? []).map((g) => <li key={g.id}>{L(g.ar, g.en)}</li>)}</ul></Notice>
          <Notice tone="warn">{L("رموز القواعد محلية؛ ربطها برموز BR-KSA الرسمية ينتظر قراءة قاموس البيانات الرسمي والتحقق بأداة الهيئة (SDK).", "Rule codes are local; mapping them to the official BR-KSA codes awaits the official data dictionary and validation with ZATCA's SDK.")}</Notice>
          <h3 className="font-extrabold text-[14px]">{L("محاولات الإرسال", "Submission attempts")}</h3>
          <Table>
            <thead><tr><Th>{L("المحاولة", "Attempt")}</Th><Th>{L("البيئة", "Environment")}</Th><Th>{L("النتيجة", "Result")}</Th><Th>{L("الوقت", "Time")}</Th></tr></thead>
            <tbody>{d.submissions.length === 0 ? <tr className="border-t border-border"><Td>—</Td><Td>{L("لا بيئة مفعّلة", "No environment enabled")}</Td><Td>{L("لم يُرسل", "Not sent")}</Td><Td>—</Td></tr>
              : d.submissions.map((s) => <tr key={s.attempt} className="border-t border-border"><Td num>{s.attempt}</Td><Td>{s.environment}{s.endpoint ? <span className="block text-[11px] text-brown" dir="ltr">{s.endpoint}</span> : null}</Td><Td><Badge tone={OUTCOME[s.outcome]?.[2] ?? "info"}>{L(OUTCOME[s.outcome]?.[0] ?? s.outcome, OUTCOME[s.outcome]?.[1] ?? s.outcome)}</Badge>{s.httpStatus ? ` · HTTP ${s.httpStatus}` : ""}<span className="block text-[11px] text-brown">{s.outcome === "NOT_SENT" && s.environment === "LOCAL_ONLY" ? L("الإرسال معطّل: الملف المعتمد «محلي فقط». لم يُرسل شيء إلى الهيئة.", "Submission is disabled: the approved profile is LOCAL_ONLY. Nothing was sent to ZATCA.")
                : typeof s.response === "object" && s.response && "reason" in (s.response as object) ? String((s.response as { reason: string }).reason) : ""}</span></Td><Td>{new Date(s.createdAt).toISOString().slice(0, 16).replace("T", " ")}</Td></tr>)}</tbody>
          </Table>
          <div className="flex gap-2 justify-end flex-wrap">
            <a href={`/api/accounting/tax/einvoices/${d.id}/xml`}><Button>{L("تنزيل XML", "Download XML")}</Button></a>
            {can("einv_submit") && <Button busy={busy === "submit"} onClick={() => act("submit", () => api(`/api/accounting/tax/einvoices/${d.id}/submit`, { method: "POST", json: {} }), (x) => { const o = (x as { outcome: string }).outcome; return L(`سُجّلت المحاولة: ${OUTCOME[o]?.[0] ?? o}`, `Attempt recorded: ${OUTCOME[o]?.[1] ?? o}`); })}>{L("إرسال (بيئة اختبار فقط)", "Submit (test environment only)")}</Button>}
            {can("einv_generate") && <Button kind="primary" busy={busy === "reval"} onClick={() => act("reval", async () => { const r = await api<Rule[]>(`/api/accounting/tax/einvoices/${d.id}/revalidate`, { method: "POST", json: {} }); setRules(r); return r; }, (r) => (r as Rule[]).every((x) => x.ok) ? L("أعيد التحقق محلياً: كل القواعد متحققة.", "Re-validated locally: all rules pass.") : L("أعيد التحقق محلياً: توجد مخالفات.", "Re-validated locally: some rules fail."))}>{L("إعادة التحقق محلياً", "Re-validate locally")}</Button>}
          </div>
        </Card>) : det.error ? <ErrorState error={det.error} onRetry={det.reload} /> : <LoadingState />)}
      <Dialog open={!!addr} onClose={() => setAddr(null)} title={L("العنوان الوطني للمشتري", "Buyer's national address")} sub={addr?.row.customer}>
        {addr && <div className="grid gap-3">
          {ADDR_FIELDS.map(([k, ar, en]) => <Field key={k} label={L(ar, en)}><input aria-label={L(ar, en)} className={INPUT} value={addr.f[k] ?? ""} onChange={(e) => setAddr({ ...addr, f: { ...addr.f, [k]: e.target.value } })} /></Field>)}
          <div className="flex gap-2 justify-end"><Button onClick={() => setAddr(null)}>{L("إغلاق", "Close")}</Button>
            <Button kind="primary" onClick={() => act("addr", async () => { await api(`/api/accounting/tax/customers/${addr.row.customerId}`, { method: "PUT", json: addr.f }); setAddr(null); return null; }, () => L("حُفظ العنوان؛ أعد محاولة الإنشاء.", "Address saved; retry the generation."))}>{L("حفظ", "Save")}</Button></div>
        </div>}
      </Dialog>
    </div>
  );
}
