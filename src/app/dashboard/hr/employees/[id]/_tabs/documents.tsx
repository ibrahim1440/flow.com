"use client";
// HR-02 · Documents. Bytes stay in the database; every download is audited server-side.
import { Select } from "@/components/ui/Select";
import { useCallback, useState } from "react";
import { Btn, Dialog, Empty, Field, Flag, Notice, useAction, useForm, useHrI18n } from "@/components/hr/ui";
import { Check, DOC_CATEGORY, SectionHead, daysUntil, fileSize, lbl, mutate, type Doc, type TabProps } from "./shared";
import { expiryBadge } from "@/lib/hr/expiry-rules";

const MAX = 5 * 1024 * 1024;
const TYPES = ["application/pdf", "image/png", "image/jpeg"];

export default function DocumentsTab({ id, profile, readOnly, reload }: TabProps) {
  const docs = profile.documents ?? [];
  const manage = profile.permissions.documentsManage && !readOnly;
  const [dlg, setDlg] = useState<{ kind: "upload" } | { kind: "remove"; d: Doc } | null>(null);
  const close = useCallback(() => setDlg(null), []);
  const done = useCallback(() => { setDlg(null); reload(); }, [reload]);
  const { L, lang } = useHrI18n();
  return (
    <section className="hr-stack">
      <SectionHead title={L("المستندات", "Documents")} actions={manage ? <Btn size="sm" onClick={() => setDlg({ kind: "upload" })}>{L("رفع مستند", "Upload document")}</Btn> : null} />
      {docs.length === 0 ? (
        <Empty title={L("لا توجد مستندات", "No documents")} body={manage ? L("ارفع العقد الموقّع أو الهوية أو الشهادات (PDF أو PNG أو JPEG حتى 5 MB).", "Upload the signed contract, ID or certificates (PDF, PNG or JPEG up to 5 MB).") : L("لم يُرفع أي مستند لهذا الموظف.", "No document has been uploaded for this employee.")} />
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-stack" aria-label={L("المستندات", "Documents")}>
            <thead><tr><th>{L("المستند", "Document")}</th><th>{L("الفئة", "Category")}</th><th className="num">{L("الحجم", "Size")}</th><th className="num">{L("ينتهي", "Expires")}</th><th className="num">{L("رُفع", "Uploaded")}</th><th aria-label={L("إجراءات", "Actions")} /></tr></thead>
            <tbody>
              {docs.map((d) => {
                const left = d.expiresOn ? daysUntil(d.expiresOn) : null;
                return (
                  <tr key={d.id}>
                    <td data-label={L("المستند", "Document")} className="strong">{d.title}{d.confidential ? <span className="sub">{L("سري", "Confidential")}</span> : null}</td>
                    <td data-label={L("الفئة", "Category")}>{lbl(DOC_CATEGORY, d.category, lang)}</td>
                    <td data-label={L("الحجم", "Size")} className="num">{fileSize(d.sizeBytes)}</td>
                    <td data-label={L("ينتهي", "Expires")} className="num">
                      {d.expiresOn ? <ExpiryCell iso={d.expiresOn} left={left} /> : "—"}
                    </td>
                    <td data-label={L("رُفع", "Uploaded")} className="num">{String(d.createdAt).slice(0, 10)}</td>
                    <td data-label={L("إجراءات", "Actions")}>
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <a className="hr-btn is-sm" href={`/api/hr/employees/${id}/documents/${d.id}`} download={d.fileName}>{L("تنزيل", "Download")}</a>
                        {manage ? <Btn size="sm" variant="ghost" onClick={() => setDlg({ kind: "remove", d })}>{L("حذف", "Remove")}</Btn> : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hr-caption" style={{ margin: 0 }}>{L("كل تنزيل يُسجَّل في سجل الموظف. الحذف لا يمحو الملف، بل يخفيه مع سبب مسجّل.", "Every download is logged in the employee’s audit log. Removing does not erase the file; it hides it with a recorded reason.")}</p>
      {dlg?.kind === "upload" ? <UploadDialog id={id} onClose={close} onDone={done} /> : null}
      {dlg?.kind === "remove" ? <RemoveDialog id={id} d={dlg.d} onClose={close} onDone={done} /> : null}
    </section>
  );
}

/** The expiry date and, when it is near or past, the badge «تنتهي خلال N يومًا» / «منتهية» (feat/hr-expiry-email). */
function ExpiryCell({ iso, left }: { iso: string; left: number | null }) {
  const { lang } = useHrI18n();
  const b = left === null ? null : expiryBadge(left, 60);
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <span className="hr-num">{iso}</span>
      {b ? <span data-testid="hr-doc-expiry-badge"><Flag tone={b.tone}>{lang === "en" ? b.en : b.ar}</Flag></span> : null}
    </span>
  );
}

function UploadDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ title: "", category: "OTHER", expiresOn: "" });
  const [file, setFile] = useState<File | null>(null);
  const [confidential, setConfidential] = useState(true);
  const a = useAction();
  const { L, t, lang } = useHrI18n();
  const fileErr = file ? (!TYPES.includes(file.type) ? L("يُقبل PDF أو PNG أو JPEG فقط", "Only PDF, PNG or JPEG is accepted") : file.size > MAX ? L("الحد الأقصى 5 MB", "The limit is 5 MB") : file.size === 0 ? L("الملف فارغ", "The file is empty") : null) : null;
  const submit = () => a.run("save", async () => {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    form.set("title", f.v.title);
    form.set("category", f.v.category);
    if (f.v.expiresOn) form.set("expiresOn", f.v.expiresOn);
    form.set("confidential", confidential ? "true" : "false");
    await mutate(`/api/hr/employees/${id}/documents`, { form });
    onDone();
  });
  return (
    <Dialog open title={L("رفع مستند", "Upload document")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!file || !!fileErr || !f.v.title.trim()}>{L("رفع", "Upload")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الملف *", "File *")} help={L("PDF أو PNG أو JPEG حتى 5 MB", "PDF, PNG or JPEG up to 5 MB")} error={fileErr} wide>
          <input className="hr-input" type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => {
            const x = e.target.files?.[0] ?? null;
            setFile(x);
            if (x && !f.v.title) f.setV((s) => ({ ...s, title: x.name.replace(/\.[^.]+$/, "") }));
          }} style={{ paddingBlock: 4 }} />
        </Field>
        <Field label={L("العنوان *", "Title *")}><input className="hr-input" {...f.bind("title")} /></Field>
        <Field label={L("الفئة", "Category")}><Select className="hr-select" {...f.bind("category")}>{Object.keys(DOC_CATEGORY).map((k) => <option key={k} value={k}>{lbl(DOC_CATEGORY, k, lang)}</option>)}</Select></Field>
        <Field label={L("تاريخ الانتهاء", "Expiry date")} help={L("يُنبَّه الموظف والموارد البشرية قبل الانتهاء وفق أيام التنبيه في الإعدادات", "The employee and HR are notified before expiry, at the days set in HR settings")}><input className="hr-input" type="date" {...f.bind("expiresOn")} /></Field>
      </div>
      <Check checked={confidential} onChange={setConfidential}>{L("سري", "Confidential")}</Check>
    </Dialog>
  );
}

function RemoveDialog({ id, d, onClose, onDone }: { id: string; d: Doc; onClose: () => void; onDone: () => void }) {
  const f = useForm({ reason: "" });
  const a = useAction();
  const { L, t } = useHrI18n();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/employees/${id}/documents/${d.id}`, { method: "DELETE", json: { reason: f.v.reason } });
    onDone();
  });
  return (
    <Dialog open title={L(`حذف «${d.title}»`, `Remove “${d.title}”`)} onClose={onClose} actions={<><Btn variant="danger" busy={a.busy === "save"} onClick={submit} disabled={f.v.reason.trim().length < 3}>{L("حذف", "Remove")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <p className="hr-caption" style={{ margin: 0 }}>{L("يُخفى المستند من الملف ويبقى محفوظًا للتدقيق.", "The document is hidden from the file and kept for audit.")}</p>
      <Field label={L("السبب *", "Reason *")}><input className="hr-input" {...f.bind("reason")} /></Field>
    </Dialog>
  );
}
