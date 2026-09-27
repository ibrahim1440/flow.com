"use client";

import { useState } from "react";
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Segmented, api, useApi, useL, withBranch, useFinance, type Tone } from "./ui";

type Req = {
  id: string; type: string; payload: Record<string, unknown>; status: string; summary: string; reason: string | null; requestedBy: string; requestedAt: string;
  assignedToId: string | null; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; branchKey: string;
};
type Queue = { toDecide: Req[]; raisedByMe: Req[]; people: { id: string; name: string }[] };

export const TYPE_LABEL: Record<string, [string, string, Tone]> = {
  BUDGET_APPROVAL: ["اعتماد ميزانية", "Budget approval", "ok"],
  ALLOCATION_RULES: ["قواعد التخصيص", "Allocation rules", "brand"],
  CATEGORY_TRANSFER: ["تحويل بين الفئات", "Category transfer", "brand"],
  SPEND_OVERRIDE: ["تجاوز إنفاق", "Spending override", "warn"],
  PERIOD_REOPEN: ["إعادة فتح فترة", "Reopen period", "info"],
};
const STATUS: Record<string, [string, string, Tone]> = {
  PENDING: ["بانتظار القرار", "Pending", "warn"], APPROVED: ["معتمد", "Approved", "ok"], REJECTED: ["مرفوض", "Rejected", "bad"], CANCELLED: ["مسحوب", "Withdrawn", "info"],
};

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** Localised one-line summary from the structured payload (the stored summary is an English fallback). */
function useSummary() {
  const { L, money, name } = useL();
  return (r: Req) => {
    const p = r.payload as Record<string, never>;
    switch (r.type) {
      case "BUDGET_APPROVAL": return L(`ميزانية ${p.month}${Number(p.revisionNo) > 1 ? ` — المراجعة ${p.revisionNo}` : ""} — مقبوضات ${money(p.receipts)} / مدفوعات ${money(p.payments)} ر.س`, `${p.month} budget${Number(p.revisionNo) > 1 ? ` — revision ${p.revisionNo}` : ""} — receipts ${money(p.receipts)} / payments ${money(p.payments)} SAR`);
      case "CATEGORY_TRANSFER": return L(`نقل ${money(p.amount)} ر.س من ${name({ nameAr: p.fromNameAr, nameEn: p.fromNameEn ?? p.fromCode })} إلى ${name({ nameAr: p.toNameAr, nameEn: p.toNameEn ?? p.toCode })}`, `Move SAR ${money(p.amount)} from ${name({ nameAr: p.fromNameAr, nameEn: p.fromNameEn ?? p.fromCode })} to ${name({ nameAr: p.toNameAr, nameEn: p.toNameEn ?? p.toCode })}`);
      case "SPEND_OVERRIDE": return L(`دفع ${money(p.amount)} ر.س إلى ${p.payee ?? "—"} من ${name({ nameAr: p.categoryNameAr, nameEn: p.categoryNameEn ?? "" })} — المتاح ${money(p.available)}${p.spendingLimit ? ` · الحد ${money(p.spendingLimit)}` : ""}`, `Pay SAR ${money(p.amount)} to ${p.payee ?? "—"} from ${name({ nameAr: p.categoryNameAr, nameEn: p.categoryNameEn ?? "" })} — available ${money(p.available)}${p.spendingLimit ? ` · limit ${money(p.spendingLimit)}` : ""}`);
      case "ALLOCATION_RULES": return L(`قواعد التخصيص — الإصدار ${p.versionNo}${p.autoExecute ? " (تنفيذ تلقائي)" : ""}`, `Allocation rules — version ${p.versionNo}${p.autoExecute ? " (automatic execution)" : ""}`);
      case "PERIOD_REOPEN": return L(`إعادة فتح ميزانية ${p.month}`, `Reopen the ${p.month} budget`);
      default: return r.summary;
    }
  };
}

export function ApprovalsDialog({ open, onClose, onDecided }: { open: boolean; onClose: () => void; onDecided: () => void }) {
  const { L } = useL();
  const { branch } = useFinance();
  const summary = useSummary();
  const [tab, setTab] = useState<"mine" | "raised">("mine");
  const q = useApi<Queue>(open ? "/api/finance/approvals" : null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const person = (id: string | null) => q.data?.people.find((p) => p.id === id)?.name ?? "—";

  async function decide(id: string, decision: "APPROVE" | "REJECT") {
    setBusy(true); setErr(null);
    try {
      await api(withBranch(`/api/finance/approvals/${id}/decide`, branch), { method: "POST", json: { decision, note: note || undefined } });
      setNote(""); setOpenId(null); q.reload(); onDecided();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function withdraw(id: string) {
    setBusy(true);
    try { await api(`/api/finance/approvals/${id}/withdraw`, { method: "POST", json: {} }); q.reload(); onDecided(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const list = tab === "mine" ? q.data?.toDecide ?? [] : q.data?.raisedByMe ?? [];
  return (
    <Dialog open={open} onClose={onClose} width="max-w-[640px]" title={L("الموافقات", "Approvals")} sub={L("الطلبات التي تنتظر قرارك. لا يمكنك اعتماد طلب قدّمته بنفسك.", "Requests waiting for your decision. You cannot approve a request you raised.")}>
      <Segmented value={tab} onChange={setTab} options={[{ value: "mine", label: L(`بانتظار قراري (${q.data?.toDecide.length ?? 0})`, `Waiting for me (${q.data?.toDecide.length ?? 0})`) }, { value: "raised", label: L("طلباتي", "My requests") }]} />
      {q.loading && !q.data ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : list.length === 0 ? (
        <EmptyState title={tab === "mine" ? L("لا توجد طلبات بانتظار قرارك", "Nothing is waiting for you") : L("لم تقدّم طلبات بعد", "You have not raised any requests")} />
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((r) => {
            const [ar, en, tone] = TYPE_LABEL[r.type] ?? [r.type, r.type, "info"];
            const expanded = tab === "mine" && openId === r.id;
            return (
              <div key={r.id} className={`rounded-xl bg-white p-3.5 flex flex-col gap-2 ${expanded ? "border-2 border-orange" : "border border-border"}`}>
                <button type="button" className="flex items-start gap-2 text-start" onClick={() => tab === "mine" && setOpenId(expanded ? null : r.id)}>
                  <Badge tone={tone}>{L(ar, en)}</Badge>
                  <span className="text-sm font-bold text-charcoal">{summary(r)}</span>
                </button>
                <p className="text-xs text-brown">
                  {tab === "mine" ? L(`طلبه ${person(r.requestedBy)}`, `Requested by ${person(r.requestedBy)}`) : L("طلبك", "Your request")} · {when(r.requestedAt)}
                  {r.assignedToId ? ` · ${L("المعتمِد المسمّى", "Named approver")}: ${person(r.assignedToId)}` : ""}
                </p>
                {r.reason && <p className="text-xs text-charcoal">{L("السبب", "Reason")}: {r.reason}</p>}
                {tab === "raised" && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge tone={STATUS[r.status][2]}>{L(STATUS[r.status][0], STATUS[r.status][1])}</Badge>
                    {r.decidedBy && <span className="text-xs text-brown">{person(r.decidedBy)} · {r.decidedAt ? when(r.decidedAt) : ""}{r.decisionNote ? ` · ${r.decisionNote}` : ""}</span>}
                    {r.status === "PENDING" && <Button kind="ghost" busy={busy} onClick={() => withdraw(r.id)}>{L("سحب الطلب", "Withdraw")}</Button>}
                  </div>
                )}
                {expanded && (
                  <>
                    <Field label={L("ملاحظة القرار (إلزامية عند الرفض)", "Decision note (required to reject)")}>
                      <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />
                    </Field>
                    {err && <p className="text-xs text-red-600">{err}</p>}
                    <div className="flex gap-2">
                      <Button kind="primary" busy={busy} onClick={() => decide(r.id, "APPROVE")}>{L("اعتماد", "Approve")}</Button>
                      <Button kind="danger" busy={busy} onClick={() => decide(r.id, "REJECT")}>{L("رفض", "Reject")}</Button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
