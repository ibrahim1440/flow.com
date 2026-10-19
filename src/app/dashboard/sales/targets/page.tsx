"use client";

import { useState, useEffect } from "react";
import {
  useLang, Button, Field, TextInput, Select, TextArea, Modal, Alert, api, num, formatMoney, monthOptions,
} from "../_components/ui";
import { useInitialMonth, PerfHeader, MonthChip, Bar, PerfNote, PerfNotice, PerfSandbox, PerfLoading } from "../_components/perf";
import { usePhone } from "@/components/shell/page-context";
import { useUser } from "../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";

/**
 * Monthly sales targets and progress — Direction 2.1, GX A-P03 «الأهداف» (`1220:94392`, EN
 * `1233:60338`, 1024 `1220:94655`, 390 `1432:16430`).
 *
 * Progress is measured against COLLECTIONS, not against deal value, because that is what
 * the commission is measured against. A target tracked on pipeline value next to a
 * commission paid on cash collected disagree for months at a time, and the rep is looking
 * at the wrong one at exactly the moment they care most.
 *
 * Visual port: the request, the figures the server computes and the set / edit / remove
 * dialog are the ones this screen already had.
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

export default function TargetsPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const user = useUser();
  const phone = usePhone();
  const canManage = hasSubPrivilege(user?.permissions ?? {}, "sales", "lead_assign");

  const initialMonth = useInitialMonth();
  const [month, setMonth] = useState(initialMonth);
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

  if (loading) return <PerfLoading ar={ar} />;

  // "سبتمبر 2026" — the period the table is showing, in the reader's own calendar names.
  const monthLabel = monthOptions(month, lang).find((o) => o.value === month)?.label ?? month;
  const sar = (v: string, ccy: string) => `${formatMoney(v, 0)} ${ar ? (ccy === "SAR" ? "ر.س" : ccy) : ccy}`;
  const pctText = (r: Row) => `${num(Math.round(Number(r.achievedPercent)), lang)}%`;
  const caption = (r: Row) => (
    <>
      {ar ? "تحقّق" : "Achieved"} <span className="n">{pctText(r)}</span>
      {!r.met && <> · {ar ? "المتبقي" : "shortfall"} {sar(r.shortfall, r.currency)}</>}
    </>
  );
  const standing = (r: Row) =>
    r.note ?? (r.met ? (Number(r.achievedPercent) > 100 ? (ar ? "فوق الهدف" : "Above target") : (ar ? "حقّق الهدف" : "Target met")) : "—");
  const bonus = (r: Row) => (Number(r.bonusAmount) > 0 ? <span className="n">{formatMoney(r.bonusAmount)}</span> : <span className="sm">—</span>);

  const actions = (
    <>
      <MonthChip value={month} onChange={setMonth} lang={lang} testId="tg-month" />
      {canManage && (
        <button type="button" className="btn p" onClick={() => setEditing("new")} data-testid="new-target">
          <svg className="ico s" viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
          {ar ? "تعيين هدف" : "Set a target"}
        </button>
      )}
    </>
  );

  const meta = [
    monthLabel,
    ar ? "يُقاس على صافي المحصّل، لا على قيمة الطلبات" : "measured on net collections, not on order value",
    ...(scope === "own" ? [ar ? "هدفك فقط" : "your own target only"] : []),
  ];

  const empty = (
    <div data-testid="targets-empty" style={{ padding: "48px 0", textAlign: "center" }}>
      <p style={{ fontWeight: 500, margin: 0 }}>{ar ? "لم تُعيَّن أهداف لهذا الشهر." : "No targets set for this month."}</p>
      {canManage && (
        <p className="lbl" style={{ fontWeight: 400, marginTop: 6 }}>
          {ar ? "«تعيين هدف» يضيف هدف موظّف لهذا الشهر." : "“Set a target” adds one for this month."}
        </p>
      )}
    </div>
  );

  return (
    <div className="pg">
      <PerfHeader ar={ar} title={ar ? "الأداء والعمولات" : "Performance and commissions"}
        phoneTitle={ar ? "الأهداف" : "Targets"} meta={meta} actions={actions} />

      <PerfSandbox notice={notice} ar={ar} />
      <PerfNotice kind="error" ar={ar} onDismiss={() => setError("")}>{error}</PerfNotice>
      <PerfNotice kind="success" ar={ar} onDismiss={() => setSuccess("")}>{success}</PerfNotice>

      {rows.length === 0 ? empty : phone ? (
        <div data-testid="targets-table">
          {rows.map((r) => (
            <div key={r.id} className="mrow" data-testid={`target-${r.employeeId}`}>
              <span className="who"><bdi>{r.employee.name}</bdi></span>
              <span className="n">{formatMoney(r.achieved)}</span>
              <Bar percent={Number(r.achievedPercent)} testId={`progress-${r.employeeId}`}
                label={`${ar ? "تحقّق" : "Achieved"} ${pctText(r)}`} />
              <div className="r2">
                <span style={{ flex: 1 }}>{caption(r)}</span>
                <span>{ar ? "الهدف" : "Target"} <span className="n">{formatMoney(r.targetAmount)}</span></span>
              </div>
              <div className="r2">
                <span style={{ flex: 1 }}>
                  {ar ? "مكافأة التحقيق" : "Bonus"} {bonus(r)}
                  {standing(r) !== "—" && <> · {standing(r)}</>}
                </span>
                {canManage && (
                  <button type="button" className="btn sm" onClick={() => setEditing(r)} data-testid={`edit-target-${r.employeeId}`}>
                    {ar ? "تعديل" : "Edit"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="perf-scroll">
          <table className="t" data-testid="targets-table">
            <thead><tr>
              <th scope="col">{ar ? "الموظّف" : "Employee"}</th>
              <th scope="col" className="num">{ar ? "الهدف" : "Target"}</th>
              <th scope="col" className="num">{ar ? "المحقّق" : "Collected"}</th>
              <th scope="col">{ar ? "التقدّم" : "Progress"}</th>
              <th scope="col" className="num">{ar ? "مكافأة التحقيق" : "Bonus"}</th>
              {canManage && <th scope="col"><span className="sr-only">{ar ? "تعديل" : "Edit"}</span></th>}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid={`target-${r.employeeId}`}>
                  <td style={{ paddingBlock: 4 }}>
                    <div className="who"><bdi>{r.employee.name}</bdi></div>
                    <span className="perf-sub">{standing(r)}</span>
                  </td>
                  <td className="num">{formatMoney(r.targetAmount)}{r.currency !== "SAR" && <span className="unit">{r.currency}</span>}</td>
                  <td className="num">{formatMoney(r.achieved)}</td>
                  <td>
                    <div style={{ display: "grid", gap: 4, minWidth: 200 }}>
                      <Bar percent={Number(r.achievedPercent)} testId={`progress-${r.employeeId}`}
                        label={`${ar ? "تحقّق" : "Achieved"} ${pctText(r)}`} />
                      <span className="sm">{caption(r)}</span>
                    </div>
                  </td>
                  <td className="num">{bonus(r)}</td>
                  {canManage && (
                    <td style={{ textAlign: "end" }}>
                      <button type="button" className="btn sm" onClick={() => setEditing(r)} data-testid={`edit-target-${r.employeeId}`}>
                        {ar ? "تعديل" : "Edit"}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <PerfNote>
          <span>
            {ar
              ? "الهدف ليس نسبة عمولة. تحقيقه قد يستحق مكافأة، لكن المكافأة رقم يُقرَّر ويُسجَّل ولا يُدفع تلقائيًا، ولا يضيفه محرك العمولات إلى النسبة."
              : "A target is not a commission rate. Hitting it may pay a bonus, but the bonus is a figure someone decides and records — it is not paid automatically, and the accrual engine never adds it to a rate."}
          </span>
        </PerfNote>
      </div>

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
      <p className="text-[11px] text-oo-text-muted font-medium">
        {ar
          ? "لا يستطيع أحد تعيين هدفه بنفسه — لأن الهدف المصحوب بمكافأة هو أجر."
          : "Nobody sets their own target: a target with a bonus attached is pay."}
      </p>
    </Modal>
  );
}
