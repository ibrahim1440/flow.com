"use client";
// RM8 «المحامص والأسبوع» (Figma 407:3005 at 1440, 409:3167 at 1024): the load per production roaster and
// day (booked / available slots), the lanes of one day side by side, an operator conflict with its two
// resolutions («نقل الخانة» · «إسناد إلى …»), and the green distribution per coffee across roasters.
// Built for every production roaster in service: with one roaster it is one lane. The frame's «محمصة 2 ·
// سيناريو» is not invented — nothing here draws a roaster that is not registered.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Notice, OpsBanner, OpsLoading } from "@/components/ops/ui";
import { Btn } from "@/components/ops/ui";
import {
  BASE, call, dayLabel, keyIso, Lanes, Legend, N, NoRoaster, NowText, ScheduleFrame, timeOf, useLang, useSlotActions,
  type ApiError, type Can, type Lane, type RoasterInfo, type Slot,
} from "./shared";
import { Retry } from "../../../settings/production/_parts/shared";

type Week = {
  from: string; days: string[]; laneDay: string; now: string; roasters: RoasterInfo[];
  load: { roasterId: string; days: { day: string; booked: number; available: number; off: boolean }[] }[];
  lanes: Lane[];
  conflicts: { operatorId: string; operatorName: string | null; a: { id: string; roasterId: string; startsAt: string; endsAt: string }; b: { id: string; roasterId: string; startsAt: string; endsAt: string } }[];
  distribution: { productId: string; product: { ar: string; en: string }; orders: number[]; greenToPlanKg: string; approvedSlots: number; proposed: Opt | null; alternative: Opt | null }[];
  can: Can;
};
type Opt = { roasterId: string; roasterName: string; count: number; text: string | null; minutes: number | null };

export function RoastersView() {
  const { ar, L } = useLang();
  const [lane, setLane] = useState<string | null>(null);
  const [data, setData] = useState<Week | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  const reload = useCallback(() => setToken((t) => t + 1), []);
  useEffect(() => {
    let off = false;
    void call<Week>(`/api/production/schedule/week?days=3${lane ? `&lane=${lane}` : ""}`).then((r) => {
      if (off) return;
      if (r.ok) { setData(r.data); setError(null); } else setError(r.data);
    });
    return () => { off = true; };
  }, [lane, token]);
  const actions = useSlotActions((m) => { setMsg(m); reload(); });
  const conflictIds = new Set((data?.conflicts ?? []).flatMap((c) => [c.a.id, c.b.id]));
  const slotOf = (id: string): Slot | undefined => data?.lanes.flatMap((l) => l.slots).find((s) => s.id === id);
  const rname = (id: string) => data?.roasters.find((r) => r.id === id)?.name ?? "—";
  const operatorOfLane = (l: Lane) => {
    const names = [...new Set(l.slots.map((s) => s.operatorName).filter(Boolean))];
    return names.length ? names.join("، ") : L("لا خانات", "No slots");
  };
  return (
    <ScheduleFrame view="roasters" when={data ? <NowText now={data.now} /> : null} testId="schedule-roasters">
      {msg ? <div style={{ paddingTop: 16 }}><OpsBanner tone="success" onClose={() => setMsg(null)}>{msg}</OpsBanner></div> : null}
      {error ? <div className="rs-stack"><Retry error={error} onRetry={reload} /></div> : !data ? <div className="rs-stack"><OpsLoading rows={6} /></div> : data.roasters.length === 0 ? (
        <div className="rs-stack"><NoRoaster /></div>
      ) : (
        <div className="rs-stack">
          {data.roasters.length === 1 ? <Notice tone="info">{L("محمصة إنتاج واحدة مسجّلة. يظهر مسار لكل محمصة إنتاج تُضاف، وتعمل المحامص بالتوازي بمشغّلين مختلفين.", "One production roaster is registered. A lane appears for every production roaster added; roasters run in parallel with different operators.")}</Notice> : null}
          <section aria-label={L("الحمل حسب المحمصة", "Load per roaster")}>
            <div className="ss-bh"><h2>{L("الحمل حسب المحمصة", "Load per roaster")}</h2><span>{L("خانات محجوزة / متاحة", "slots booked / available")}</span></div>
            <div className="hr-tablewrap">
              <table className="hr-table rs-table" data-testid="load-table">
                <thead><tr><th>{L("المحمصة", "Roaster")}</th>{data.days.map((d) => (
                  <th key={d}><button type="button" className="rs-daybtn" aria-pressed={d === data.laneDay} onClick={() => setLane(d)} data-testid="load-day">{dayLabel(keyIso(d), ar)}</button></th>
                ))}</tr></thead>
                <tbody>
                  {data.roasters.map((r) => {
                    const row = data.load.find((x) => x.roasterId === r.id);
                    return (
                      <tr key={r.id} data-testid="load-row">
                        <td><strong className="rs-strong">{r.name}</strong><span className="ss-sub"><N>{Number(r.nominalKg)}</N> {L("كغ", "kg")} · {L("الهدف", "target")} <N>{r.targetKg}</N></span></td>
                        {row?.days.map((d) => <td key={d.day} className="rs-loadcell">{d.off || d.available === 0 ? "—" : <><b><N>{`${d.booked} / ${d.available}`}</N></b><span>{L("خانة", "slots")}</span></>}</td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-label={dayLabel(keyIso(data.laneDay), ar)}>
            <div className="ss-bh"><h2>{dayLabel(keyIso(data.laneDay), ar)}</h2><span>{data.roasters.length > 1 ? L("المحامص تعمل في الوقت نفسه بمشغّلين مختلفين", "Roasters run at the same time with different operators") : L("مسار المحمصة لهذا اليوم", "The roaster's lane for this day")}</span></div>
            <div style={{ paddingTop: 14 }}><Lanes lanes={data.lanes} day={data.laneDay} now={data.now} conflictIds={conflictIds} subOf={operatorOfLane} /></div>
            <Legend conflict={conflictIds.size > 0} />
          </section>

          {data.conflicts.map((c) => {
            const b = slotOf(c.b.id);
            const from = timeOf(c.a.startsAt > c.b.startsAt ? c.a.startsAt : c.b.startsAt), to = timeOf(c.a.endsAt < c.b.endsAt ? c.a.endsAt : c.b.endsAt);
            return (
              <div key={`${c.a.id}-${c.b.id}`} className="hr-notice tone-danger rs-alert" role="alert" data-testid="operator-conflict">
                <div>
                  <strong>{L("تعارض مشغّل", "Operator conflict")} · <N>{`${from}–${to}`}</N></strong>
                  <div>{ar ? `${c.operatorName ?? ""} مسند إلى ${rname(c.a.roasterId)} و${rname(c.b.roasterId)} في الوقت نفسه. لا تُعتمد خطة حتى يُحل التعارض.` : `${c.operatorName ?? ""} is on ${rname(c.a.roasterId)} and ${rname(c.b.roasterId)} at the same time. No plan is approved until it is resolved.`}</div>
                </div>
                {data.can.manage && b ? (
                  <span className="rs-acts">
                    <Btn size="sm" onClick={() => actions.open({ kind: "move", slot: b })} data-testid="conflict-move">{ar ? `نقل خانة ${rname(b.roasterId)}` : `Move the ${rname(b.roasterId)} slot`}</Btn>
                    <Btn size="sm" variant="primary" onClick={() => actions.open({ kind: "move", slot: b, operatorOnly: true })} data-testid="conflict-reassign">{L("إسناد إلى مشغّل آخر", "Assign another operator")}</Btn>
                  </span>
                ) : null}
              </div>
            );
          })}

          <section aria-label={L("توزيع الأخضر على المحامص", "Green distribution across roasters")}>
            <div className="ss-bh"><h2>{L("توزيع الأخضر على المحامص", "Green distribution across roasters")}</h2><span>{L("يُقترح ما ينهي الطلب أبكر ضمن حدود كل محمصة · الخطط المعتمدة لا تُنقل تلقائيًا", "The roaster that finishes earliest within its limits is proposed · approved plans never move by themselves")}</span></div>
            {data.distribution.length === 0 ? <p className="ss-muted" data-testid="distribution-empty">{L("لا احتياج تحميص مفتوح.", "No open roasting requirement.")}</p> : (
              <div className="hr-tablewrap">
                <table className="hr-table rs-table" data-testid="distribution-table">
                  <thead><tr><th>{L("الطلب", "Order")}</th><th className="is-num">{L("أخضر · كغ", "Green · kg")}</th><th>{L("المقترح", "Proposed")}</th><th className="hr-hide-mobile">{L("البديل", "Alternative")}</th><th /></tr></thead>
                  <tbody>
                    {data.distribution.map((d) => (
                      <tr key={d.productId} data-testid="distribution-row">
                        <td>{d.orders.length ? <N>{d.orders.map((o) => `#${o}`).join(" ")}</N> : null} · <strong className="rs-strong">{ar ? d.product.ar : d.product.en}</strong></td>
                        <td className="is-num"><N>{d.greenToPlanKg}</N></td>
                        <td>{Number(d.greenToPlanKg) === 0 && d.approvedSlots > 0 ? L("معتمدة", "Approved") : d.proposed ? <>{d.proposed.roasterName} · <N>{d.proposed.text}</N></> : L("لا توزيع ضمن الحدود", "No compliant split")}</td>
                        <td className="hr-hide-mobile">{d.alternative ? <>{d.alternative.roasterName} · <N>{d.alternative.text}</N></> : "—"}</td>
                        <td>{Number(d.greenToPlanKg) > 0 ? <Link className="ss-link" href={`${BASE}?view=plan&product=${encodeURIComponent(d.productId)}`} data-testid="distribution-plan">{L("تخطيط", "Plan")}</Link> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
      {actions.dialogs}
    </ScheduleFrame>
  );
}
