"use client";
// RM6 «جدول التحميص · اليوم» (Figma 399:2339 at 1440, 401:2503 at 1024): each production roaster's lane
// for the day with the recorded batches (done, rejected), the running slot and the planned slots, the
// now-line, and «الخانات القادمة» with the planned green beside the actual green and roasted («—» until
// recorded). Planned and actual are never merged.
import { useCallback, useEffect, useState } from "react";
import { Btn, Notice, OpsBanner, OpsLoading } from "@/components/ops/ui";
import { useUser } from "../../../user-context";
import {
  addDays, call, dayLabel, riyadhKeyOf, errText, keyIso, Lanes, Legend, N, NoRoaster, NowText, ScheduleFrame, SlotActions, STATUS_TEXT, timeOf, useLang, useSlotActions,
  type ApiError, type DayData, type Slot,
} from "./shared";
import { Retry } from "../../../settings/production/_parts/shared";

export function DayView({ initialDay, approved }: { initialDay: string | null; approved?: string | null }) {
  const { ar, L } = useLang();
  const me = useUser()?.id ?? null;
  const [day, setDay] = useState<string | null>(initialDay);
  const [data, setData] = useState<DayData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(() => (approved ? { tone: "success", text: ar ? `اعتُمدت الخطة: ${approved} خانة محجوزة. لم تُنشأ دفعات ولم يُصرف بن.` : `Plan approved: ${approved} slots reserved. No batch was created and no green was used.` } : null));
  const [token, setToken] = useState(0);
  const reload = useCallback(() => setToken((t) => t + 1), []);
  useEffect(() => {
    let off = false;
    void call<DayData>(`/api/production/schedule${day ? `?date=${day}` : ""}`).then((r) => {
      if (off) return;
      if (r.ok) { setData(r.data); setError(null); } else setError(r.data);
    });
    return () => { off = true; };
  }, [day, token]);
  const actions = useSlotActions((m) => { setMsg({ tone: "success", text: m }); reload(); });
  async function start(s: Slot) {
    const r = await call(`/api/production/schedule/slots/${s.id}/start`, "POST", {});
    setMsg(r.ok ? { tone: "success", text: L("بدأت الخانة.", "The slot was started.") } : { tone: "danger", text: errText(r.data, ar) });
    reload();
  }
  const shown = data?.day ?? day;
  const when = data ? (
    <>
      <Btn size="sm" variant="ghost" onClick={() => setDay(addDays(data.day, -1))} aria-label={L("اليوم السابق", "Previous day")} data-testid="day-prev">{ar ? "›" : "‹"}</Btn>
      {data.day === data.today ? <NowText now={data.now} /> : <span>{dayLabel(keyIso(data.day), ar)}</span>}
      <Btn size="sm" variant="ghost" onClick={() => setDay(addDays(data.day, 1))} aria-label={L("اليوم التالي", "Next day")} data-testid="day-next">{ar ? "‹" : "›"}</Btn>
      {data.day !== data.today ? <Btn size="sm" onClick={() => setDay(data.today)}>{L("اليوم", "Today")}</Btn> : null}
    </>
  ) : null;
  const productCell = (s: Slot) => <><strong className="rs-strong">{ar ? s.product.ar : s.product.en}</strong>{s.purpose === "STOCK" ? <> · {L("للمخزون", "for stock")}</> : null}</>;
  const statusCell = (s: Slot) => {
    const [a, e] = STATUS_TEXT[s.status];
    const tone = s.status === "IN_PROGRESS" ? "info" : s.status === "MISSED" ? "warning" : s.status === "RECORDED" ? "success" : "neutral";
    return <span className={`hr-dot tone-${tone}`}><span>{ar ? a : e}{s.status === "IN_PROGRESS" && s.startedAt ? <> · {L("بدأت", "started")} <N>{timeOf(s.startedAt)}</N></> : null}</span></span>;
  };
  return (
    <ScheduleFrame view="day" when={when} testId="schedule-day">
      {msg ? <div style={{ paddingTop: 16 }}><OpsBanner tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</OpsBanner></div> : null}
      {error ? <div className="rs-stack"><Retry error={error} onRetry={reload} /></div> : !data ? <div className="rs-stack"><OpsLoading rows={6} /></div> : data.roasters.length === 0 ? (
        <div className="rs-stack"><NoRoaster /></div>
      ) : (
        <div className="rs-stack">
          <section aria-label={L("مسارات المحامص", "Roaster lanes")} style={{ paddingTop: 18 }}>
            <Lanes lanes={data.roasters} day={data.day} now={data.now} />
            <Legend missed={data.counts.missed > 0} />
            {data.unassignedBatches.length ? <p className="ss-muted">{L("دفعات مسجّلة اليوم بلا محمصة محددة:", "Batches recorded today with no roaster:")} {data.unassignedBatches.map((b) => b.batchNumber).join("، ")}</p> : null}
          </section>
          <section aria-label={L("الخانات القادمة", "Coming slots")}>
            <div className="ss-bh">
              <h2>{L("الخانات القادمة", "Coming slots")}</h2>
              <span>{L("المخطط منفصل عن الفعلي · الأوزان الفعلية تُسجَّل بعد التحميص فقط", "Planned is kept apart from actual · actual weights are recorded after the roast only")}</span>
              {data.upcomingTotal > data.upcoming.length ? <span className="ss-bh-end" data-testid="more-slots"><strong>{ar ? `${data.upcomingTotal - data.upcoming.length} خانات أخرى` : `${data.upcomingTotal - data.upcoming.length} more slots`}</strong></span> : null}
            </div>
            {data.upcoming.length === 0 ? (
              <p className="ss-muted" data-testid="no-upcoming">{L("لا خانات قادمة. خطّط الدفعات من «تخطيط الدفعات».", "No coming slots. Plan batches in «Batch planning».")}</p>
            ) : (
              <div className="hr-tablewrap">
                <table className="hr-table rs-table" data-testid="upcoming-table">
                  <thead><tr>
                    <th>{L("الوقت", "Time")}</th><th>{L("المنتج والطلب", "Coffee")}</th><th className="hr-hide-mobile">{L("المحمصة", "Roaster")}</th><th>{L("المشغّل", "Operator")}</th>
                    <th className="is-num">{L("أخضر مخطط", "Planned green")}</th><th className="is-num hr-hide-mobile">{L("أخضر فعلي", "Actual green")}</th><th className="is-num hr-hide-mobile">{L("محمص فعلي", "Actual roasted")}</th>
                    <th>{L("الحالة", "Status")}</th><th aria-label={L("إجراءات", "Actions")} />
                  </tr></thead>
                  <tbody>
                    {data.upcoming.map((s) => (
                      <tr key={s.id} className={s.status === "IN_PROGRESS" ? "is-current" : undefined} data-testid="upcoming-row">
                        <td><N>{timeOf(s.startsAt)}</N>{riyadhKeyOf(s.startsAt) !== data.today ? <span className="ss-sub">{dayLabel(s.startsAt, ar, true)}</span> : null}</td>
                        <td>{productCell(s)}</td>
                        <td className="hr-hide-mobile">{data.roasters.find((r) => r.id === s.roasterId)?.name ?? "—"}</td>
                        <td>{s.operatorName ?? "—"}</td>
                        <td className="is-num"><N>{s.plannedGreenKg}</N></td>
                        <td className="is-num hr-hide-mobile">{s.batch ? <N>{s.batch.greenKg}</N> : "—"}</td>
                        <td className="is-num hr-hide-mobile">{s.batch ? <N>{s.batch.roastedKg}</N> : "—"}</td>
                        <td>{statusCell(s)}</td>
                        <td><SlotActions slot={s} can={data.can} me={me} today={data.today} onStart={(x) => void start(x)} open={actions.open} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {shown && data.roasters.some((r) => r.slots.some((s) => s.status === "MISSED")) ? (
            <section aria-label={L("خانات فائتة", "Missed slots")}>
              <div className="ss-bh"><h2>{L("خانات فائتة", "Missed slots")}</h2><span>{L("انتهى وقتها دون دفعة مسجّلة · للمتابعة", "Their time passed with no batch recorded · for follow-up")}</span></div>
              <div className="hr-tablewrap">
                <table className="hr-table rs-table" data-testid="missed-table">
                  <tbody>
                    {data.roasters.flatMap((r) => r.slots.filter((s) => s.status === "MISSED")).map((s) => (
                      <tr key={s.id} data-testid="missed-row">
                        <td><N>{timeOf(s.startsAt)}</N></td><td>{productCell(s)}</td><td>{s.operatorName ?? "—"}</td><td className="is-num"><N>{s.plannedGreenKg}</N></td>
                        <td>{statusCell(s)}</td><td><SlotActions slot={s} can={data.can} me={me} today={data.today} onStart={(x) => void start(x)} open={actions.open} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
          <Notice tone="info">{L("الخانة المخططة ليست دفعة: لا تُصرف بنًا أخضر ولا تُحتسب في تقدم الطلب. عند «تسجيل الدفعة» تُربط الخانة بالدفعة الجديدة وتُحفظ أوزانها الفعلية إلى جانب المخطط.", "A planned slot is not a batch: it uses no green coffee and does not count toward order progress. When the batch is recorded, the slot is linked to it and its actual weights are kept beside the plan.")}</Notice>
        </div>
      )}
      {actions.dialogs}
    </ScheduleFrame>
  );
}
