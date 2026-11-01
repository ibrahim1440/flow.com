"use client";
// «استيراد البيانات» — the master data carried in from Qoyod before go-live, in Qoyod's own file formats (the owner's
// rule): its customers export, its vendors export and its products export, uploaded as they come out of Qoyod (the
// template is the same layout). Per kind: choose the file, see every row checked (new · already there · skipped ·
// error with its reason; products: what each row becomes here), then import — all or nothing, with a step-up. Records already in the system are skipped, so the same file again adds
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

type Counts = { customers: number; suppliers: number; products: number; green: number; materials: number; skus: number };
const ROW_CAP = 500;

const INTRO: Record<ImportEntity, [string, string]> = {
  customers: ["ملف «العملاء» المصدَّر من قيود كما هو. الاسم المكرر يُستورد مرة واحدة، والرصيد يظهر للعلم ويدخل لاحقًا في الأرصدة الافتتاحية.", "Qoyod's customers export as it is. A repeated name comes in once; the balance shows for reference and goes into the opening balances later."],
  suppliers: ["ملف «الموردون» المصدَّر من قيود كما هو. الرصيد يظهر للعلم ويدخل لاحقًا في الأرصدة الافتتاحية.", "Qoyod's vendors export as it is. The balance shows for reference and goes into the opening balances later."],
  products: ["ملف «المنتجات» المصدَّر من قيود (CSV) كما هو: كل صف يذهب إلى مكانه — بن أخضر، مادة (أكياس، استيكرات، أكواب، مستلزمات المقهى)، أو عبوة للبيع — والمصروفات والخدمات تُتخطّى.", "Qoyod's products export (CSV) as it is: each row goes to its place — green coffee, a material (bags, stickers, cups, café supplies) or a sellable pack — and expenses / services are skipped."],
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
  const [greenUnit, setGreenUnit] = useState<"g" | "kg">("g");

  useEffect(() => {
    call<{ counts: Counts }>("/api/settings/data-import").then((r) => { if (r.ok) setCounts(r.body.counts); }).catch(() => {});
  }, []);

  function reset(next?: ImportEntity) {
    if (next) setEntity(next);
    setFile(null); setPreview(null); setError(null); setOnlyProblems(false); setInputKey((k) => k + 1);
  }

  async function check(f = file, kind = entity, unit = greenUnit) {
    if (!f) return;
    setBusy("check"); setError(null); setDone(null);
    try {
      const r = await call<{ preview: Preview }>("/api/settings/data-import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity: kind, fileName: f.name, fileBase64: f.b64, greenUnit: unit }) });
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
      const r = await call<{ created: number; skipped: number; stockRows: number; costs: number; counts: Counts }>("/api/settings/data-import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, fileName: file.name, fileBase64: file.b64, apply: true, greenUnit }) });
      if (!r.ok) {
        if (r.body.preview) setPreview(r.body.preview);
        setError(localizeApiError(r.body) ?? `HTTP ${r.status}`);
        return;
      }
      setCounts(r.body.counts);
      setDone(L(
        `استُورد ${r.body.created} سجل${r.body.skipped ? `، وتُخطّي ${r.body.skipped} (موجود مسبقًا أو مكرر أو ليس صنف مخزون)` : ""}${r.body.stockRows ? `، مع رصيد افتتاحي لـ ${r.body.stockRows} صنف` : ""}.`,
        `${r.body.created} record(s) imported${r.body.skipped ? `, ${r.body.skipped} skipped (already there, repeated or not stock)` : ""}${r.body.stockRows ? `, opening stock on ${r.body.stockRows} item(s)` : ""}.`,
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
        : s.status === "SKIPPED" ? <span className="hr-dot tone-neutral"><span>{L("يُتخطّى", "Skipped")}</span></span>
          : <span className="hr-dot tone-danger" style={{ whiteSpace: "normal", alignItems: "flex-start" }}><span>{s.issues.map((i) => (ar ? i.ar : i.en)).join(" · ")}</span></span>;
  const stockKind = entity === "products";
  const money = (v: string | null) => (v === null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

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

        <Sec title={L("١. ملف قيود", "1. Qoyod file")} caption={L(INTRO[entity][0], INTRO[entity][1])}>
          <p className="ss-muted">{L(
            "صدّر القائمة من قيود وارفعها كما هي، دون تعديل الأعمدة. القالب بالأعمدة نفسها وترتيبها، لمن يُدخل البيانات يدويًا.",
            "Export the list from Qoyod and upload it as it is, columns untouched. The template has the same columns in the same order, for typing data by hand.",
          )}</p>
          {entity === "products" ? (
            <label className="ss-muted" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {L("كمية البن الأخضر في قيود بـ", "Green coffee quantity in Qoyod is in")}
              <select className="hr-input" style={{ width: "auto" }} value={greenUnit} onChange={(e) => { const u = e.target.value === "kg" ? "kg" : "g"; setGreenUnit(u); if (file) void check(file, entity, u); }} data-testid="dimp-green-unit">
                <option value="g">{L("الغرام (تُحوَّل إلى كيلو)", "grams (converted to kg)")}</option>
                <option value="kg">{L("الكيلو", "kilograms")}</option>
              </select>
            </label>
          ) : null}
          <a className="hr-btn is-sm" href={`/api/settings/data-import/template?entity=${entity}`} download data-testid="dimp-template">{L("تنزيل القالب بصيغة قيود (Excel)", "Download the template in Qoyod's layout (Excel)")}</a>
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
              [L("يُتخطّى", "Skipped"), preview.counts.skipped],
              [L("أخطاء", "Errors"), preview.counts.errors, null, preview.counts.errors ? "tone-danger" : ""],
              ...(stockKind ? [[L("برصيد افتتاحي", "With opening stock"), preview.counts.withStock] as [string, number]] : []),
            ]} />
            {preview.totals.balance !== null ? <p className="ss-muted" data-testid="dimp-balance">{L(`مجموع الأرصدة في الملف: ${money(preview.totals.balance)} ر.س — للعلم فقط، تدخل لاحقًا في «الأرصدة الافتتاحية» بأرصدة تاريخ القطع.`, `Balances in the file: SAR ${money(preview.totals.balance)} — for reference; they go into «Opening balances» later, at the cut-off date.`)}</p> : null}
            {preview.totals.stockValue !== null ? <p className="ss-muted" data-testid="dimp-stock-value">{L(`قيمة المخزون الافتتاحي بتكلفة قيود: ${money(preview.totals.stockValue)} ر.س (البن الأخضر والمواد). قارنها برصيد حساب المخزون في قيود.`, `Opening stock value at Qoyod's cost: SAR ${money(preview.totals.stockValue)} (green coffee and materials). Compare it with Qoyod's inventory account.`)}{preview.totals.finishedUnitsNotImported ? L(` ومخزون المنتج الجاهز (${preview.totals.finishedUnitsNotImported} وحدة) لا يُستورد: يُدخل بالجرد بعد التشغيل.`, ` Finished-goods stock (${preview.totals.finishedUnitsNotImported} units) is not imported: it is counted in after go-live.`) : ""}</p> : null}
            {preview.ignoredColumns.length ? <p className="ss-muted">{L(`أعمدة من قيود لا يحفظها النظام: ${preview.ignoredColumns.join("، ")}.`, `Qoyod columns the system does not keep: ${preview.ignoredColumns.join(", ")}.`)}</p> : null}
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
                    {stockKind ? <><th>{L("في النظام", "Becomes")}</th><th>{L("الرصيد الافتتاحي", "Opening stock")}</th></> : <th className="num">{L("الرصيد في قيود", "Qoyod balance")}</th>}
                    <th>{L("الحالة", "Status")}</th>
                  </tr></thead>
                  <tbody>{rows.slice(0, ROW_CAP).map((r) => (
                    <tr key={r.row} data-testid="dimp-row">
                      <td className="hr-num">{r.row}</td><td><bdi>{r.code || "—"}</bdi></td><td>{r.name || "—"}</td>
                      {stockKind ? <><td>{r.kind ?? "—"}</td><td><bdi>{r.stock ?? "—"}</bdi></td></> : <td className="num"><bdi>{r.balance ? money(r.balance) : "—"}</bdi></td>}
                      <td>{statusCell(r)}{r.note ? <div className="ss-muted" style={{ fontSize: 12 }}>{r.note}</div> : null}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : null}
            {rows.length > ROW_CAP ? <p className="ss-muted">{L(`يُعرض أول ${ROW_CAP} صف من ${rows.length}.`, `Showing the first ${ROW_CAP} of ${rows.length} rows.`)}</p> : null}
            {preview.openingPosted && stockKind ? <Notice tone="warning">{L("رُحّلت الأرصدة الافتتاحية: تُستورد الأصناف بلا كميات، والمخزون يدخل بفاتورة شراء.", "The opening is posted: items come in without quantities; stock comes in on a purchase invoice.")}</Notice> : null}
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
            <li>{L("العملاء والموردون أولًا (ملفا قيود كما هما).", "Customers and suppliers first (Qoyod's two files as they are).")}</li>
            <li>{L("ثم ملف المنتجات المصدَّر من قيود في تاريخ القطع: كمياته وتكلفته تصبح الرصيد الافتتاحي للمخزون.", "Then Qoyod's products export taken at the cut-off date: its quantities and costs become the opening stock.")}</li>
            <li>{L("بعدها «المحاسبة › تقييم المخزون › الافتتاحي» لتطبيق قيمة المخزون، ثم «الأرصدة الافتتاحية» لأرصدة العملاء والموردين والبنوك.", "Then «Accounting › Inventory valuation › Opening» to apply the stock value, then «Opening balances» for the customer, supplier and bank balances.")}</li>
          </ol>
        </Sec>
      </>)}
    </OpsRoot>
  );
}
