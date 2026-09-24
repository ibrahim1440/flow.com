"use client";

import { useState } from "react";

/**
 * Bulk import of leads from a CSV.
 *
 * ── Two steps, deliberately ──
 * A dry run that reports exactly what WOULD happen, then a commit. An import that silently
 * drops half a file, or half-applies it, leaves the operator unable to tell which rows
 * landed — so they either re-upload and double the good ones, or check two hundred rows by
 * hand. The dry run is what makes that impossible, and the server writes the whole accepted
 * set in one transaction or none of it.
 *
 * ── Duplicates are held back and listed, never merged ──
 * Several buyers at one café is the normal case, so a company-name match is not a duplicate.
 * One handset appearing twice is worth a second look, so a phone match holds the row back
 * until somebody says otherwise. Merging on similarity is how real customer records get
 * destroyed.
 */

type Preview = {
  wouldImport: number;
  rowsRead: number;
  problems: { row: number; column?: string; message: string }[];
  duplicatesInFile: { row: number; message: string }[];
  duplicatesInSystem: { row: number; companyName: string; matchesCompany: string }[];
  unknownColumns: string[];
};

export default function ImportDialog({
  lang,
  onClose,
  onDone,
}: {
  lang: "ar" | "en";
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const ar = lang === "ar";
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function post(dryRun: boolean) {
    setBusy(true);
    setErr("");
    const res = await fetch("/api/sales/leads/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv, dryRun, acknowledgeDuplicates: acknowledge }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);

    if (dryRun) {
      if (res.ok) {
        setPreview(data as Preview);
      } else {
        // A refused dry run still carries the row-level problems, and those are the useful
        // part: "the file is wrong" helps nobody, "row 14 has no contact name" does.
        setPreview(Array.isArray(data.problems) ? (data as Preview) : null);
        setErr(data.error ?? (ar ? "تعذّرت قراءة الملف." : "Could not read that file."));
      }
      return;
    }

    if (res.ok) {
      onDone(
        ar
          ? `استُورد ${data.imported} من ${data.rowsRead} صفاً.`
          : `Imported ${data.imported} of ${data.rowsRead} rows.`,
      );
    } else {
      setErr(data.error ?? (ar ? "تعذّر الاستيراد." : "Could not import."));
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-[60] flex items-start justify-center p-3 overflow-y-auto"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ar ? "استيراد عملاء محتملين" : "Import leads"}
        data-testid="import-dialog"
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-4"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-extrabold text-charcoal">
            {ar ? "استيراد عملاء محتملين" : "Import leads"}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brown/60 hover:text-charcoal text-xl font-black px-2"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {err && (
            <div
              className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm font-bold"
              role="alert"
            >
              {err}
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="import-file" className="block text-xs font-bold text-brown">
              {ar ? "ملف CSV" : "CSV file"}
            </label>
            <input
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              data-testid="import-file"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setCsv(await file.text());
                setPreview(null);
                setErr("");
              }}
              className="w-full text-sm file:me-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-cream file:text-brown file:font-bold"
            />
            <p className="text-[11px] text-brown/60 font-medium">
              {ar
                ? "العمودان المطلوبان: companyName و contactName. وتُقبل أيضاً phone و email و city و address و source و sourceNote و notes و nextFollowUpAt."
                : "Required columns: companyName and contactName. phone, email, city, address, source, sourceNote, notes and nextFollowUpAt are accepted too."}
            </p>
          </div>

          {/* A textarea as well as a file picker: pasting twenty rows out of a message is
              how a lot of real lead lists arrive, and it is also what makes this screen
              testable without a file-upload fixture. */}
          <div className="space-y-1">
            <label htmlFor="import-paste" className="block text-xs font-bold text-brown">
              {ar ? "أو الصق المحتوى" : "Or paste the content"}
            </label>
            <textarea
              id="import-paste"
              rows={4}
              value={csv}
              data-testid="import-paste"
              onChange={(e) => {
                setCsv(e.target.value);
                setPreview(null);
              }}
              placeholder="companyName,contactName,phone"
              className="w-full px-3 py-2.5 border-2 border-border rounded-xl text-xs font-mono"
            />
          </div>

          {csv.trim() && !preview && (
            <button
              onClick={() => post(true)}
              disabled={busy}
              data-testid="import-check"
              className="px-4 py-2.5 bg-white border-2 border-border rounded-xl text-sm font-bold hover:border-orange disabled:opacity-50"
            >
              {ar ? "فحص الملف" : "Check the file"}
            </button>
          )}

          {preview && (
            <div className="space-y-3" data-testid="import-preview">
              <div className="bg-info-bg border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate">
                {ar
                  ? `${preview.wouldImport} صفاً سيُستورد من ${preview.rowsRead} صفاً مقروءاً.`
                  : `${preview.wouldImport} of ${preview.rowsRead} rows would be imported.`}
              </div>

              {preview.unknownColumns?.length > 0 && (
                <p className="text-xs text-amber-800 font-bold">
                  {ar ? "أعمدة غير معروفة (تُتجاهل): " : "Unrecognised columns (ignored): "}
                  {preview.unknownColumns.join(", ")}
                </p>
              )}

              {preview.problems?.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-red-700 mb-1">
                    {ar ? "صفوف مرفوضة" : "Rejected rows"}
                  </p>
                  <ul className="text-xs space-y-0.5 max-h-40 overflow-y-auto" data-testid="import-problems">
                    {preview.problems.slice(0, 50).map((p, i) => (
                      <li key={i} className="text-red-700">
                        {ar ? "صف " : "Row "}
                        {p.row}
                        {p.column ? ` · ${p.column}` : ""} — {p.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.duplicatesInFile?.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-amber-800 mb-1">
                    {ar ? "تكرار داخل الملف" : "Duplicates within the file"}
                  </p>
                  <ul className="text-xs space-y-0.5 max-h-28 overflow-y-auto">
                    {preview.duplicatesInFile.slice(0, 30).map((d, i) => (
                      <li key={i} className="text-amber-800">
                        {ar ? "صف " : "Row "}
                        {d.row} — {d.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.duplicatesInSystem?.length > 0 && (
                <div data-testid="import-duplicates">
                  <p className="text-xs font-bold text-amber-800 mb-1">
                    {ar ? "أرقام هواتف موجودة مسبقاً" : "Phone numbers already in the system"}
                  </p>
                  <ul className="text-xs space-y-0.5 max-h-28 overflow-y-auto">
                    {preview.duplicatesInSystem.slice(0, 30).map((d, i) => (
                      <li key={i} className="text-amber-800">
                        {ar ? "صف " : "Row "}
                        {d.row}: {d.companyName} — {ar ? "يطابق " : "matches "}
                        {d.matchesCompany}
                      </li>
                    ))}
                  </ul>
                  <label className="flex items-center gap-2 text-xs font-bold mt-2">
                    <input
                      type="checkbox"
                      checked={acknowledge}
                      data-testid="acknowledge-duplicates"
                      onChange={(e) => {
                        setAcknowledge(e.target.checked);
                        // The preview is now stale: the answer to "what would this do"
                        // changes with the acknowledgement, so it is recomputed rather than
                        // left showing a number that no longer applies.
                        setPreview(null);
                      }}
                      className="w-4 h-4 accent-orange"
                    />
                    {ar
                      ? "استوردها رغم ذلك — هؤلاء أشخاص مختلفون في نفس المنشأة"
                      : "Import them anyway — these are different people at the same company"}
                  </label>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2.5 bg-white border-2 border-border rounded-xl text-sm font-bold hover:border-orange"
          >
            {ar ? "إلغاء" : "Cancel"}
          </button>
          <button
            onClick={() => post(false)}
            disabled={busy || !preview || preview.wouldImport === 0}
            data-testid="import-commit"
            className="px-4 py-2.5 bg-orange text-white rounded-xl text-sm font-bold hover:bg-orange-dark disabled:opacity-50"
          >
            {ar ? `استيراد ${preview?.wouldImport ?? 0} صفاً` : `Import ${preview?.wouldImport ?? 0} rows`}
          </button>
        </div>
      </div>
    </div>
  );
}
