"use client";
// HR-02 · Assets held by (or returned by) this person. Assign / return need assets_manage.
import { Select } from "@/components/ui/Select";
import { useCallback, useState } from "react";
import { Btn, Dialog, Empty, ErrorState, Field, LoadingTable, Notice, StatusDot, todayIso, useAction, useCan, useForm, useHr, useHrI18n } from "@/components/hr/ui";
import { Check, SectionHead, mutate, type AssetRow, type TabProps } from "./shared";

type Asset = { id: string; tag: string; name: string; category: string; serialNo: string | null; status: string };

export default function AssetsTab({ id, profile, readOnly, reload }: TabProps) {
  const can = useCan();
  const manage = can("assets_manage") && !readOnly;
  const rows = profile.assets ?? [];
  const [dlg, setDlg] = useState<{ kind: "assign" } | { kind: "return"; a: AssetRow } | null>(null);
  const close = useCallback(() => setDlg(null), []);
  const done = useCallback(() => { setDlg(null); reload(); }, [reload]);
  const held = rows.filter((r) => !r.returnedOn).length;
  const { L, t } = useHrI18n();
  return (
    <section className="hr-stack">
      <SectionHead title={L("العهد", "Assets")} actions={manage ? <Btn size="sm" onClick={() => setDlg({ kind: "assign" })}>{L("تسليم عهدة", "Hand over asset")}</Btn> : null} />
      {rows.length === 0 ? (
        <Empty title={L("لا توجد عهد", "No assets")} body={L("لم تُسلَّم لهذا الموظف أي عهدة.", "No asset has been handed over to this employee.")} />
      ) : (
        <>
          <div className="hr-tablewrap">
            <table className="hr-table is-stack" aria-label={L("العهد", "Assets")}>
              <thead><tr><th>{L("الرمز", "Tag")}</th><th>{L("العهدة", "Asset")}</th><th>{L("الفئة", "Category")}</th><th className="num">{L("التسليم", "Handed over")}</th><th className="num">{L("الاستلام", "Returned")}</th><th>{t("status")}</th>{manage ? <th aria-label={L("إجراءات", "Actions")} /> : null}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label={L("الرمز", "Tag")}><span className="hr-id">{r.tag}</span></td>
                    <td data-label={L("العهدة", "Asset")} className="strong">{r.name}</td>
                    <td data-label={L("الفئة", "Category")} className="hr-muted">{r.category}</td>
                    <td data-label={L("التسليم", "Handed over")} className="num">{r.assignedOn}</td>
                    <td data-label={L("الاستلام", "Returned")} className="num">{r.returnedOn ?? "—"}</td>
                    <td data-label={t("status")}><StatusDot map={{ H: ["لدى الموظف", "warning", "With the employee"], R: ["أُعيدت", "success", "Returned"] }} value={r.returnedOn ? "R" : "H"} /></td>
                    {manage ? <td data-label={L("إجراءات", "Actions")}>{r.returnedOn ? null : <Btn size="sm" onClick={() => setDlg({ kind: "return", a: r })}>{L("استلام", "Return")}</Btn>}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hr-tablefoot"><span><span className="hr-num">{held}</span> {L("عهدة لدى الموظف", "assets held by the employee")}</span></div>
        </>
      )}
      {held > 0 ? <p className="hr-caption" style={{ margin: 0 }}>{L("العهد غير المستلمة تمنع إتمام إنهاء الخدمة.", "Unreturned assets block completing the end of service.")}</p> : null}
      {dlg?.kind === "assign" ? <AssignDialog id={id} onClose={close} onDone={done} /> : null}
      {dlg?.kind === "return" ? <ReturnDialog a={dlg.a} onClose={close} onDone={done} /> : null}
    </section>
  );
}

function AssignDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const list = useHr<Asset[]>("/api/hr/assets");
  const avail = list.data?.filter((x) => x.status === "AVAILABLE") ?? [];
  const f = useForm({ assetId: "", assignedOn: todayIso(), condition: "" });
  const { L, t } = useHrI18n();
  const a = useAction();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/assets/${f.v.assetId}/assign`, { json: { employeeId: id, assignedOn: f.v.assignedOn, condition: f.v.condition || undefined } });
    onDone();
  });
  return (
    <Dialog open title={L("تسليم عهدة", "Hand over asset")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.assetId || !f.v.assignedOn}>{L("تسليم", "Hand over")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <LoadingTable rows={2} /> : null}
      {list.data && avail.length === 0 ? <Notice tone="warning">{L("لا توجد عهد متاحة. أضف العهد من صفحة «العهد».", "No assets are available. Add assets on the Assets page.")}</Notice> : null}
      <div className="hr-form">
        <Field label={L("العهدة *", "Asset *")} wide>
          <Select className="hr-select" {...f.bind("assetId")}>
            <option value="">{L("— اختر —", "— Select —")}</option>
            {avail.map((x) => <option key={x.id} value={x.id}>{x.tag} · {x.name}</option>)}
          </Select>
        </Field>
        <Field label={L("تاريخ التسليم *", "Handover date *")}><input className="hr-input" type="date" {...f.bind("assignedOn")} /></Field>
        <Field label={L("الحالة عند التسليم", "Condition at handover")}><input className="hr-input" {...f.bind("condition")} placeholder={L("مثال: جديدة", "e.g. new")} /></Field>
      </div>
    </Dialog>
  );
}

function ReturnDialog({ a: asset, onClose, onDone }: { a: AssetRow; onClose: () => void; onDone: () => void }) {
  const f = useForm({ returnedOn: todayIso(), condition: "" });
  const [retire, setRetire] = useState(false);
  const { L, t } = useHrI18n();
  const a = useAction();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/assets/assignments/${asset.id}/return`, { json: { returnedOn: f.v.returnedOn, condition: f.v.condition || undefined, retire } });
    onDone();
  });
  return (
    <Dialog open title={L(`استلام ${asset.tag} · ${asset.name}`, `Return ${asset.tag} · ${asset.name}`)} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.returnedOn}>{L("تسجيل الاستلام", "Record return")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("تاريخ الاستلام *", "Return date *")}><input className="hr-input" type="date" {...f.bind("returnedOn")} /></Field>
        <Field label={L("الحالة عند الاستلام", "Condition at return")}><input className="hr-input" {...f.bind("condition")} /></Field>
      </div>
      <Check checked={retire} onChange={setRetire}>{L("إخراج العهدة من الخدمة (تالفة أو مفقودة)", "Retire the asset (damaged or lost)")}</Check>
    </Dialog>
  );
}
