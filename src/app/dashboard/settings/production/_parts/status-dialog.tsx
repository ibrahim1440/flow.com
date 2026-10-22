"use client";
// RM4b «تغيير حالة …» (Figma 395:1701, phone sheet 384:104). POST …/roasters/[id]/status. The frame's
// panel of affected planned slots («7 خانات مخططة اليوم تتأثر») is not drawn here: no schedule
// exists yet (RM6–RM8 are later work), so there is no planned slot to affect.
import { useState } from "react";
import { Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { call, errText, Seg, STATUS, useLang, type FieldError, type Roaster } from "./shared";

type S = "AVAILABLE" | "MAINTENANCE" | "STOPPED";

type Props = { roaster: Roaster | null; open: boolean; onClose: () => void; onSaved: (r: Roaster) => void };

/** Mounted afresh each time it opens, so it starts from the roaster's current status. */
export function StatusDialog(props: Props) {
  return props.open && props.roaster ? <StatusForm {...props} roaster={props.roaster} /> : null;
}

function StatusForm({ roaster, open, onClose, onSaved }: Props & { roaster: Roaster }) {
  const { ar, L } = useLang();
  const [status, setStatus] = useState<S>(roaster.status === "RETIRED" ? "STOPPED" : roaster.status);
  const [reason, setReason] = useState(roaster.statusReason ?? "");
  const [until, setUntil] = useState(roaster.statusUntil ? roaster.statusUntil.slice(0, 10) : "");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const err = (f: string) => { const e = errors.find((x) => x.field === f); return e ? (ar ? e.ar : e.en) : null; };

  async function submit() {
    if (busy) return;
    setBusy(true);
    setAlert(null);
    const r = await call<{ roaster: Roaster }>(`/api/settings/production/roasters/${roaster.id}/status`, "POST", {
      status, reason, until: status === "AVAILABLE" || !until ? null : `${until}T23:59:59+03:00`,
    });
    setBusy(false);
    if (r.ok) { onSaved(r.data.roaster); onClose(); return; }
    if (r.data.code === "INVALID_FIELDS" && r.data.fields) { setErrors(r.data.fields); return; }
    setAlert(errText(r.data, ar));
  }

  const action = status === "STOPPED" ? L("إيقاف الحمّاصة", "Stop the roaster") : status === "MAINTENANCE" ? L("تحويل إلى الصيانة", "Put into maintenance") : L("إتاحة الحمّاصة", "Make available");
  return (
    <Dialog
      open={open}
      title={L(`تغيير حالة ${roaster.name}`, `Change the status of ${roaster.name}`)}
      sub={L("الحمّاصة غير المتاحة لا تُجدول عليها دفعات جديدة.", "No new batches are scheduled on a roaster that is not available.")}
      onClose={() => { if (!busy) onClose(); }}
      testId="status-dialog"
      actions={<>
        <Btn onClick={onClose} disabled={busy}>{L("إلغاء", "Cancel")}</Btn>
        <Btn variant={status === "AVAILABLE" ? "primary" : "danger"} busy={busy} onClick={() => void submit()} data-testid="status-confirm">{action}</Btn>
      </>}
    >
      <form className="hr-stack" style={{ gap: 14 }} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="hr-field">
          <span className="hr-label">{L("الحالة الجديدة", "New status")} *</span>
          <Seg<S> value={status} label={L("الحالة الجديدة", "New status")} onChange={setStatus} testId="status-seg"
            options={(["AVAILABLE", "MAINTENANCE", "STOPPED"] as const).map((s) => [s, ar ? STATUS[s][0] : STATUS[s][1]])} />
        </div>
        {status !== "AVAILABLE" ? (
          <>
            <Field label={`${L("السبب", "Reason")} *`} error={err("reason")}>
              <input className="hr-input" value={reason} maxLength={300} aria-invalid={err("reason") ? true : undefined} onChange={(e) => setReason(e.target.value)} data-testid="status-reason" />
            </Field>
            <Field label={L("حتى", "Until")} error={err("until")} help={L("تعود «متاحة» يدويًا.", "It returns to «Available» by hand.")}>
              <input className="hr-input" type="date" dir="ltr" value={until} onChange={(e) => setUntil(e.target.value)} data-testid="status-until" />
            </Field>
          </>
        ) : null}
        {alert ? <div className="hr-notice tone-danger" role="alert">{alert}</div> : null}
      </form>
    </Dialog>
  );
}
