"use client";

// Figma: ACC-09. Operational events and why they have or have not posted; the policies and
// commission plans that gate posting (four-eyes, server-enforced); posting-role mappings;
// ledger cutover and set-up completion.
import { useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import { ApiError, Badge, Button, Card, CardTitle, Dialog, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, api, useApi, useFinance, useL } from "../../finance/_components/ui";
import { EVENT_LABEL, EVENT_STATUS, Pager, ROLE_LABELS, useAmount, useCan, useDay, useExplain } from "../_components/kit";

type Ev = { id: string; eventType: string; sourceModule: string; sourceDocumentId: string; occurredAt: string; status: string; errorMessage: string | null; attempts: number; payload: { amount?: string; employeeId?: string }; journalEntry: { id: string; entryNo: number; isProvisional: boolean } | null };
type Policy = { key: string; en: string; ar: string; defaultStatement: string; versions: { id: string; version: number; status: string; statement: string; preparedBy: string; approvedBy: string | null; approvedAt: string | null; preparedAt: string }[] };
type Plan = { id: string; version: number; baseRatePercent: string; effectiveFrom: string; createdById: string | null; accountingApproval: string; accountingApprovedAt: string | null; plan: { code: string; name: string; nameAr: string | null }; _count: { ledgerEntries: number } };
type Mapping = { role: string; en: string; ar: string; account: { id: string; code: string; nameEn: string; nameAr: string | null } | null };
type Settings = { ledgerCutoverDate: string | null; setupComplete: boolean };
type Acc = { id: string; code: string; nameEn: string; nameAr: string | null; allowPosting: boolean; isActive: boolean; parentId: string | null };
type Seg = "ALL" | "BLOCKED" | "FAILED" | "TRANSLATED" | "SKIPPED" | "PENDING";


export default function AutomationPage() {
  const { L, name } = useL();
  const day = useDay();
  const explain = useExplain();
  const amount = useAmount();
  const { user, can } = useCan();
  const { refresh } = useFinance();
  const [seg, setSeg] = useState<Seg>("ALL");
  const [page, setPage] = useState(1);
  const events = useApi<{ rows: Ev[]; total: number; page: number; pageSize: number; counts: Record<string, number> }>(`/api/accounting/events?page=${page}&pageSize=25${seg !== "ALL" ? `&status=${seg}` : ""}`);
  const policies = useApi<Policy[]>("/api/accounting/policies");
  const plans = useApi<Plan[]>("/api/accounting/commission-plans");
  const mappings = useApi<Mapping[]>("/api/accounting/mappings");
  const settings = useApi<Settings>("/api/accounting/settings");
  const accounts = useApi<Acc[]>("/api/accounting/coa");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [draft, setDraft] = useState<{ key: string; statement: string } | null>(null);
  const [cutover, setCutover] = useState("");

  const run = async (key: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) => {
    setBusy(key); setMsg(null);
    try { const r = await fn(); setMsg({ tone: "ok", text: ok ? ok(r) : L("تم.", "Done.") }); events.reload(); policies.reload(); plans.reload(); mappings.reload(); settings.reload(); refresh(); return true; }
    catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); return false; }
    finally { setBusy(null); }
  };
  const parents = new Set(accounts.data?.map((a) => a.parentId).filter(Boolean));
  const postable = accounts.data?.filter((a) => a.allowPosting && a.isActive && !parents.has(a.id)) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Card>
        <CardTitle title={L("الأحداث", "Events")} sub={events.data ? Object.entries(events.data.counts).map(([s, n]) => `${L(EVENT_STATUS[s]?.ar ?? s, EVENT_STATUS[s]?.en ?? s)} ${n}`).join(" · ") : ""}
          right={can("events_process") ? <Button kind="primary" icon={Play} busy={busy === "process"} onClick={() => run("process", () => api<{ processed: number; translated: number; blocked: number; failed: number; skipped: number }>("/api/accounting/events/process", { method: "POST", json: {} }), (r) => { const x = r as { processed: number; translated: number; blocked: number; failed: number }; return L(`عولج ${x.processed}: رُحّل ${x.translated}، محجوب ${x.blocked}، فشل ${x.failed}.`, `Processed ${x.processed}: posted ${x.translated}, blocked ${x.blocked}, failed ${x.failed}.`); })}>{L("تشغيل الترحيل الآن", "Run posting now")}</Button> : undefined} />
        <Segmented<Seg> value={seg} onChange={(s) => { setSeg(s); setPage(1); }} options={[{ value: "ALL", label: L("الكل", "All") }, { value: "BLOCKED", label: L("محجوبة", "Blocked") }, { value: "FAILED", label: L("فاشلة", "Failed") }, { value: "PENDING", label: L("بانتظار", "Pending") }, { value: "TRANSLATED", label: L("مرحّلة", "Posted") }, { value: "SKIPPED", label: L("قبل بداية الدفتر", "Before cutover") }]} />
        {events.error ? <ErrorState error={events.error} onRetry={events.reload} /> : !events.data ? <LoadingState /> : events.data.rows.length === 0 ? <p className="text-[13px] text-brown">{L("لا توجد أحداث بهذه الحالة.", "No events with this status.")}</p> : (
          <Table>
            <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("الحدث", "Event")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{L("الحالة", "Status")}</Th><Th>{L("السبب / القيد", "Reason / entry")}</Th><Th></Th></tr></thead>
            <tbody>
              {events.data.rows.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap">{day(e.occurredAt)}</Td>
                  <Td>{EVENT_LABEL[e.eventType] ? L(...EVENT_LABEL[e.eventType]) : e.eventType}</Td>
                  <Td num>{amount(e.payload?.amount)}</Td>
                  <Td><Badge tone={EVENT_STATUS[e.status]?.tone ?? "info"}>{L(EVENT_STATUS[e.status]?.ar ?? e.status, EVENT_STATUS[e.status]?.en ?? e.status)}</Badge></Td>
                  <Td className="max-w-[420px] text-xs">{e.journalEntry ? <a className="font-bold text-orange hover:underline text-[13px]" href={`/dashboard/accounting/journals/${e.journalEntry.id}`}>{L("قيد", "Entry")} #{e.journalEntry.entryNo}{e.journalEntry.isProvisional ? L(" (مؤقت)", " (provisional)") : ""}</a> : <span className="text-brown" title={e.errorMessage ?? undefined}>{explain(e.errorMessage)}</span>}</Td>
                  <Td>{["BLOCKED", "FAILED", "PENDING"].includes(e.status) && can("events_process") && <Button kind="ghost" icon={RefreshCw} busy={busy === e.id} onClick={() => run(e.id, () => api(`/api/accounting/events/${e.id}/process`, { method: "POST", json: {} }))}>{L("إعادة المحاولة", "Retry")}</Button>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {events.data && events.data.total > events.data.pageSize && <Pager page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPage={setPage} />}
      </Card>

      <div className="grid gap-4 grid-cols-1 xl:grid-cols-2 items-start">
        <Card>
          <CardTitle title={L("السياسات المحاسبية", "Accounting policies")} sub={L("يعتمدها شخص غير معدّها · الإصدار المعتمد لا يُعدّل", "Approved by someone other than the preparer · an approved version is never edited")} />
          {policies.error ? <ErrorState error={policies.error} onRetry={policies.reload} /> : !policies.data ? <LoadingState /> : policies.data.map((p) => {
            const approved = p.versions.find((v) => v.status === "APPROVED");
            const pending = p.versions.find((v) => v.status === "DRAFT");
            return (
              <div key={p.key} className="flex flex-col gap-2 border-t border-border-light pt-3 first:border-0 first:pt-0">
                <div className="flex items-center gap-2 flex-wrap"><span className="text-[14px] font-bold text-charcoal">{L(p.ar, p.en)}</span>
                  {approved ? <Badge tone="ok">{L(`الإصدار ${approved.version} · معتمد`, `Version ${approved.version} · approved`)}</Badge> : <Badge tone="bad">{L("لا إصدار معتمد — الترحيل محجوب", "No approved version — posting blocked")}</Badge>}
                  {pending && <Badge tone="warn">{L(`الإصدار ${pending.version} · مسودة`, `Version ${pending.version} · draft`)}</Badge>}</div>
                <p className="text-xs text-brown leading-relaxed whitespace-pre-line">{(pending ?? approved)?.statement ?? p.defaultStatement}</p>
                <div className="flex gap-2 flex-wrap">
                  {pending && can("policy_approve") && pending.preparedBy !== user?.id && <Button kind="primary" busy={busy === pending.id} onClick={() => run(pending.id, () => api(`/api/accounting/policies/${pending.id}/approve`, { method: "POST", json: {} }))}>{L(`اعتماد الإصدار ${pending.version}`, `Approve version ${pending.version}`)}</Button>}
                  {pending && pending.preparedBy === user?.id && <span className="text-xs text-brown">{L("أعددت هذه المسودة — يعتمدها شخص آخر.", "You prepared this draft — someone else approves it.")}</span>}
                  {pending && can("policy_prepare") && <Button kind="danger" busy={busy === "d" + pending.id} onClick={() => run("d" + pending.id, () => api(`/api/accounting/policies/${pending.id}`, { method: "DELETE" }))}>{L("حذف المسودة", "Discard draft")}</Button>}
                  {!pending && can("policy_prepare") && <Button onClick={() => setDraft({ key: p.key, statement: approved?.statement ?? p.defaultStatement })}>{L("مسودة إصدار جديد", "Draft a new version")}</Button>}
                </div>
              </div>
            );
          })}
        </Card>
        <Card>
          <CardTitle title={L("اعتماد خطط العمولات للترحيل", "Commission plans approved for posting")} sub={L("لا يغيّر النسب أو الشروط — يسمح بالترحيل فقط. منشئ الخطة لا يعتمدها.", "Changes no rate or rule — only allows posting. The plan's author cannot approve it.")} />
          {plans.error ? <ErrorState error={plans.error} onRetry={plans.reload} /> : !plans.data ? <LoadingState /> : plans.data.length === 0 ? <p className="text-[13px] text-brown">{L("لا توجد خطط عمولات.", "No commission plans.")}</p> : (
            <Table>
              <thead><tr><Th>{L("الخطة", "Plan")}</Th><Th num>{L("النسبة", "Rate")}</Th><Th>{L("سارية من", "From")}</Th><Th>{L("الاعتماد المحاسبي", "Accounting approval")}</Th><Th></Th></tr></thead>
              <tbody>
                {plans.data.map((v) => (
                  <tr key={v.id}>
                    <Td>{v.plan.code} v{v.version}</Td><Td num>{Number(v.baseRatePercent).toFixed(2)}%</Td><Td>{day(v.effectiveFrom)}</Td>
                    <Td>{v.accountingApproval === "APPROVED" ? <Badge tone="ok">{L("معتمدة", "Approved")}</Badge> : <Badge tone="warn">{L("مؤقتة", "Provisional")}</Badge>}</Td>
                    <Td>{v.accountingApproval !== "APPROVED" && can("policy_approve") && (v.createdById === user?.id ? <span className="text-xs text-brown">{L("أنت منشئها", "You created it")}</span> : <Button kind="primary" className="px-2.5! py-1.5! text-xs!" busy={busy === v.id} onClick={() => run(v.id, () => api(`/api/accounting/commission-plans/${v.id}/approve`, { method: "POST", json: {} }))}>{L("اعتماد", "Approve")}</Button>)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <div className="grid gap-4 grid-cols-1 xl:grid-cols-[1fr_340px] items-start">
        <Card>
          <CardTitle title={L("ربط أدوار الترحيل بالحسابات", "Posting roles → accounts")} sub={L("لا رموز حسابات مثبتة في الكود؛ الدور غير المربوط يحجب الترحيل", "No account codes in code; an unmapped role blocks posting")} />
          {mappings.error ? <ErrorState error={mappings.error} onRetry={mappings.reload} /> : !mappings.data ? <LoadingState /> : (
            <Table>
              <thead><tr><Th>{L("الدور", "Role")}</Th><Th>{L("الحساب", "Account")}</Th></tr></thead>
              <tbody>
                {mappings.data.map((m) => (
                  <tr key={m.role}>
                    <Td>{L(...(ROLE_LABELS[m.role] ?? [m.ar, m.en]))}</Td>
                    <Td>{can("mapping_manage") ? (
                      <select aria-label={L(`حساب ${m.ar}`, `Account for ${m.en}`)} className={INPUT} value={m.account?.id ?? ""} disabled={busy === m.role} onChange={(e) => e.target.value && run(m.role, () => api("/api/accounting/mappings", { method: "PUT", json: { role: m.role, accountId: e.target.value } }))}>
                        <option value="">{L("— غير مربوط —", "— not mapped —")}</option>
                        {postable.map((a) => <option key={a.id} value={a.id}>{a.code} · {name(a)}</option>)}
                      </select>
                    ) : m.account ? `${m.account.code} · ${name(m.account)}` : <Badge tone="bad">{L("غير مربوط", "Not mapped")}</Badge>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardTitle title={L("بداية الدفتر والإعداد", "Cutover and set-up")} />
          {settings.data && <>
            <p className="text-[13px]">{L("تاريخ بداية الدفتر:", "Ledger cutover:")} <b>{settings.data.ledgerCutoverDate ? day(settings.data.ledgerCutoverDate) : L("غير محدد", "not set")}</b></p>
            <p className="text-xs text-brown">{L("الأحداث قبله يحملها الرصيد الافتتاحي. لا يتغير بعد أول ترحيل آلي.", "Events before it are carried by the opening balance. It cannot change after the first automatic posting.")}</p>
            {can("mapping_manage") && can("settings_manage") && <div className="flex gap-2 items-end">
              <Field label={L("تاريخ جديد", "New date")}><input type="date" className={INPUT} value={cutover} onChange={(e) => setCutover(e.target.value)} /></Field>
              <Button disabled={!cutover} busy={busy === "cut"} onClick={() => run("cut", () => api("/api/accounting/settings", { method: "PATCH", json: { ledgerCutoverDate: cutover } }))}>{L("حفظ", "Save")}</Button>
            </div>}
            <p className="text-[13px]">{L("الإعداد:", "Set-up:")} {settings.data.setupComplete ? <Badge tone="ok">{L("مكتمل", "Complete")}</Badge> : <Badge tone="warn">{L("غير مكتمل — لا ترحيل", "Incomplete — nothing posts")}</Badge>}</p>
            {can("settings_manage") && !settings.data.setupComplete && <Button kind="primary" busy={busy === "setup"} onClick={() => run("setup", () => api("/api/accounting/settings", { method: "PATCH", json: { setupComplete: true } }))}>{L("إكمال الإعداد", "Complete set-up")}</Button>}
          </>}
        </Card>
      </div>

      <Dialog open={!!draft} onClose={() => setDraft(null)} title={L("مسودة إصدار جديد للسياسة", "Draft a new policy version")} sub={L("يُعتمد من شخص آخر؛ عند اعتماده يتقاعد الإصدار السابق.", "Approved by someone else; on approval the previous version retires.")}>
        {draft && <>
          <Field label={L("نص السياسة", "Policy statement")}><textarea className={INPUT} rows={8} value={draft.statement} onChange={(e) => setDraft({ ...draft, statement: e.target.value })} /></Field>
          <div className="flex gap-2 justify-end">
            <Button kind="ghost" onClick={() => setDraft(null)}>{L("إلغاء", "Cancel")}</Button>
            <Button kind="primary" busy={busy === "draft"} onClick={async () => { if (await run("draft", () => api("/api/accounting/policies", { method: "POST", json: draft }))) setDraft(null); }}>{L("حفظ المسودة", "Save draft")}</Button>
          </div>
        </>}
      </Dialog>
    </div>
  );
}
