"use client";
import { Combobox, Select } from "@/components/ui/Select";
import { useCreateRequest } from "@/components/shell/page-context";
// Company assets (no dedicated Figma frame — follows the HR-01 directory list style).
// An asset has at most one open assignment (DB partial unique index); returning it closes
// the assignment and makes the asset available again, or retires it.
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Btn, Dialog, Empty, ErrorState, Field, LoadingTable, NoPermission, Notice, PageHeader, StatusDot, Tabs,
  hrFetch, todayIso, useAction, useForm, useHr, useHrI18n, useHrMeta, type StatusEntry,
} from "@/components/hr/ui";

type Asset = {
  id: string; tag: string; name: string; category: string; serialNo: string | null; status: string;
  holder: { id: string; fullNameAr: string; employeeNo: string; assignmentId: string; since: string } | null;
};
type View = "all" | "AVAILABLE" | "ASSIGNED" | "RETIRED";
const ASSET_STATUS: Record<string, StatusEntry> = { AVAILABLE: ["متاح", "success", "Available"], ASSIGNED: ["مسلَّم", "info", "Assigned"], RETIRED: ["مستبعد", "cancelled", "Retired"] };

export default function AssetsPage() {
  const { meta } = useHrMeta();
  const allowed = !meta || meta.caps.assets_manage;
  const { data, error, loading, reload } = useHr<Asset[]>(allowed ? "/api/hr/assets" : null);
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<null | { kind: "new" } | { kind: "assign"; a: Asset } | { kind: "return"; a: Asset }>(null);
  // «جديد» from the shell (A-3): `?new=1` opens the same form as «أصل جديد».
  useCreateRequest("asset", () => setDialog({ kind: "new" }), !!meta?.caps.assets_manage);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? []).filter((a) => (view === "all" || a.status === view) && (!s || [a.tag, a.name, a.category, a.serialNo ?? "", a.holder?.fullNameAr ?? "", a.holder?.employeeNo ?? ""].some((x) => x.toLowerCase().includes(s))));
  }, [data, view, q]);
  const count = (s: string) => data?.filter((a) => a.status === s).length;
  const { L, t } = useHrI18n();

  if (!allowed) return <div className="hr-page"><NoPermission duty={L("العهد والأصول", "Assets")} /></div>;
  const done = () => { setDialog(null); void reload(); };

  return (
    <div className="hr-page">
      <PageHeader title={L("العهد والأصول", "Assets")} actions={<Btn variant="primary" onClick={() => setDialog({ kind: "new" })}>{L("+ أصل جديد", "+ New asset")}</Btn>} />
      <Tabs
        label={L("حالات الأصول", "Asset states")}
        value={view}
        onChange={setView}
        items={[
          { key: "all", label: L("الكل", "All"), count: data?.length },
          { key: "AVAILABLE", label: L("متاحة", "Available"), count: count("AVAILABLE") },
          { key: "ASSIGNED", label: L("مسلَّمة", "Assigned"), count: count("ASSIGNED") },
          { key: "RETIRED", label: L("مستبعدة", "Retired"), count: count("RETIRED") },
        ]}
      />
      <div className="hr-filterbar">
        <input className="hr-input hr-search" type="search" placeholder={L("رقم الأصل أو الاسم أو المستلم", "Asset number, name or holder")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("search")} />
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !data ? <LoadingTable /> : null}
      {data && rows.length === 0 ? (
        data.length === 0
          ? <Empty title={L("لا أصول مسجلة", "No assets recorded")} body={L("سجّل أجهزة الشركة وعهدها، ثم سلّمها للموظفين. تمنع العهد غير المُعادة إتمام إنهاء الخدمة.", "Record company devices and assets, then hand them over to employees. Unreturned assets block completing an end of service.")} action={<Btn variant="primary" onClick={() => setDialog({ kind: "new" })}>{L("أصل جديد", "New asset")}</Btn>} />
          : <Empty title={L("لا أصل يطابق", "No matching asset")} body={L("جرّب كلمة أخرى أو عرضًا آخر.", "Try another word or view.")} action={<Btn size="sm" onClick={() => { setQ(""); setView("all"); }}>{L("مسح المرشحات", "Clear filters")}</Btn>} />
      ) : null}
      {rows.length > 0 ? (
        <>
          <div className="hr-tablewrap">
            <table className="hr-table is-stack" aria-label={L("الأصول", "Assets")}>
              <thead><tr><th>{L("الرقم", "No.")}</th><th>{L("الاسم", "Name")}</th><th>{L("الفئة", "Category")}</th><th>{L("الحالة", "Status")}</th><th>{L("المستلم", "Holder")}</th><th className="num">{L("منذ", "Since")}</th><th /></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td data-label={L("الرقم", "No.")}><span className="hr-id">{a.tag}</span></td>
                    <td data-label={L("الاسم", "Name")} className="strong">{a.name}{a.serialNo ? <span className="sub hr-id">{a.serialNo}</span> : null}</td>
                    <td data-label={L("الفئة", "Category")}>{a.category}</td>
                    <td data-label={L("الحالة", "Status")}><StatusDot map={ASSET_STATUS} value={a.status} /></td>
                    <td data-label={L("المستلم", "Holder")}>{a.holder ? <Link href={`/dashboard/hr/employees/${a.holder.id}`}>{a.holder.fullNameAr}</Link> : <span className="hr-muted">—</span>}{a.holder ? <span className="sub hr-id">{a.holder.employeeNo}</span> : null}</td>
                    <td data-label={L("منذ", "Since")} className="num">{a.holder?.since ?? "—"}</td>
                    <td data-label={L("إجراء", "Action")}>
                      {a.status === "AVAILABLE" ? <Btn size="sm" onClick={() => setDialog({ kind: "assign", a })}>{L("تسليم", "Hand over")}</Btn> : null}
                      {a.holder ? <Btn size="sm" onClick={() => setDialog({ kind: "return", a })}>{L("استلام", "Return")}</Btn> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hr-tablefoot"><span>{L(`${rows.length} أصلًا`, `${rows.length} assets`)}{data ? L(` · ${count("ASSIGNED") ?? 0} مسلَّمة`, ` · ${count("ASSIGNED") ?? 0} assigned`) : ""}</span></div>
        </>
      ) : null}
      {dialog?.kind === "new" ? <NewAsset onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === "assign" ? <Assign a={dialog.a} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === "return" ? <Return a={dialog.a} onClose={() => setDialog(null)} onDone={done} /> : null}
    </div>
  );
}

function NewAsset({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const f = useForm({ tag: "", name: "", category: "", serialNo: "", notes: "" });
  const act = useAction();
  const { L } = useHrI18n();
  const submit = () => act.run("n", async () => {
    await hrFetch("/api/hr/assets", { json: Object.fromEntries(Object.entries(f.v).filter(([, v]) => v !== "")) });
    onDone();
  });
  return (
    <Dialog open title={L("أصل جديد", "New asset")} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "n"} disabled={!f.v.tag || !f.v.name || !f.v.category} onClick={submit}>{L("حفظ", "Save")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("رقم الأصل *", "Asset number *")} help={L("مثل LAP-014", "e.g. LAP-014")}><input className="hr-input" dir="ltr" maxLength={30} {...f.bind("tag")} /></Field>
        <Field label={L("الفئة *", "Category *")}><Combobox className="hr-input" maxLength={60} {...f.bind("category")} options={(L("حاسب محمول|جوال|مفاتيح|زي موحد|مركبة|بطاقة دخول", "Laptop|Mobile phone|Keys|Uniform|Vehicle|Access card")).split("|").map((c) => ({ value: c }))} /></Field>
        <Field label={L("الاسم *", "Name *")} wide><input className="hr-input" maxLength={120} {...f.bind("name")} /></Field>
        <Field label={L("الرقم التسلسلي", "Serial number")}><input className="hr-input" dir="ltr" maxLength={80} {...f.bind("serialNo")} /></Field>
        <Field label={L("ملاحظات", "Notes")} wide><textarea className="hr-textarea" maxLength={500} {...f.bind("notes")} /></Field>
      </div>
    </Dialog>
  );
}

function Assign({ a, onClose, onDone }: { a: Asset; onClose: () => void; onDone: () => void }) {
  const { meta } = useHrMeta();
  const f = useForm({ employeeId: "", assignedOn: todayIso(), condition: "" });
  const [who, setWho] = useState("");
  const act = useAction();
  const { L } = useHrI18n();
  const people = useMemo(() => {
    const s = who.trim().toLowerCase();
    return (meta?.people ?? []).filter((p) => !s || p.fullNameAr.toLowerCase().includes(s) || p.employeeNo.toLowerCase().includes(s)).slice(0, 200);
  }, [meta, who]);
  const submit = () => act.run("a", async () => {
    await hrFetch(`/api/hr/assets/${a.id}/assign`, { json: { employeeId: f.v.employeeId, assignedOn: f.v.assignedOn, condition: f.v.condition || undefined } });
    onDone();
  });
  return (
    <Dialog open title={L(`تسليم ${a.tag} · ${a.name}`, `Hand over ${a.tag} · ${a.name}`)} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "a"} disabled={!f.v.employeeId || !f.v.assignedOn} onClick={submit}>{L("تسليم", "Hand over")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      {meta && meta.people.length === 0 ? <Notice tone="warning">{L("لا تظهر قائمة الموظفين: تحتاج صلاحية «دليل الموظفين» لاختيار المستلم.", "The employee list is not shown: you need the “Employee directory” permission to choose the holder.")}</Notice> : null}
      <div className="hr-form">
        <Field label={L("بحث عن الموظف", "Find employee")}><input className="hr-input" type="search" value={who} onChange={(e) => setWho(e.target.value)} placeholder={L("الاسم أو الرقم الوظيفي", "Name or employee number")} /></Field>
        <Field label={L("المستلم *", "Holder *")}>
          <Select className="hr-select" {...f.bind("employeeId")}>
            <option value="">—</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.employeeNo}</option>)}
          </Select>
        </Field>
        <Field label={L("تاريخ التسليم *", "Handover date *")}><input className="hr-input" type="date" {...f.bind("assignedOn")} /></Field>
        <Field label={L("الحالة عند التسليم", "Condition at handover")}><input className="hr-input" maxLength={200} placeholder={L("جديد، سليم، خدش بسيط…", "New, good, minor scratch…")} {...f.bind("condition")} /></Field>
      </div>
    </Dialog>
  );
}

function Return({ a, onClose, onDone }: { a: Asset; onClose: () => void; onDone: () => void }) {
  const f = useForm({ returnedOn: todayIso(), condition: "" });
  const [retire, setRetire] = useState(false);
  const act = useAction();
  const { L } = useHrI18n();
  const submit = () => act.run("r", async () => {
    await hrFetch(`/api/hr/assets/assignments/${a.holder!.assignmentId}/return`, { json: { returnedOn: f.v.returnedOn, condition: f.v.condition || undefined, retire } });
    onDone();
  });
  return (
    <Dialog open title={L(`استلام ${a.tag} · ${a.name}`, `Return ${a.tag} · ${a.name}`)} onClose={onClose} actions={<><Btn variant={retire ? "danger" : "primary"} busy={act.busy === "r"} disabled={!f.v.returnedOn} onClick={submit}>{retire ? L("استلام واستبعاد", "Return and retire") : L("استلام", "Return")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <p style={{ margin: 0 }}>{L("من", "From")} <strong>{a.holder?.fullNameAr}</strong> · {L("مسلَّم منذ", "assigned since")} <span className="hr-num">{a.holder?.since}</span></p>
      <div className="hr-form">
        <Field label={L("تاريخ الاستلام *", "Return date *")}><input className="hr-input" type="date" min={a.holder?.since} {...f.bind("returnedOn")} /></Field>
        <Field label={L("الحالة عند الاستلام", "Condition at return")}><input className="hr-input" maxLength={200} {...f.bind("condition")} /></Field>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={retire} onChange={(e) => setRetire(e.target.checked)} />
        <span>{L("استبعاد الأصل بعد الاستلام (تالف أو مفقود) — لن يُتاح للتسليم مجددًا.", "Retire the asset after return (damaged or lost) — it can’t be handed over again.")}</span>
      </label>
    </Dialog>
  );
}
