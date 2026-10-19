"use client";
// HR-02 · Leave: balances per type (ledger sum minus pending), the ledger with a running
// total, and manual ledger entries (opening / grant / adjustment) for leave_manage.
import { Select } from "@/components/ui/Select";
import { useCallback, useState } from "react";
import { Btn, Dialog, Empty, ErrorState, Field, LoadingTable, Notice, ProposalTag, todayIso, useAction, useCan, useForm, useHr, useHrI18n } from "@/components/hr/ui";
import { leaveTypeName } from "@/lib/i18n/hr";
import { hrText } from "@/lib/hr/messages-en";
import { LEDGER_ENTRY, SectionHead, lbl, mutate, type Balance, type TabProps } from "./shared";

type LedgerRow = { id: string; entryType: string; days: string; effectiveDate: string; requestId: string | null; reason: string | null; running: string; createdAt: string };
const n = (v: string) => String(Number(v));

export default function LeaveTab({ id, profile, readOnly }: TabProps) {
  const can = useCan();
  const { data, error, loading, reload } = useHr<Balance[]>(`/api/hr/employees/${id}/leave`);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [entry, setEntry] = useState(false);
  const close = useCallback(() => setEntry(false), []);
  const tracked = data?.filter((b) => b.tracksBalance) ?? [];
  const current = tracked.find((b) => b.leaveTypeId === typeId) ?? tracked[0] ?? null;
  const ledger = useHr<LedgerRow[]>(current ? `/api/hr/leave/ledger?employeeId=${encodeURIComponent(id)}&leaveTypeId=${encodeURIComponent(current.leaveTypeId)}` : null);
  const canManage = can("leave_manage") && !readOnly;
  const { L, t, lang } = useHrI18n();

  return (
    <div className="hr-stack" style={{ gap: 28 }}>
      <section className="hr-stack">
        <SectionHead title={L("أرصدة الإجازات", "Leave balances")} actions={canManage && tracked.length ? <Btn size="sm" onClick={() => setEntry(true)}>{L("قيد رصيد", "Balance entry")}</Btn> : null} />
        {error ? <ErrorState error={error} onRetry={reload} /> : null}
        {loading && !data ? <LoadingTable rows={4} /> : null}
        {data && data.length === 0 ? <Empty title={L("لا توجد أنواع إجازة", "No leave types")} body={L("تُعرَّف أنواع الإجازات في سياسة الموارد البشرية.", "Leave types are defined in the HR policy.")} /> : null}
        {data && data.length > 0 ? (
          <div className="hr-tablewrap">
            <table className="hr-table is-stack" aria-label={L("أرصدة الإجازات", "Leave balances")}>
              <thead><tr><th>{L("نوع الإجازة", "Leave type")}</th><th className="num">{L("الرصيد", "Balance")}</th><th className="num">{L("معلّق", "Pending")}</th><th className="num">{L("المتاح", "Available")}</th></tr></thead>
              <tbody>
                {data.map((b) => (
                  <tr key={b.leaveTypeId} className={b.tracksBalance ? "is-clickable" : undefined} aria-selected={current?.leaveTypeId === b.leaveTypeId} tabIndex={b.tracksBalance ? 0 : undefined}
                    onClick={() => b.tracksBalance && setTypeId(b.leaveTypeId)} onKeyDown={(e) => b.tracksBalance && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setTypeId(b.leaveTypeId))}>
                    <td data-label={L("نوع الإجازة", "Leave type")} className="strong">
                      {leaveTypeName(b, lang)} {b.paid ? null : <span className="sub">{L("غير مدفوعة", "Unpaid")}</span>} {b.isProposal ? <ProposalTag /> : null}
                    </td>
                    <td data-label={L("الرصيد", "Balance")} className="num">{b.tracksBalance ? n(b.balance) : "—"}</td>
                    <td data-label={L("معلّق", "Pending")} className="num">{b.tracksBalance ? n(b.pending) : "—"}</td>
                    <td data-label={L("المتاح", "Available")} className="num strong">{b.tracksBalance ? n(b.available) : L("بلا رصيد", "No balance")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="hr-caption" style={{ margin: 0 }}>{L("المتاح = الرصيد ناقص الطلبات المعلّقة. الرصيد مجموع قيود السجل، بما فيها الإجازات المعتمدة مستقبلًا.", "Available = balance minus pending requests. The balance is the sum of the ledger entries, including approved future leave.")}</p>
      </section>

      {current ? (
        <section className="hr-stack">
          <SectionHead title={L(`سجل الرصيد · ${current.nameAr}`, `Balance ledger · ${leaveTypeName(current, lang)}`)} />
          {ledger.error ? <ErrorState error={ledger.error} onRetry={ledger.reload} /> : null}
          {ledger.loading && !ledger.data ? <LoadingTable rows={4} /> : null}
          {ledger.data && ledger.data.length === 0 ? <Empty title={L("لا توجد قيود", "No entries")} body={canManage ? L("ابدأ برصيد افتتاحي.", "Start with an opening balance.") : L("لم يُسجَّل أي رصيد لهذا النوع بعد.", "No balance has been recorded for this type yet.")} /> : null}
          {ledger.data && ledger.data.length > 0 ? (
            <div className="hr-tablewrap">
              <table className="hr-table is-stack is-dense" aria-label={L("سجل رصيد الإجازة", "Leave balance ledger")}>
                <thead><tr><th className="num">{t("date")}</th><th>{L("القيد", "Entry")}</th><th className="num">{t("days")}</th><th className="num">{L("الرصيد التراكمي", "Running balance")}</th><th>{t("reason")}</th></tr></thead>
                <tbody>
                  {ledger.data.map((r) => (
                    <tr key={r.id}>
                      <td data-label={t("date")} className="num">{r.effectiveDate}</td>
                      <td data-label={L("القيد", "Entry")}>{lbl(LEDGER_ENTRY, r.entryType, lang)}</td>
                      <td data-label={t("days")} className="num" style={{ color: Number(r.days) < 0 ? "var(--hr-danger)" : undefined }}><span className="hr-num">{Number(r.days) > 0 ? "+" : ""}{n(r.days)}</span></td>
                      <td data-label={L("الرصيد التراكمي", "Running balance")} className="num strong">{n(r.running)}</td>
                      <td data-label={t("reason")} className="hr-muted">{r.reason ? hrText(r.reason, lang) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {entry ? (
        <EntryDialog
          id={id}
          name={profile.person.fullNameAr}
          types={tracked}
          initialType={current?.leaveTypeId ?? ""}
          onClose={close}
          onDone={(t) => { setEntry(false); setTypeId(t); void reload(); void ledger.reload(); }}
        />
      ) : null}
    </div>
  );
}

function EntryDialog({ id, name, types, initialType, onClose, onDone }: { id: string; name: string; types: Balance[]; initialType: string; onClose: () => void; onDone: (typeId: string) => void }) {
  const f = useForm({ leaveTypeId: initialType, entryType: "OPENING", days: "", effectiveDate: todayIso(), reason: "" });
  const a = useAction();
  const { L, t, lang } = useHrI18n();
  const daysOk = /^-?\d+(\.\d{1,2})?$/.test(f.v.days.trim()) && Number(f.v.days) !== 0 && (f.v.entryType === "ADJUSTMENT" || Number(f.v.days) > 0);
  const submit = () => a.run("save", async () => {
    await mutate("/api/hr/leave/ledger", { json: { employeeId: id, ...f.v, days: f.v.days.trim() } });
    onDone(f.v.leaveTypeId);
  });
  return (
    <Dialog open title={L(`قيد رصيد إجازة · ${name}`, `Leave balance entry · ${name}`)} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.leaveTypeId || !daysOk || !f.v.effectiveDate || f.v.reason.trim().length < 3}>{L("حفظ القيد", "Save entry")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("نوع الإجازة *", "Leave type *")}><Select className="hr-select" {...f.bind("leaveTypeId")}>{types.map((x) => <option key={x.leaveTypeId} value={x.leaveTypeId}>{leaveTypeName(x, lang)}</option>)}</Select></Field>
        <Field label={L("نوع القيد *", "Entry type *")}><Select className="hr-select" {...f.bind("entryType")}><option value="OPENING">{L("رصيد افتتاحي", "Opening balance")}</option><option value="GRANT">{L("منح", "Grant")}</option><option value="ADJUSTMENT">{L("تسوية (+ أو −)", "Adjustment (+ or −)")}</option></Select></Field>
        <Field label={L("الأيام *", "Days *")} help={f.v.entryType === "ADJUSTMENT" ? L("سالب للخصم، خانتان عشريتان على الأكثر", "Negative to deduct, at most two decimals") : L("رقم موجب، خانتان عشريتان على الأكثر", "A positive number, at most two decimals")} error={f.v.days && !daysOk ? L("قيمة غير صالحة لهذا النوع من القيود", "Not a valid value for this entry type") : null}>
          <input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("days")} />
        </Field>
        <Field label={L("تاريخ السريان *", "Effective date *")}><input className="hr-input" type="date" {...f.bind("effectiveDate")} /></Field>
        <Field label={L("السبب *", "Reason *")} wide><input className="hr-input" {...f.bind("reason")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("السجل لا يُعدَّل ولا يُحذف؛ التصحيح يكون بقيد تسوية جديد. لا يُقبل رصيد افتتاحي ثانٍ للنوع نفسه.", "The ledger is never edited or deleted; corrections are new adjustment entries. A second opening balance for the same type is refused.")}</p>
    </Dialog>
  );
}
