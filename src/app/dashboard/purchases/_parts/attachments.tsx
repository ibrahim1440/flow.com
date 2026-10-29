"use client";
// «المرفقات» of a purchase invoice (BATCH22 WP-H): the receipt / tax-invoice images on file (a simple invoice must keep
// one; a posted invoice keeps all of them). Open opens the bytes (never cached); add attaches another; remove only before
// posting (the server refuses otherwise and keeps a simple invoice's last one).
import { useState } from "react";
import { Btn, Notice } from "@/components/ops/ui";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useApi, useLang } from "../../accounting/_ui/shell";

type Att = { id: string; fileName: string; contentType: string; sizeBytes: number; createdAt: string };

export function InvoiceAttachments({ invoiceId, canWrite, posted }: { invoiceId: string; canWrite: boolean; posted: boolean }) {
  const { L, lang } = useLang();
  const r = useApi<{ attachments: Att[] }>(`/api/purchases/invoices/${invoiceId}/attachments`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function call(init: RequestInit, url = `/api/purchases/invoices/${invoiceId}/attachments`) {
    setBusy(true); setError(null);
    const res = await fetch(url, init).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) { setError(localizeApiError(res ? await res.json().catch(() => ({})) : {}, lang) ?? L("تعذّر الحفظ.", "Could not save.")); return; }
    r.reload();
  }
  const rows = r.data?.attachments ?? [];
  return (
    <section className="acct-card" aria-labelledby="att-h" data-testid="invoice-attachments">
      <h2 id="att-h">{L("المرفقات", "Attachments")} <span className="hr-count">{rows.length}</span></h2>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {rows.length === 0 ? <p className="acct-hint">{L("لا مرفقات.", "No attachments.")}</p> : (
        <ul className="acct-checks">
          {rows.map((a) => (
            <li key={a.id}>
              <a href={`/api/purchases/invoices/${invoiceId}/attachments/${a.id}`} target="_blank" rel="noreferrer" data-testid={`att-${a.id}`}><bdi>{a.fileName}</bdi></a>
              <span className="hr-caption hr-num">{(a.sizeBytes / 1024).toFixed(0)} KB</span>
              {canWrite && !posted ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => void call({ method: "DELETE" }, `/api/purchases/invoices/${invoiceId}/attachments/${a.id}`)}>{L("حذف", "Remove")}</Btn> : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <label className="hr-field"><span className="hr-label">{L("إرفاق ملف (JPEG أو PNG أو PDF حتى 10 ميغابايت)", "Attach a file (JPEG, PNG or PDF up to 10 MB)")}</span>
          <input type="file" className="hr-input" accept="image/jpeg,image/png,application/pdf" disabled={busy} data-testid="att-add"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { const fd = new FormData(); fd.set("file", f); void call({ method: "POST", body: fd }); e.target.value = ""; } }} /></label>
      ) : null}
    </section>
  );
}
