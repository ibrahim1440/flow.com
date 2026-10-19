// The roaster change history (RM3 «سجل التغييرات»), as the frame words it.
import { STATUS, TYPE, dayLabel, type HistoryRow, type Roaster } from "./shared";

const F: Record<string, [string, string]> = {
  name: ["الاسم", "Name"], manufacturerModel: ["الشركة المصنّعة والطراز", "Manufacturer and model"], type: ["النوع", "Type"],
  nominalCapacityKg: ["السعة", "Capacity"], defaultTargetKg: ["الهدف", "Target"], minBatchKg: ["الحد الأدنى", "Minimum"], maxBatchKg: ["الأقصى", "Maximum"],
  cycleMinutes: ["الدورة", "Cycle"], defaultOperatorId: ["المشغّل الافتراضي:", "Default operator:"], status: ["الحالة:", "Status:"],
  statusReason: ["السبب:", "Reason:"], statusUntil: ["حتى", "Until"], isDefault: ["الافتراضية:", "Default:"],
};

/** One history row as the frame writes it: «أُنشئت المحمصة · السعة 6.00 · الهدف 5.00 كغ», «الحد الأدنى 3.00 · الأقصى 6.00 · الدورة 30 دقيقة». */
export function historyText(h: HistoryRow, ar: boolean): string {
  const a = (h.after ?? {}) as Record<string, unknown>;
  const val = (k: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    if (k === "cycleMinutes") return `${v} ${ar ? "دقيقة" : "min"}`;
    if (k === "defaultOperatorId") return h.names[String(v)] ?? "—";
    if (k === "status") return ar ? STATUS[v as Roaster["status"]]?.[0] ?? String(v) : STATUS[v as Roaster["status"]]?.[1] ?? String(v);
    if (k === "type") return ar ? TYPE[v as Roaster["type"]]?.[0] ?? String(v) : TYPE[v as Roaster["type"]]?.[1] ?? String(v);
    if (k === "isDefault") return v ? (ar ? "نعم" : "yes") : (ar ? "لا" : "no");
    if (k === "statusUntil") return dayLabel(String(v), ar, false);
    return String(v);
  };
  const part = (k: string) => `${ar ? F[k]?.[0] ?? k : F[k]?.[1] ?? k} ${val(k, a[k])}`;
  switch (h.action) {
    case "ROASTER_CREATED":
      return `${ar ? "أُنشئت المحمصة" : "Roaster created"} · ${part("nominalCapacityKg")} · ${part("defaultTargetKg")} ${ar ? "كغ" : "kg"}`;
    case "ROASTER_UPDATED":
    case "ROASTER_STATUS_CHANGED":
      // In the form's order (the frame: «الحد الأدنى 3.00 · الأقصى 6.00 · الدورة 30 دقيقة»).
      return Object.keys(F).filter((k) => h.changed.includes(k)).map(part).join(" · ");
    case "OPERATOR_ASSIGNED":
    case "OPERATOR_UNASSIGNED": {
      const who = h.names[String(a.employeeId)] ?? String(a.employeeName ?? "—");
      return h.action === "OPERATOR_ASSIGNED" ? (ar ? `أُسند المشغّل: ${who}` : `Operator assigned: ${who}`) : (ar ? `أُلغي إسناد المشغّل: ${who}` : `Operator unassigned: ${who}`);
    }
    default:
      return ar ? "تغيير" : "Change";
  }
}

