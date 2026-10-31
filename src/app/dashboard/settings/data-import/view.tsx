"use client";
// «استيراد البيانات» — the master data carried in from Qoyod (or typed into the template) before go-live:
// customers, suppliers, green coffee, materials and products. Per kind: download the .xlsx template (or use Qoyod's
// export with the same headers), choose the file, see every row checked (new · already there · error with its reason),
// then import — all or nothing, with a step-up. Records already in the system are skipped, so the same file again adds
// nothing. For the admin role (Settings › «استيراد البيانات», in the settings frame) and for a holder of
// accounting › data_import (the owner grants it to the accountant: «المالية › استيراد البيانات», no settings frame —
// they may not open the other settings pages). The rule is src/lib/data-import/access.ts; the API re-checks it
// (src/app/api/settings/data-import, src/lib/data-import/gate.ts).
import { useEffect, useState } from "react";
import { Btn, Metrics, Notice, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { localizeApiError, networkErrorText } from "@/lib/i18n/api-errors";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "@/app/dashboard/user-context";
import { dataImportActor } from "@/lib/data-import/access";
import { ENTITY_LABEL, IMPORT_ENTITIES, type ImportEntity } from "@/lib/data-import/spec";
import type { Preview } from "@/lib/data-import/run";
import type { ReactNode } from "react";
import { Sec, SettingsFrame } from "../../_components/tools-ui";
import "../_parts/sections.css";

type Counts = { customers: number; suppliers: number; green: number; materials: number; products: number; productGroups: number };
const ROW_CAP = 500;

const INTRO: Record<ImportEntity, [string, string]> = {
  customers: ["صف لكل عميل. الاسم يجب أن يطابق قيود حرفيًا: عليه تُطابَق أرصدة العملاء الافتتاحية لاحقًا.", "One row per customer. The name must match Qoyod exactly: the opening customer balances match on it."],
  suppliers: ["صف لكل مورد. الاسم يجب أن يطابق قيود حرفيًا: عليه تُطابَق أرصدة الموردين الافتتاحية لاحقًا.", "One row per supplier. The name must match Qoyod exactly: the opening supplier balances match on it."],
  green: ["صف لكل لوط بن أخضر، مع كميته بالكيلو وتكلفة الكيلو في تاريخ القطع إن وُجدت.", "One row per green lot, with its kg and cost per kg at the cut-off when there is stock."],
  materials: ["صف لكل صنف (أكياس، ملصقات، مستلزمات المقهى…) مع كميته وتكلفته في تاريخ القطع.", "One row per item (bags, labels, café supplies…) with its quantity and cost at the cut-off."],
  products: ["صف لكل عبوة تُباع. العبوات التي تحمل اسم المنتج نفسه تُجمع تحت منتج واحد. لا يُستورد مخزون المنتج الجاهز هنا.", "One row per sellable SKU; SKUs with the same product name go under one product. Finished-goods stock is not imported here."],
};

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string; preview?: Preview } }> {
  const res = await fetch(url, { cache: "no-store", ...init }).catch(() => { throw new Error(networkErrorText()); });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Where the page is drawn: Settings (the admin role, settings frame) or «المحاسبة» (a holder; no settings frame). */
export type DataImportPlace = "settings" | "accounting";

export function DataImportView({ place }: { place: DataImportPlace }) {
  const L = useL();
  const { lang } = useI18n();
  const ar = lang !== "en";
  const user = useUser();
  const actor = dataImportActor(user);
  const inSettings = place === "settings" && (!user || actor === "admin");
  useD21Phone(inSettings
    ? { title: L("استيراد البيانات", "Data import"), sub: L("الإعدادات", "Settings"), back: "/dashboard/settings" }
    : { title: L("استيراد البيانات", "Data import"), sub: L("المحاسبة", "Accounting"), back: "/dashboard/accounting" });
  // The settings frame lists the settings pages — the admin role's; a holder of accounting › data_import gets the page alone.
  const frame = (children: ReactNode) => (inSettings ? <SettingsFrame>{children}</SettingsFrame> : <div className="hr-page" data-testid="dimp-plain">{children}</div>);
  const [entity, setEntity] = useState<ImportEntity>("customers");
  const [counts, setCounts] = useState<Counts | null>(null);
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [inputKey, setInputKey] = useState(0);

  useEffect(() => {
    call<{ counts: Counts }>("/api/settings/data-import").then((r) => { if (r.ok) setCounts(r.body.counts); }).catch(() => {});
  }, []);

  function reset(next?: ImportEntity) {
    if (next) setEntity(next);
    setFile(null); setPreview(null); setError(null); setOnlyProblems(false); setInputKey((k) => k + 1);
  }

  async function check(f = file, kind = entity) {
    if (!f) return;
    setBusy("check"); setError(null); setDone(null);
    try {
      const r = await call<{ preview: Preview }>("/api/settings/data-import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity: kind, fileName: f.name, fileBase64: f.b64 }) });
      if (!r.ok) { setPreview(null); setError(localizeApiError(r.body) ?? `HTTP ${r.status}`); return; }
      setPreview(r.body.preview);
      setOnlyProblems(r.body.preview.counts.errors > 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { setError(L("حجم الملف أكبر من 5 ميغابايت: قسّمه.", "The file is larger than 5 MB: split it.")); return; }
    const next = { name: f.name, b64: toBase64(await f.arrayBuffer()) };
    setFile(next); setPreview(null); setDone(null);
    await check(next);
  }

  async function commit() {
    if (!file || !preview) return;
    setBusy("import"); setError(null); setDone(null);
    try {
      const r = await call<{ created: number; skipped: number; stockRows: number; costs: number; counts: Counts }>("/api/settings/data-import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, fileName: file.name, fileBase64: file.b64, apply: true }) });
      if (!r.ok) {
        if (r.body.preview) setPreview(r.body.preview);
        setError(localizeApiError(r.body) ?? `HTTP ${r.status}`);
        return;
      }
      setCounts(r.body.counts);
      setDone(L(
        `استُورد ${r.body.created} سجل${r.body.skipped ? `، وتُخطّي ${r.body.skipped} موجود مسبقًا` : ""}${r.body.stockRows ? `، مع رصيد افتتاحي لـ ${r.body.stockRows} صنف` : ""}.`,
        `${r.body.created} record(s) imported${r.body.skipped ? `, ${r.body.skipped} already there skipped` : ""}${r.body.stockRows ? `, opening stock on ${r.body.stockRows} item(s)` : ""}.`,
      ));
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (user && !actor) {
    return (
      <OpsRoot className="tl-root">{frame(<>
        <PageHeader title={L("استيراد البيانات", "Data import")} />
        <Notice tone="warning">{L("الاستيراد للمدير أو لمن مُنح صلاحية «استيراد البيانات من Excel / قيود».", "Importing is for the administrator or a holder of the «Import data from Excel / Qoyod» permission.")}</Notice>
      </>)}</OpsRoot>
    );
  }

  const countOf = (k: ImportEntity) => (counts ? counts[k] : null);
  const rows = preview ? (onlyProblems ? preview.rows.filter((r) => r.status === "ERROR") : preview.rows) : [];
  const statusCell = (s: Preview["rows"][number]) =>
    s.status === "NEW" ? <span className="hr-dot tone-success"><span>{L("جديد", "New")}</span></span>
      : s.status === "EXISTS" ? <span className="hr-dot tone-neutral"><span>{L("موجود · يُتخطّى", "Exists · skipped")}</span></span>
        : <span className="hr-dot tone-danger" style={{ whiteSpace: "normal", alignItems: "flex-start" }}><span>{s.issues.map((i) => (ar ? i.ar : i.en)).join(" · ")}</span></span>;

  return (
    <OpsRoot className="tl-root">
      {frame(<>
        <PageHeader title={L("استيراد البيانات", "Data import")} />
        <p className="tl-sub">{L("من قيود أو من Excel", "From Qoyod or Excel")}<span className="tl-sep">·</span>{actor === "admin" ? L("للمدير فقط", "admins only") : L("بصلاحية «استيراد البيانات»", "with the data import permission")}</p>

        <nav className="hr-tabs is-underline tl-tabs" role="tablist" aria-label={L("نوع البيانات", "Kind of data")} data-testid="dimp-tabs">
          {IMPORT_ENTITIES.map((k) => (
            <button key={k} type="button" role="tab" className="hr-tab" aria-selected={entity === k} onClick={() => reset(k)} data-testid={`dimp-tab-${k}`}>
              {ar ? ENTITY_LABEL[k].ar : ENTITY_LABEL[k].en}
              {countOf(k) !== null ? <span className="hr-count">{countOf(k)}</span> : null}
            </button>
          ))}
        </nav>

        {error ? <div role="alert" onClick={() => setError(null)}><Notice tone="danger">{error}</Notice></div> : null}
        {done ? <div role="status" onClick={() => setDone(null)}><Notice tone="success">{done}</Notice></div> : null}

        <Sec title={L("١. القالب", "1. Template")} caption={L(INTRO[entity][0], INTRO[entity][1])}>
          <p className="ss-muted">{L(
            "نزّل القالب واملأه، أو صدّر القائمة من قيود واحفظها بصيغة Excel: العناوين العربية الشائعة مفهومة، والأعمدة غير المعروفة تُتجاهل مع تنبيه.",
            "Download the template and fill it, or export the list from Qoyod and save it as .xlsx: the common Arabic headers are understood; unknown columns are ignored with a warning.",
          )}</p>
          <a className="hr-btn is-sm" href={`/api/settings/data-import/template?entity=${entity}`} download data-testid="dimp-template">{L("تنزيل القالب (Excel)", "Download the template (Excel)")}</a>
        </Sec>

        <Sec title={L("٢. الملف", "2. File")} caption={L("يُفحص كل صف قبل أي حفظ. يُستورد الملف كله أو لا شيء.", "Every row is checked before anything is saved. The whole file comes in, or none of it.")}>
          <input key={inputKey} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" className="hr-input" onChange={pick} disabled={!!busy} data-testid="dimp-file" />
          {file ? <p className="ss-muted"><bdi>{file.name}</bdi> {busy === "check" ? L("— جارٍ الفحص…", "— checking…") : null}</p> : null}
          {file && !busy ? <Btn size="sm" onClick={() => check()} data-testid="dimp-recheck">{L("إعادة الفحص", "Check again")}</Btn> : null}
        </Sec>

        {preview ? (
          <Sec title={L("٣. المعاينة", "3. Preview")} caption={L(`صف العناوين: ${preview.headerRow}`, `Header row: ${preview.headerRow}`)} testId="dimp-preview">
            <Metrics items={[
              [L("الصفوف", "Rows"), preview.counts.rows],
              [L("جديد", "New"), preview.counts.new],
              [L("موجود (يُتخطّى)", "Exists (skipped)"), preview.counts.exists],
              [L("أخطاء", "Errors"), preview.counts.errors, null, preview.counts.errors ? "tone-danger" : ""],
              ...(entity === "green" || entity === "materials" ? [[L("برصيد افتتاحي", "With opening stock"), preview.counts.withStock] as [string, number]] : []),
            ]} />
            {preview.fileIssues.map((i, k) => <Notice key={`f${k}`} tone="danger">{ar ? i.ar : i.en}</Notice>)}
            {preview.warnings.length ? (
              <ul className="ss-muted" data-testid="dimp-warnings">
                {preview.warnings.map((i, k) => <li key={k}>{i.row ? L(`الصف ${i.row}: `, `Row ${i.row}: `) : ""}{ar ? i.ar : i.en}</li>)}
              </ul>
            ) : null}
            {preview.counts.errors ? (
              <label className="ss-muted"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> {L("الأخطاء فقط", "Errors only")}</label>
            ) : null}
            {rows.length ? (
              <div className="hr-tablewrap">
                <table className="hr-table is-dense" data-testid="dimp-rows">
                  <thead><tr>
                    <th>{L("الصف", "Row")}</th><th>{L("الرمز", "Code")}</th><th>{L("الاسم", "Name")}</th>
                    {entity === "green" || entity === "materials" ? <th>{L("الرصيد الافتتاحي", "Opening stock")}</th> : null}
                    <th>{L("الحالة", "Status")}</th>
                  </tr></thead>
                  <tbody>{rows.slice(0, ROW_CAP).map((r) => (
                    <tr key={r.row} data-testid="dimp-row">
                      <td className="hr-num">{r.row}</td><td><bdi>{r.code || "—"}</bdi></td><td>{r.name || "—"}</td>
                      {entity === "green" || entity === "materials" ? <td><bdi>{r.stock ?? "—"}</bdi></td> : null}
                      <td>{statusCell(r)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : null}
            {rows.length > ROW_CAP ? <p className="ss-muted">{L(`يُعرض أول ${ROW_CAP} صف من ${rows.length}.`, `Showing the first ${ROW_CAP} of ${rows.length} rows.`)}</p> : null}
            {preview.openingPosted && (entity === "green" || entity === "materials") ? <Notice tone="warning">{L("رُحّلت الأرصدة الافتتاحية: تُستورد الأصناف بلا كميات، والمخزون يدخل بفاتورة شراء.", "The opening is posted: items come in without quantities; stock comes in on a purchase invoice.")}</Notice> : null}
            <div className="ss-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {preview.ok
                ? preview.counts.new
                  ? <Btn variant="primary" busy={busy === "import"} onClick={commit} data-testid="dimp-commit">{L(`استيراد ${preview.counts.new} سجل`, `Import ${preview.counts.new} record(s)`)}</Btn>
                  : <span className="ss-muted">{L("كل الصفوف موجودة مسبقًا: لا جديد للاستيراد.", "Every row is already there: nothing new to import.")}</span>
                : <span className="ss-muted" data-testid="dimp-blocked">{L("لن يُستورد شيء حتى تُصحَّح الصفوف المذكورة في الملف ثم يُرفع من جديد.", "Nothing is imported until the rows listed are fixed in the file and it is uploaded again.")}</span>}
              <Btn variant="ghost" onClick={() => reset()}>{L("إلغاء", "Cancel")}</Btn>
            </div>
          </Sec>
        ) : null}

        <Sec title={L("الترتيب الصحيح", "The right order")} caption={L("قبل الأرصدة الافتتاحية", "Before the opening balances")}>
          <ol className="ss-muted">
            <li>{L("العملاء والموردون أولًا (بأسمائهم كما في قيود).", "Customers and suppliers first (named exactly as in Qoyod).")}</li>
            <li>{L("ثم البن الأخضر والمواد بكمياتها وتكلفتها في تاريخ القطع، ثم المنتجات.", "Then green coffee and materials with their quantities and cost at the cut-off, then products.")}</li>
            <li>{L("بعدها «المحاسبة › تقييم المخزون › الافتتاحي» لتطبيق قيمة المخزون، ثم «الأرصدة الافتتاحية» لأرصدة العملاء والموردين والبنوك.", "Then «Accounting › Inventory valuation › Opening» to apply the stock value, then «Opening balances» for the customer, supplier and bank balances.")}</li>
          </ol>
        </Sec>
      </>)}
    </OpsRoot>
  );
}
