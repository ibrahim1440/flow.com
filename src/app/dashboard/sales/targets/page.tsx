"use client";

import { useState, useEffect } from "react";
import { Target } from "lucide-react";
import {
  useLang, ProvisionalBanner, PageHeader, Alert, Card, EmptyState, Spinner, SandboxBanner,
  Button, Field, TextInput, Select, TextArea, Money, Modal, api,
  DataTable, Tr, Td, ProgressBar, ROW_ACTION, num, FilterSelect, formatMoney, toArabicDigits, monthOptions,
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

  /**
   * Reload counter. The fetch lives in the effect rather than in a `useCallback` the effect
   * calls, because the rule resolves a called callback and sees setState reachable from the
   * effect body. Mutations refresh by bumping this, so behaviour is unchanged and the fetch
   * has one owner. `cancelled` stops a slow response for an old month landing after a newer.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
    const res = await api<{ rows: Row[]; scope: "own" | "all"; notice: string | null }>(
      `/api/sales/targets?month=${month}`,
    );
    if (cancelled) return;
    if (res.ok) {
      setRows(res.data.rows);
      setScope(res.data.scope);
      setNotice(res.data.notice);
      setError("");
    } else {
      setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
    }
    setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [month, ar, reloadToken]);

  if (loading) return <Spinner />;

  // "سبتمبر ٢٠٢٦" — the period the table is showing, in the reader's own calendar names.
  const months = monthOptions(month, lang);
  const monthLabel = months.find((o) => o.value === month)?.label ?? month;

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "أهداف المبيعات" : "Sales targets"}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap">
            <span>{monthLabel}</span>
            <span aria-hidden className="text-oo-border-strong">·</span>
            <span>
              {ar
                ? "الهدف يُقاس على صافي المحصّل، لا على قيمة الطلبات"
                : "measured on net collections, not on order value"}
            </span>
            {scope === "own" && (
              <>
                <span aria-hidden className="text-oo-border-strong">·</span>
                <span>{ar ? "هدفك فقط" : "your own target only"}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            {/* The design's actions slot is a period control and a create button. The period
                control here lists months rather than stepping back one, because the screen
                already supports jumping to any month and a one-step button would take that
                away — and a select rather than <input type="month">: the native control
                renders its
                month name in the BROWSER's locale, so an Arabic page was showing
                "September 2026". The choice on offer is the same — any of the last year, or
                next month — and now it reads in the page's own language. */}
            <FilterSelect
              value={month}
              onChange={setMonth}
              label={ar ? "الشهر" : "Month"}
              width="w-[180px]"
              testId="tg-month"
            >
              {months.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </FilterSelect>
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
        <DataTable
          testId="targets-table"
          minWidth={canManage ? 880 : 780}
          cols={[
            { label: ar ? "الموظّف" : "Employee", w: "min-w-[180px]" },
            { label: ar ? "الهدف" : "Target", w: "w-[170px]" },
            { label: ar ? "المحقّق" : "Collected", w: "w-[170px]" },
            { label: ar ? "التقدّم" : "Progress", w: "w-[240px]" },
            { label: ar ? "مكافأة التحقيق" : "Bonus", w: "w-[150px]" },
            ...(canManage ? [{ label: <span className="sr-only">{ar ? "تعديل" : "Edit"}</span>, w: "w-[100px]" }] : []),
          ]}
        >
          {rows.map((r) => {
            const pct = Number(r.achievedPercent);
            return (
              <Tr key={r.id} testId={`target-${r.employeeId}`}>
                <Td>
                  <span className="block">{r.employee.name}</span>
                  {r.note && (
                    <span className="block text-[12px] leading-[18px] text-oo-text-muted">{r.note}</span>
                  )}
                </Td>
                <Td>
                  <Money value={r.targetAmount} currency={r.currency} />
                </Td>
                <Td>
                  <Money value={r.achieved} currency={r.currency} />
                </Td>
                <Td>
                  {/* The shortfall rides in the bar's own caption rather than on a second
                      line, so every row is the same height the design gives it and the
                      figure a rep actually wants is still on the screen. */}
                  <ProgressBar
                    percent={pct}
                    testId={`progress-${r.employeeId}`}
                    label={
                      (ar ? `تحقّق ${num(Math.round(pct), "ar")}٪` : `${Math.round(pct)}% achieved`) +
                      (r.met
                        ? ""
                        : ` · ${ar ? "المتبقي" : "shortfall"} ${
                            ar ? toArabicDigits(formatMoney(r.shortfall, 0)) : formatMoney(r.shortfall, 0)
                          } ${ar ? "ر.س" : r.currency}`)
                    }
                  />
                </Td>
                <Td>
                  {Number(r.bonusAmount) > 0 ? (
                    <Money value={r.bonusAmount} currency={r.currency} />
                  ) : (
                    <span className="text-oo-text-muted">—</span>
                  )}
                </Td>
                {canManage && (
                  <Td>
                    <button
                      onClick={() => setEditing(r)}
                      data-testid={`edit-target-${r.employeeId}`}
                      className={`${ROW_ACTION} text-oo-action-primary hover:border-oo-action-primary`}
                    >
                      {ar ? "تعديل" : "Edit"}
                    </button>
                  </Td>
                )}
              </Tr>
            );
          })}
        </DataTable>
      )}

      <p className="text-[12px] leading-[18px] text-oo-text-muted">
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
            reload();
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
