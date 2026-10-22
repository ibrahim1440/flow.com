"use client";
// Production › «جدول التحميص» — the pieces the three views share (Figma 377:2: RM6 399:2339 / 401:2503,
// RM7 403:2650 / 405:2837, RM8 407:3005 / 409:3167). Presentation and requests only; every rule is the
// API's (/api/production/schedule/**, src/lib/services/schedule/planner.ts).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Boxes, Flame } from "lucide-react";
import { Btn, PageHeader, Tabs } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { useI18n } from "@/lib/i18n/context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useUser } from "../../../user-context";
import { call, dayLabel, errText, Seg, timeOf, useLang, type ApiError } from "../../../settings/production/_parts/shared";
import "./schedule.css";

export { call, dayLabel, errText, timeOf, useLang, type ApiError };

export const BASE = "/dashboard/production/schedule";
export type View = "queue" | "day" | "roasters" | "plan";

export type Can = { view: boolean; manage: boolean; roastToStock: boolean; startBatch: boolean; manageRoasters: boolean };
export type SlotStatus = "PLANNED" | "IN_PROGRESS" | "RECORDED" | "CANCELLED" | "MISSED";
export type BatchLite = { id: string; batchNumber: string; status: string; greenKg: string; roastedKg: string; recordedAt: string };
export type Slot = {
  id: string; planId: string | null; roasterId: string; operatorId: string; operatorName: string | null;
  productId: string; product: { ar: string; en: string }; purpose: "DEMAND" | "STOCK";
  startsAt: string; endsAt: string; plannedGreenKg: string; status: SlotStatus; storedStatus: string;
  startedAt: string | null; cancelReason: string | null; batch: BatchLite | null;
};
export type WorkingHours = { days: number[]; start: string; end: string };
export type RoasterInfo = {
  id: string; name: string; status: string; statusReason: string | null; isDefault: boolean; cycleMinutes: number;
  nominalKg: string; targetKg: string; minKg: string; maxKg: string; workingHours: WorkingHours; workingHoursSet: boolean; defaultOperatorId: string | null;
};
export type Lane = RoasterInfo & {
  window: { start: string; end: string } | null;
  maintenance: { id: string; title: string; startsAt: string; endsAt: string }[];
  slots: Slot[];
  batches: (BatchLite & { roasterId: string | null; product: { ar: string; en: string } })[];
};
export type DayData = {
  day: string; today: string; now: string; roasters: Lane[]; unassignedBatches: Lane["batches"]; upcoming: Slot[]; upcomingTotal: number;
  counts: { recorded: number; rejected: number; inProgress: number; planned: number; missed: number }; can: Can;
};

/** The noon of a Riyadh day key, so the settings date helpers (Riyadh) name the right day. */
export const keyIso = (key: string) => `${key}T12:00:00+03:00`;
export const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const riyadhNowKey = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

/** Weights as a number run («5.05»), LTR-isolated inside Arabic. */
export function N({ children }: { children: ReactNode }) {
  return <bdi dir="ltr" className="hr-num">{children}</bdi>;
}

export const STATUS_TEXT: Record<SlotStatus, [string, string]> = {
  PLANNED: ["مخططة", "Planned"], IN_PROGRESS: ["جارية", "In progress"], RECORDED: ["مسجّلة", "Recorded"],
  CANCELLED: ["ملغاة", "Cancelled"], MISSED: ["فائتة", "Missed"],
};

/** The page heading of the approved Phase 4 shell (title, meta, «تحميص للمخزون» · «تسجيل دفعة», the module tabs) and the view row. */
export function ScheduleFrame({ view, when, children, testId }: { view: View; when?: ReactNode; children: ReactNode; testId?: string }) {
  const { t } = useI18n();
  const { L } = useLang();
  const router = useRouter();
  const user = useUser();
  const can = (k: string) => hasSubPrivilege(user?.permissions ?? {}, "production", k);
  const views: [View, string][] = [["queue", t("schedViewQueue")], ["day", t("schedViewDay")], ["roasters", t("schedViewRoasters")], ["plan", t("schedViewPlan")]];
  const go = (v: View) => router.push(v === "queue" ? "/dashboard/production?tab=pending" : v === "day" ? BASE : `${BASE}?view=${v}`);
  return (
    <div className="hr-page" data-testid={testId}>
      <PageHeader
        title={t("opsProductionTitle")}
        actions={can("start_batch") ? (
          <>
            {can("roast_to_stock") ? <Link href="/dashboard/production?tab=pending" className="hr-btn"><Boxes size={15} aria-hidden="true" /> {t("roastToStock")}</Link> : null}
            <Link href="/dashboard/production?tab=pending" className="hr-btn is-primary" data-testid="record-batch-link"><Flame size={15} aria-hidden="true" /> {L("تسجيل دفعة", "Record batch")}</Link>
          </>
        ) : null}
      />
      <Tabs
        label={t("production")}
        value={"pending" as string}
        onChange={(k) => {
          if (k === "orders") router.push("/dashboard/production-orders");
          else if (k === "packaging") router.push("/dashboard/packaging");
          else if (k === "pending") go("day");
          else router.push(`/dashboard/production?tab=${k}`);
        }}
        items={[
          { key: "batches", label: t("opsTabOverview") },
          { key: "orders", label: t("opsTabOrders") },
          { key: "pending", label: t("opsTabSchedule") },
          { key: "blend", label: t("opsTabBlend") },
          { key: "packaging", label: t("packaging") },
        ]}
      />
      <div className="rs-viewrow">
        <Seg value={view} label={t("opsTabSchedule")} options={views} onChange={go} testId="schedule-views" />
        {when ? <span className="rs-when">{when}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** The view switch inside the production page's «جدول التحميص» tab (the roast queue is its first view). */
export function ScheduleViews() {
  const { t } = useI18n();
  const router = useRouter();
  const views: [View, string][] = [["queue", t("schedViewQueue")], ["day", t("schedViewDay")], ["roasters", t("schedViewRoasters")], ["plan", t("schedViewPlan")]];
  return <div className="rs-viewrow" style={{ paddingTop: 0 }}><Seg value={"queue" as View} label={t("opsTabSchedule")} options={views} onChange={(v) => { if (v !== "queue") router.push(v === "day" ? BASE : `${BASE}?view=${v}`); }} testId="schedule-views" /></div>;
}

/** No production roaster: the clean empty state, with the way to roaster settings (ROASTERS.md §2). */
export function NoRoaster() {
  const { t } = useI18n();
  const user = useUser();
  const { L } = useLang();
  return (
    <div className="ss-empty" data-testid="schedule-empty">
      <strong>{t("schedNoRoasterTitle")}</strong>
      <p>{t("schedNoRoasterBody")}</p>
      {user?.role === "admin"
        ? <Link href="/dashboard/settings/production" className="hr-btn is-primary" data-testid="schedule-empty-settings">{t("schedRoasterSettings")}</Link>
        : <p>{L("يضيفها المدير من الإعدادات.", "The administrator adds it in Settings.")}</p>}
    </div>
  );
}

/** «الثلاثاء 6 أكتوبر · 10:42». */
export function NowText({ now }: { now: string }) {
  const { ar } = useLang();
  return <span>{dayLabel(now, ar)} · <N>{timeOf(now)}</N></span>;
}

// ── Lanes (RM6 / RM8) ───────────────────────────────────────────────────────────────────────

const minutesOfDay = (iso: string) => { const t = timeOf(iso); return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); };

/** Roaster lanes on one time axis: working window, maintenance, recorded batches, slots and the now-line. */
export function Lanes({ lanes, day, now, conflictIds, onSlot, subOf }: {
  lanes: Lane[]; day: string; now: string; conflictIds?: Set<string>; onSlot?: (s: Slot) => void; subOf?: (l: Lane) => ReactNode;
}) {
  const { ar, L } = useLang();
  // The axis spans every lane's working window and everything drawn on the day (whole hours).
  let lo = Infinity, hi = -Infinity;
  for (const l of lanes) {
    if (l.window) { lo = Math.min(lo, minutesOfDay(l.window.start)); hi = Math.max(hi, minutesOfDay(l.window.end)); }
    for (const s of l.slots) { lo = Math.min(lo, minutesOfDay(s.startsAt)); hi = Math.max(hi, minutesOfDay(s.endsAt) || 24 * 60); }
    for (const b of l.batches) { lo = Math.min(lo, minutesOfDay(b.recordedAt) - l.cycleMinutes); hi = Math.max(hi, minutesOfDay(b.recordedAt)); }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 7 * 60; hi = 15 * 60; }
  lo = Math.max(0, Math.floor(lo / 60) * 60); hi = Math.min(24 * 60, Math.ceil(hi / 60) * 60);
  const span = Math.max(60, hi - lo);
  const pos = (m: number) => `${((Math.max(lo, Math.min(hi, m)) - lo) / span) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, Math.min(hi, b) - Math.max(lo, a)) / span) * 100}%`;
  const hours: number[] = [];
  for (let h = lo; h <= hi; h += 60) hours.push(h);
  const nowM = minutesOfDay(now);
  const showNow = now.slice(0, 10) && riyadhKeyOf(now) === day && nowM >= lo && nowM <= hi;
  const short = (p: { ar: string; en: string }) => (ar ? p.ar : p.en);
  return (
    <div className="rs-boardwrap">
      <div className="rs-board" data-testid="schedule-board">
        {lanes.map((l, i) => (
          <div className="rs-lane" key={l.id} data-testid="schedule-lane">
            <div className="rs-lname"><strong>{l.name}</strong><span>{subOf ? subOf(l) : <>{L("محمصة الإنتاج", "Production roaster")} · <N>{Number(l.nominalKg)}</N> {L("كغ", "kg")}</>}</span></div>
            <div className={`rs-track${l.window ? "" : " is-off"}`} title={l.window ? undefined : L("يوم عطلة", "Day off")}>
              {l.window ? <i className="rs-hours" style={{ insetInlineStart: pos(minutesOfDay(l.window.start)), width: width(minutesOfDay(l.window.start), minutesOfDay(l.window.end)) }} /> : null}
              {l.maintenance.map((m) => {
                const a = riyadhKeyOf(m.startsAt) < day ? lo : minutesOfDay(m.startsAt), b = riyadhKeyOf(m.endsAt) > day ? hi : minutesOfDay(m.endsAt);
                return <i key={m.id} className="rs-maint" title={m.title} style={{ insetInlineStart: pos(a), width: width(a, b) }} />;
              })}
              {l.batches.map((b) => {
                const end = minutesOfDay(b.recordedAt), start = end - l.cycleMinutes;
                const rejected = b.status === "Rejected";
                return (
                  <span key={b.id} className={`rs-blk ${rejected ? "is-rejected" : "is-recorded"}`} style={{ insetInlineStart: pos(start), width: width(start, end) }} title={`${b.batchNumber} · ${short(b.product)}`} data-testid="lane-batch">
                    <span>{short(b.product)}</span><span>{rejected ? L("رُفضت", "Rejected") : L("تم", "Done")}</span>
                  </span>
                );
              })}
              {l.slots.filter((s) => s.status !== "CANCELLED").map((s) => {
                const a = minutesOfDay(s.startsAt), b = riyadhKeyOf(s.endsAt) > day ? hi : minutesOfDay(s.endsAt);
                const conflict = conflictIds?.has(s.id);
                const cls = s.status === "RECORDED" ? (s.batch?.status === "Rejected" ? "is-rejected" : "is-recorded") : s.status === "IN_PROGRESS" ? "is-running" : s.status === "MISSED" ? "is-missed" : "";
                const second = conflict ? L("تعارض", "Conflict") : s.status === "RECORDED" ? (s.batch?.status === "Rejected" ? L("رُفضت", "Rejected") : L("تم", "Done")) : s.status === "IN_PROGRESS" ? L("جارية", "Running") : s.status === "MISSED" ? L("فائتة", "Missed") : timeOf(s.startsAt);
                const Tag = onSlot ? "button" : "span";
                return (
                  <Tag key={s.id} {...(onSlot ? { type: "button" as const, onClick: () => onSlot(s) } : {})} className={`rs-blk ${cls}${conflict ? " is-conflict" : ""}`} style={{ insetInlineStart: pos(a), width: width(a, b), cursor: onSlot ? "pointer" : undefined }}
                    title={`${short(s.product)} · ${timeOf(s.startsAt)}–${timeOf(s.endsAt)} · ${s.plannedGreenKg} ${L("كغ", "kg")} · ${s.operatorName ?? ""}`} data-testid="lane-slot" data-status={s.status}>
                    <span>{short(s.product)}</span><span>{second}</span>
                  </Tag>
                );
              })}
              {showNow && i === 0 ? <i className="rs-now" style={{ insetInlineStart: pos(nowM) }}><span>{timeOf(now)}</span></i> : null}
              {showNow && i > 0 ? <i className="rs-now" style={{ insetInlineStart: pos(nowM), top: -4 }} /> : null}
            </div>
          </div>
        ))}
        <div className="rs-axis" aria-hidden>
          {hours.map((h) => <span key={h} style={{ insetInlineStart: pos(h) }}>{`${Math.floor(h / 60)}:00`}</span>)}
        </div>
      </div>
    </div>
  );
}

export function riyadhKeyOf(iso: string) {
  return new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 10);
}

export function Legend({ conflict, missed }: { conflict?: boolean; missed?: boolean }) {
  const { L } = useLang();
  return (
    <div className="rs-legend" aria-hidden>
      <span><i className="rs-sw is-recorded" />{L("مسجّلة", "Recorded")}</span>
      <span><i className="rs-sw is-rejected" />{L("مرفوضة", "Rejected")}</span>
      <span><i className="rs-sw is-running" />{L("جارية", "Running")}</span>
      <span><i className="rs-sw" />{L("مخططة", "Planned")}</span>
      {missed ? <span><i className="rs-sw is-missed" />{L("فائتة", "Missed")}</span> : null}
      {conflict ? <span><i className="rs-sw is-conflict" />{L("تعارض", "Conflict")}</span> : null}
    </div>
  );
}

// ── Slot actions (start · link · move · cancel) ─────────────────────────────────────────────

type Operator = { id: string; name: string };

/** The dialogs behind a slot's actions. Opened by `open({ kind, slot })`; reloads the view on success. */
export function useSlotActions(onDone: (msg: string) => void) {
  const [state, setState] = useState<{ kind: "move" | "cancel" | "link"; slot: Slot; operatorOnly?: boolean } | null>(null);
  const dialogs = state ? <SlotDialog key={`${state.kind}-${state.slot.id}`} {...state} onClose={() => setState(null)} onDone={(m) => { setState(null); onDone(m); }} /> : null;
  return { open: setState, dialogs };
}

function SlotDialog({ kind, slot, operatorOnly, onClose, onDone }: { kind: "move" | "cancel" | "link"; slot: Slot; operatorOnly?: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const { ar, L } = useLang();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [day, setDay] = useState(riyadhKeyOf(slot.startsAt));
  const [time, setTime] = useState(timeOf(slot.startsAt));
  const [operatorId, setOperatorId] = useState(slot.operatorId);
  const [ops, setOps] = useState<Operator[] | null>(null);
  const [batches, setBatches] = useState<BatchLite[] | null>(null);
  const [batchId, setBatchId] = useState("");
  useEffect(() => {
    if (kind === "move") void call<{ operators: Operator[] }>("/api/production/schedule/plans/preview", "POST", { productId: slot.productId, roasterId: slot.roasterId }).then((r) => setOps(r.ok ? r.data.operators : []));
    if (kind === "link") void call<{ batches: BatchLite[] }>(`/api/production/schedule/slots/${slot.id}/link`).then((r) => setBatches(r.ok ? r.data.batches : []));
  }, [kind, slot]);
  async function submit() {
    setBusy(true); setErr(null);
    const r = kind === "move"
      ? await call(`/api/production/schedule/slots/${slot.id}`, "PATCH", operatorOnly ? { operatorId } : { startsAt: `${day}T${time}:00+03:00`, operatorId })
      : kind === "cancel"
        ? await call(`/api/production/schedule/slots/${slot.id}/cancel`, "POST", { reason })
        : await call(`/api/production/schedule/slots/${slot.id}/link`, "POST", { batchId });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, ar, "تعذّر الحفظ.", "Could not save.")); return; }
    onDone(kind === "move" ? L("نُقلت الخانة.", "The slot was moved.") : kind === "cancel" ? L("أُلغيت الخانة وعادت إلى قائمة العمل.", "The slot was cancelled and returned to the work queue.") : L("رُبطت الخانة بالدفعة.", "The slot was linked to the batch."));
  }
  const title = kind === "move" ? (operatorOnly ? L("إسناد الخانة", "Reassign the slot") : L("نقل الخانة", "Move the slot")) : kind === "cancel" ? L("إلغاء الخانة", "Cancel the slot") : L("ربط بدفعة مسجّلة", "Link a recorded batch");
  const ok = kind === "cancel" ? reason.trim().length > 0 : kind === "link" ? !!batchId : true;
  return (
    <Dialog open title={title} onClose={onClose} testId={`slot-${kind}-dialog`}
      sub={<>{ar ? slot.product.ar : slot.product.en} · <N>{timeOf(slot.startsAt)}</N> · <N>{slot.plannedGreenKg}</N> {L("كغ", "kg")}</>}
      actions={<>
        <Btn onClick={onClose}>{L("رجوع", "Back")}</Btn>
        <Btn variant={kind === "cancel" ? "danger" : "primary"} busy={busy} disabled={!ok} onClick={() => void submit()} data-testid={`slot-${kind}-confirm`}>{kind === "cancel" ? L("إلغاء الخانة", "Cancel slot") : kind === "link" ? L("ربط", "Link") : L("حفظ", "Save")}</Btn>
      </>}>
      {err ? <div className="hr-notice tone-danger" role="alert" data-testid="slot-dialog-error">{err}</div> : null}
      {kind === "move" ? (
        <div className="rs-pickers">
          {operatorOnly ? null : <>
            <label className="hr-field"><span className="hr-label">{L("اليوم", "Day")}</span><input className="hr-input" type="date" dir="ltr" value={day} onChange={(e) => setDay(e.target.value)} data-testid="move-day" /></label>
            <label className="hr-field"><span className="hr-label">{L("البدء", "Start")}</span><input className="hr-input" type="time" dir="ltr" step={300} value={time} onChange={(e) => setTime(e.target.value)} data-testid="move-time" /></label>
          </>}
          <label className="hr-field"><span className="hr-label">{L("المشغّل", "Operator")}</span>
            <Select className="hr-select" value={operatorId} onChange={(e) => setOperatorId(e.target.value)} data-testid="move-operator">
              {(ops ?? []).some((o) => o.id === slot.operatorId) ? null : <option value={slot.operatorId}>{slot.operatorName ?? "—"}</option>}
              {(ops ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </label>
        </div>
      ) : kind === "cancel" ? (
        <>
          <p style={{ margin: "0 0 10px" }}>{L("تعود الخانة إلى قائمة العمل غير مجدولة. لا يُلغى طلب ولا يُصرف بن.", "The slot returns to the work queue unscheduled. No order is cancelled and no green is used.")}</p>
          <label className="hr-field"><span className="hr-label">{L("السبب *", "Reason *")}</span><input className="hr-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="cancel-reason" /></label>
        </>
      ) : batches === null ? <p>{L("جارٍ التحميل…", "Loading…")}</p> : batches.length === 0 ? <p data-testid="link-none">{L("لا دفعة مسجّلة غير مربوطة من هذه القهوة منذ يوم الخانة.", "No unlinked recorded batch of this coffee since the slot's day.")}</p> : (
        <label className="hr-field"><span className="hr-label">{L("الدفعة", "Batch")}</span>
          <Select className="hr-select" value={batchId} onChange={(e) => setBatchId(e.target.value)} placeholder={L("اختر الدفعة", "Choose the batch")} data-testid="link-batch">
            <option value="">{L("اختر الدفعة", "Choose the batch")}</option>
            {batches.map((b) => <option key={b.id} value={b.id}>{`${b.batchNumber} · ${b.greenKg} → ${b.roastedKg} ${ar ? "كغ" : "kg"} · ${timeOf(b.recordedAt)}`}</option>)}
          </Select>
        </label>
      )}
    </Dialog>
  );
}

/** The action buttons of one slot row, by status and by what the viewer may do. */
export function SlotActions({ slot, can, me, today, onStart, open }: { slot: Slot; can: Can; me: string | null; today: string; onStart: (s: Slot) => void; open: (x: { kind: "move" | "cancel" | "link"; slot: Slot; operatorOnly?: boolean }) => void }) {
  const { L } = useLang();
  const mine = !!me && slot.operatorId === me && can.startBatch;
  const out: ReactNode[] = [];
  if (slot.status === "PLANNED" && riyadhKeyOf(slot.startsAt) === today && (can.manage || mine)) out.push(<Btn key="s" size="sm" onClick={() => onStart(slot)} data-testid="slot-start">{L("بدء", "Start")}</Btn>);
  if ((slot.status === "IN_PROGRESS" || slot.status === "MISSED" || (slot.status === "PLANNED" && riyadhKeyOf(slot.startsAt) <= today)) && (can.manage || mine)) out.push(<Btn key="l" size="sm" onClick={() => open({ kind: "link", slot })} data-testid="slot-link">{L("ربط بدفعة", "Link batch")}</Btn>);
  if ((slot.status === "PLANNED" || slot.status === "MISSED") && slot.storedStatus === "PLANNED" && can.manage) out.push(<Btn key="m" size="sm" onClick={() => open({ kind: "move", slot })} data-testid="slot-move">{L("نقل", "Move")}</Btn>);
  if ((slot.status === "PLANNED" || slot.status === "IN_PROGRESS" || slot.status === "MISSED") && can.manage) out.push(<Btn key="c" size="sm" variant="ghost" onClick={() => open({ kind: "cancel", slot })} data-testid="slot-cancel">{L("إلغاء", "Cancel")}</Btn>);
  return out.length ? <span className="rs-acts">{out}</span> : null;
}
