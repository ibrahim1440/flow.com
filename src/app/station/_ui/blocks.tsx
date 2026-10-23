"use client";
// The station's building blocks, one per helper of the approved HTML (docs/design/direction-2.1-rc/
// src/stations.py: top_bar, station, steps, head, facts, primary, secondary, foot_note, keypad,
// big_field, done_mark, info; stations2.py: row, side, option, chips, log, plain, title_only).
// Classes in ../station.css; tokens and primitives from Direction 2.1.
import { useContext, type ReactNode } from "react";
import { BrandMark } from "@/components/brand/BrandMark";
import { StationCtx } from "./context";

export const CheckIco = ({ size = "" }: { size?: "" | "s" | "l" }) => (
  <svg className={`ico${size ? " " + size : ""}`} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "؟";
  // «نورة السبيعي» → «نس» (the approved avatar): the article «ال» is not an initial.
  const second = parts[1] ? parts[1].replace(/^ال(?=.)/, "") : "";
  return (parts[0][0] + (second[0] ?? "")).toUpperCase();
}

export function StationBar(props: {
  station: string; location?: string; conn: { tone: "ok" | "in" | "er"; label: string }; updated: string; updatedWord: string;
  emp?: { name: string; tag: string }; lockLabel?: string; switchLabel?: string; onLock?: () => void; onSwitch?: () => void; extra?: ReactNode;
}) {
  // W3 (owner decision 7): the bar always says WHICH station and WHO — «المحطة: … · المستخدم: …» —
  // and a device that serves several stations offers «تبديل المحطة» (the S5 handover, then the
  // station choice before the next employee).
  const ctx = useContext(StationCtx);
  const en = ctx?.user.preferredLanguage === "en";
  const multi = ctx?.mode === "device" && (ctx.stations?.length ?? 0) > 1;
  return (
    <header className="ws-bar" data-testid="station-bar">
      <span className="ws-mark"><BrandMark /></span>
      <div className="ws-id"><span className="ws-k">{en ? "Station: " : "المحطة: "}</span><b data-testid="station-name">{props.station}</b>{props.location ? <div className="ws-loc">{props.location}</div> : null}</div>
      {props.extra}
      <span className="ws-sp" />
      <span className={`st ${props.conn.tone}`} data-testid="station-conn" role="status">{props.conn.label}</span>
      <span className="ws-upd"><span className="ws-upd-w">{props.updatedWord} </span><span className="n">{props.updated}</span></span>
      {props.emp ? (
        <>
          <div className="ws-emp"><span className="av" aria-hidden="true">{initials(props.emp.name)}</span><span className="ws-k">{en ? "User: " : "المستخدم: "}</span><b data-testid="station-employee">{props.emp.name}</b><span className="ws-tag">{props.emp.tag}</span></div>
          <button type="button" className="btn" onClick={props.onLock} data-testid="station-lock">{props.lockLabel}</button>
          {multi ? <button type="button" className="btn" onClick={props.onSwitch} data-testid="station-switch-station">{en ? "Switch station" : "تبديل المحطة"}</button> : null}
          <button type="button" className="btn" onClick={props.onSwitch} data-testid="station-switch">{props.switchLabel}</button>
        </>
      ) : null}
    </header>
  );
}

/** The one white sheet: head, body, footer with one primary action. */
export function Sheet({ head, children, foot, plain, testId }: { head?: ReactNode; children: ReactNode; foot?: ReactNode; plain?: boolean; testId?: string }) {
  return (
    <main className="ws-sheet" data-testid={testId}>
      {head ? <div className="ws-head">{head}</div> : null}
      {plain ? <div className="ws-plain">{children}</div> : <div className="ws-body">{children}</div>}
      {foot ? <div className="ws-foot">{foot}</div> : null}
    </main>
  );
}

export function Steps({ items, cur }: { items: string[]; cur: number }) {
  const out: ReactNode[] = [];
  items.forEach((label, i) => {
    const cls = i < cur ? "done" : i === cur ? "cur" : "";
    out.push(
      <span key={`s${i}`} className={`ws-step ${cls}`} aria-current={i === cur ? "step" : undefined}>
        <i>{i < cur ? <CheckIco size="s" /> : i + 1}</i><span>{label}</span>
      </span>,
    );
    if (i < items.length - 1) out.push(<span key={`l${i}`} className={`ws-step-line${i < cur ? " done" : ""}`} aria-hidden="true" />);
  });
  return <div className="ws-steps">{out}</div>;
}

export function Head({ title, sub, steps, status, since }: { title: ReactNode; sub?: ReactNode; steps?: { items: string[]; cur: number }; status?: { tone: string; label: string }; since?: ReactNode }) {
  return (
    <>
      <div className="ws-h"><h1 data-testid="station-title">{title}</h1>{steps ? <Steps items={steps.items} cur={steps.cur} /> : null}</div>
      <div className="ws-h2">
        <div className="ws-sub">{sub}</div>
        {status ? <span className={`st ws-st ${status.tone}`} data-testid="station-status">{status.label}</span> : null}
        {since ? <span className="ws-since">{since}</span> : null}
      </div>
    </>
  );
}

export function Facts({ items, plain }: { items: [ReactNode, ReactNode][]; plain?: boolean }) {
  return (
    <div className={`ws-facts${plain ? " plain" : ""}`}>
      {items.map(([l, v], i) => <div key={i}><div className="lbl">{l}</div><div className="ws-fact-v">{v}</div></div>)}
    </div>
  );
}

export function Primary({ children, onClick, disabled, wait, danger, testId }: { children: ReactNode; onClick?: () => void; disabled?: boolean; wait?: boolean; danger?: boolean; testId?: string }) {
  return (
    <button type="button" className={`btn ${danger ? "dz" : "p"} ws-pri`} onClick={onClick} disabled={disabled || wait} aria-busy={wait || undefined} data-testid={testId ?? "station-primary"}>
      {wait ? <span className="spin" aria-hidden="true" /> : null}<span>{children}</span>
    </button>
  );
}

export function Secondary({ children, onClick, testId, disabled }: { children: ReactNode; onClick?: () => void; testId?: string; disabled?: boolean }) {
  return <button type="button" className="btn ws-sec" onClick={onClick} data-testid={testId} disabled={disabled}>{children}</button>;
}

export const Note = ({ children }: { children: ReactNode }) => <div className="ws-note">{children}</div>;

export function Info({ tone, title, children, testId }: { tone: "info" | "err" | "warn" | "muted"; title: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className={`ws-info ${tone === "muted" ? "" : tone}`} role={tone === "err" ? "alert" : "status"} data-testid={testId}>
      <b>{title}</b>{children ? <div>{children}</div> : null}
    </div>
  );
}

/** 96 × 64 keys, 12 px gaps, 1-2-3 left to right in both languages (the approved PIN pads). */
export function Keypad({ label, onKey, off, decimal = true, delLabel }: { label?: ReactNode; onKey: (k: string) => void; off?: boolean; decimal?: boolean; delLabel: string }) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", decimal ? "." : "", "0", "del"];
  return (
    <div className="ws-pad" aria-disabled={off || undefined} data-testid="station-keypad">
      {label ? <div className="ws-pad-l">{label}</div> : null}
      <div className="ws-keys">
        {keys.map((k, i) => k === "" ? <span key={i} className="ws-key ph" aria-hidden="true" /> : (
          <button key={i} type="button" className={`ws-key${k === "del" ? " del" : ""}`} disabled={off}
            onPointerDown={(e) => e.preventDefault()} onClick={() => onKey(k)} data-testid={`key-${k === "." ? "dot" : k}`}
            aria-label={k === "del" ? delLabel : k}>{k === "del" ? delLabel : k}</button>
        ))}
      </div>
    </div>
  );
}

/** A large weight field: the box draws the value; a real input under it takes the keyboard. */
export function BigField({ id, label, value, unit, focus, off, bad, hint, onFocus, onChange, testId }: {
  id: string; label: string; value: string; unit: string; focus?: boolean; off?: boolean; bad?: boolean; hint?: ReactNode;
  onFocus?: () => void; onChange?: (v: string) => void; testId?: string;
}) {
  return (
    <div className="ws-field">
      <label className="ws-field-l" htmlFor={id}>{label}</label>
      <div className={`ws-field-box${focus && !off ? " focus" : ""}${off ? " off" : ""}${bad ? " bad" : ""}`} onClick={off ? undefined : onFocus}>
        <span className={`big${value ? "" : " empty"}`} aria-hidden="true">{value || "0.00"}</span>
        {focus && !off ? <span className="caret" aria-hidden="true" /> : null}
        <span className="unit">{unit}</span>
        <input id={id} data-testid={testId} inputMode="decimal" autoComplete="off" dir="ltr" value={value} readOnly={off} disabled={off}
          onFocus={onFocus} onChange={(e) => onChange?.(e.target.value)} />
      </div>
      {hint ? <div className="ws-field-h">{hint}</div> : null}
    </div>
  );
}

export function Row({ title, sub, right, on, dim, onClick, testId }: { title: ReactNode; sub: ReactNode; right?: ReactNode; on?: boolean; dim?: boolean; onClick?: () => void; testId?: string }) {
  return (
    <button type="button" className={`ws-row${on ? " on" : ""}${dim ? " dim" : ""}`} onClick={onClick} data-testid={testId}>
      <div className="ws-row-m"><div className="ws-row-t">{title}</div><div className="ws-row-s">{sub}</div></div>{right}
    </button>
  );
}

export function Side({ title, children, wideOnly = true, stretch = false }: { title: ReactNode; children: ReactNode; wideOnly?: boolean; stretch?: boolean }) {
  // R1 draws the panel at its content height; R7 stretches it to the sheet (as the frames do).
  return <aside className={`ws-side${wideOnly ? " ws-wide-only" : ""}`} style={stretch ? undefined : { alignSelf: "flex-start" }}><b>{title}</b>{children}</aside>;
}
export const SideLine = ({ children }: { children: ReactNode }) => <div className="ws-side-l">{children}</div>;

export function Confirm({ title, sub, ok }: { title: ReactNode; sub: ReactNode; ok: boolean }) {
  return (
    <div className={`ws-confirm${ok ? " ok" : ""}`}>
      <span className="ws-box" aria-hidden="true">{ok ? <CheckIco /> : null}</span>
      <div style={{ flex: 1 }}><div className="ws-confirm-t">{title}</div><div className="ws-confirm-s">{sub}</div></div>
    </div>
  );
}

export function Option({ title, desc, on, onClick, testId }: { title: ReactNode; desc: ReactNode; on: boolean; onClick: () => void; testId?: string }) {
  return (
    <button type="button" className="ws-option" aria-pressed={on} onClick={onClick} data-testid={testId}>
      <span className="ws-dot" aria-hidden="true">{on ? <CheckIco size="s" /> : null}</span>
      <div><div className="ws-option-t">{title}</div><div className="ws-option-s">{desc}</div></div>
    </button>
  );
}

export function Chips<T extends string>({ options, value, onChange, label, testId }: { options: { value: T; label: string }[]; value: T | null; onChange: (v: T) => void; label: string; testId?: string }) {
  return (
    <div className="ws-chips" role="group" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button key={o.value} type="button" className="ws-choice" aria-pressed={value === o.value} onClick={() => onChange(o.value)} data-testid={testId ? `${testId}-${o.value}` : undefined}>
          {value === o.value ? <CheckIco size="s" /> : null}{o.label}
        </button>
      ))}
    </div>
  );
}

export function LogRows({ lines }: { lines: [ReactNode, ReactNode][] }) {
  return <div>{lines.map(([t, w], i) => <div key={i} className="ws-log-row"><span><CheckIco size="s" /></span><span>{t}</span><span className="n">{w}</span></div>)}</div>;
}

export function DoneMark() {
  return <span className="ws-mark-ok" aria-hidden="true"><CheckIco size="l" /></span>;
}

/** Identifier read off a bag or a box: mono, LTR isolate. */
export const Bid = ({ children }: { children: ReactNode }) => <span className="ws-bid">{children}</span>;
export const Num = ({ children }: { children: ReactNode }) => <span className="n">{children}</span>;
