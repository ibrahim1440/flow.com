// P-2 rev3 review (rev8 P3): a day figure of the payslip / run page. Its text is unchanged; each
// ISO date in it is kept on one line, so a narrow screen (390 px) wraps between the parts of the
// figure, never inside a date ("2026-11-" / "30").
import type { ReactNode } from "react";

const ISO_DATE = /(\d{4}-\d{2}-\d{2})/;

export function DayValue({ v }: { v: string }): ReactNode {
  return (
    <span className="hr-iso">
      {v.split(ISO_DATE).map((part, i) => (i % 2 ? <span key={i} style={{ whiteSpace: "nowrap" }}>{part}</span> : part))}
    </span>
  );
}
