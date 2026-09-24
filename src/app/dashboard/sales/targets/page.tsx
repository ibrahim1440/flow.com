"use client";

import { useState, useEffect, useCallback } from "react";
import { Target } from "lucide-react";
import {
  useLang, ProvisionalBanner, PageHeader, Alert, Card, EmptyState, Spinner, SandboxBanner,
  Button, Field, TextInput, Select, TextArea, Money, Pill, Modal, TableWrap, api,
} from "../_components/ui";
import { useUser } from "../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";

/**
 * Monthly sales targets and progress.
 *
 * Progress is measured against COLLECTIONS, not against deal value, because that is what
 * the commission is measured against. A target tracked on pipeline value next to a
 * commission paid on cash collected disagree for months at a time, and the rep is looking
 * at the wrong one at exactly the moment they care most.
 *
 * PROVISIONAL INTERFACE — see the banner.
 */

type Row = {
  id: string;
  employeeId: string;
  targetAmount: string;
  bonusAmount: string;
  currency: string;
  note: string | null;
  employee: { id: string; name: string; active: boolean };
  achieved: string;
  achievedPercent: string;
  met: boolean;
  shortfall: string;
};

function thisMonth(): string {
  const now = new Date();
  const riyadh = new Date(now.getTime() + 3 * 3600_000);
  return `${riyadh.getUTCFullYear()}-${String(riyadh.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function TargetsPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const user = useUser();
  const canManage = hasSubPrivilege(user?.permissions ?? {}, "sales", "lead_assign");

  const [month, setMonth] = useState(thisMonth());
  const [rows, setRows] = useState<Row[]>([]);
  const [scope, setScope] = useState<"own" | "all">("own");
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editing, setEditing] = useState<Row | "new" | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ rows: Row[]; scope: "own" | "all"; notice: string | null }>(
      `/api/sales/targets?month=${month}`,
    );
    if (res.ok) {
      setRows(res.data.rows);
      setScope(res.data.scope);
      setNotice(res.data.notice);
      setError("");
    } else {
      setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
    }
    setLoading(false);
  }, [month, ar]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Spinner />;

  const totalTarget = rows.reduce((a, r) => a + Number(r.targetAmount), 0);
  const totalAchieved = rows.reduce((a, r) => a + Number(r.achieved), 0);

  return (
    <div className="space-y-6">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "أهداف المبيعات" : "Sales targets"}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap mt-1">
            <span className="tabular-nums">
              {totalAchieved.toFixed(2)} / {totalTarget.toFixed(2)} SAR
            </span>
            {scope === "own" && (
              <span className="text-[11px] text-brown/60 font-semibold">
                {ar ? "هدفك فقط" : "your own target only"}
              </span>
            )}
          </span>
        }
        actions={
          <>
            <div className="w-40">
              <Field id="tg-month" label={ar ? "الشهر" : "Month"}>
                <TextInput id="tg-month" type="month" value={month} onChange={setMonth} />
              </Field>
            </div>
            {canManage && (
              <Button onClick={() => setEditing("new")} testId="new-target">
                <Target size={15} aria-hidden /> {ar ? "تعيين هدف" : "Set a target"}
              </Button>
            )}
          </>
        }
      />

      <SandboxBanner notice={notice} />
      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      {rows.length === 0 ? (
        <Card>
          <EmptyState>
            {ar ? "لم تُعيَّن أهداف لهذا الشهر." : "No targets set for this month."}
          </EmptyState>
        </Card>
      ) : (
        <Card>
          <TableWrap>
            <table className="w-full text-sm min-w-[680px]">
              <thead>
                <tr className="text-[11px] uppercase text-brown/60 font-bold">
                  <th className="text-start py-2">{ar ? "الموظف" : "Employee"}</th>
                  <th className="text-end py-2">{ar ? "الهدف" : "Target"}</th>
                  <th className="text-end py-2">{ar ? "المحقّق" : "Collected"}</th>
                  <th className="py-2 w-[26%]">{ar ? "التقدّم" : "Progress"}</th>
                  <th className="text-end py-2">{ar ? "المكافأة" : "Bonus"}</th>
                  {canManage && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pct = Math.min(100, Number(r.achievedPercent));
                  return (
                    <tr key={r.id} className="border-t border-border" data-testid={`target-${r.employeeId}`}>
                      <td className="py-3 font-bold">{r.employee.name}</td>
                      <td className="py-3 text-end">
                        <Money value={r.targetAmount} currency={r.currency} />
                      </td>
                      <td className="py-3 text-end">
                        <Money value={r.achieved} currency={r.currency} />
                      </td>
                      <td className="py-3 px-2">
                        <div className="flex items-center gap-2">
                          <div
                            className="flex-1 h-2 bg-cream rounded-full overflow-hidden"
                            role="progressbar"
                            aria-valuenow={pct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`${r.employee.name} ${r.achievedPercent}%`}
                          >
                            <div
                              className={`h-full rounded-full ${r.met ? "bg-emerald-500" : "bg-orange"}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs font-bold tabular-nums w-14 text-end">
                            {r.achievedPercent}%
                          </span>
                        </div>
                        {!r.met && (
                          <p className="text-[10px] text-brown/60 mt-1 tabular-nums">
                            {ar ? "المتبقي " : "shortfall "}
                            {r.shortfall}
                          </p>
                        )}
                      </td>
                      <td className="py-3 text-end">
                        {Number(r.bonusAmount) > 0 ? (
                          <span className="flex items-center gap-1.5 justify-end">
                            <Money value={r.bonusAmount} currency={r.currency} />
                            {r.met && <Pill tone="good">{ar ? "مستحقة" : "earned"}</Pill>}
                          </span>
                        ) : (
                          <span className="text-brown/40">—</span>
                        )}
                      </td>
                      {canManage && (
                        <td className="py-3 text-end">
                          <Button variant="ghost" onClick={() => setEditing(r)} testId={`edit-target-${r.employeeId}`}>
                            {ar ? "تعديل" : "Edit"}
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <p className="text-[11px] text-brown/60 font-medium">
        {ar
          ? "الهدف ليس نسبة عمولة. تحقيقه قد يستحق مكافأة، لكن المكافأة رقم يُقرّر ويُسجَّل، ولا يضيفه محرك العمولات إلى النسبة."
          : "A target is not a commission rate. Hitting it may pay a bonus, but the bonus is a figure someone decides and records — the accrual engine never adds it to a rate."}
      </p>

      {editing && (
        <TargetDialog
          ar={ar}
          month={month}
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(msg) => {
            setEditing(null);
            setSuccess(msg);
            load();
          }}
        />
      )}
    </div>
  );
}

function TargetDialog({
  ar, month, existing, onClose, onDone,
}: {
  ar: boolean;
  month: string;
  existing: Row | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([]);
  const [employeeId, setEmployeeId] = useState(existing?.employeeId ?? "");
  const [targetAmount, setTargetAmount] = useState(existing?.targetAmount ?? "");
  const [bonusAmount, setBonusAmount] = useState(existing?.bonusAmount ?? "0");
  const [note, setNote] = useState(existing?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api<{ id: string; name: string; active: boolean }[]>("/api/employees").then((r) => {
      if (r.ok && Array.isArray(r.data)) {
        setEmployees(r.data.filter((e) => e.active !== false).map((e) => ({ id: e.id, name: e.name })));
      }
    });
  }, []);

  return (
    <Modal
      title={existing ? (ar ? "تعديل الهدف" : "Edit the target") : ar ? "تعيين هدف" : "Set a target"}
      onClose={onClose}
      testId="target-dialog"
      footer={
        <>
          {existing && (
            <Button
              variant="danger"
              disabled={busy}
              testId="delete-target"
              onClick={async () => {
                setBusy(true);
                const res = await api(
                  `/api/sales/targets?employeeId=${existing.employeeId}&month=${month}`,
                  { method: "DELETE" },
                );
                setBusy(false);
                if (res.ok) onDone(ar ? "أُزيل الهدف." : "Target removed.");
                else setErr(res.data.error ?? "");
              }}
            >
              {ar ? "إزالة" : "Remove"}
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || !employeeId || !(Number(targetAmount) > 0)}
            testId="save-target"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api("/api/sales/targets", {
                method: "PUT",
                body: { employeeId, month, targetAmount, bonusAmount, note },
              });
              setBusy(false);
              if (res.ok) onDone(ar ? "حُفظ الهدف." : "Target saved.");
              else setErr(res.data.error ?? "");
            }}
          >
            {ar ? "حفظ" : "Save"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}
      <Field id="tg-emp" label={ar ? "الموظف" : "Employee"} required>
        <Select id="tg-emp" value={employeeId} onChange={setEmployeeId} disabled={!!existing}>
          <option value="">—</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="tg-amount" label={ar ? "الهدف (SAR)" : "Target (SAR)"} required>
          <TextInput id="tg-amount" value={targetAmount} onChange={setTargetAmount} inputMode="decimal" />
        </Field>
        <Field
          id="tg-bonus"
          label={ar ? "المكافأة (SAR)" : "Bonus (SAR)"}
          hint={ar ? "تُسجَّل ولا تُدفع تلقائياً." : "Recorded, not paid automatically."}
        >
          <TextInput id="tg-bonus" value={bonusAmount} onChange={setBonusAmount} inputMode="decimal" />
        </Field>
      </div>
      <Field id="tg-note" label={ar ? "ملاحظة" : "Note"}>
        <TextArea id="tg-note" value={note} onChange={setNote} rows={2} />
      </Field>
      <p className="text-[11px] text-brown/60 font-medium">
        {ar
          ? "لا يستطيع أحد تعيين هدفه بنفسه — لأن الهدف المصحوب بمكافأة هو أجر."
          : "Nobody sets their own target: a target with a bonus attached is pay."}
      </p>
    </Modal>
  );
}
