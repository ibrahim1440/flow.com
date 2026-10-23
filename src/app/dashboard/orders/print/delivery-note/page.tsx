"use client";

import { use, useEffect, useState } from "react";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import { BRAND_PRIMARY_SRC, BRAND_PRIMARY_VIEWBOX } from "@/components/brand/BrandMark";
import { DocumentSheet, type DocRow } from "@/components/print/document/DocumentSheet";
import { DocumentPrintPage } from "@/components/print/document/DocumentPrintPage";
import { useI18n } from "@/lib/i18n/context";
import { longDate, type DocLang } from "@/lib/print/quote-document";
import {
  buildDeliveryNote, deliveryNoteCells, deliveryNoteColumns, isolate, quantityText,
  type DeliveryNoteItem, type DeliveryRecord,
} from "@/lib/print/delivery-note";

/**
 * «إشعار التسليم» — the printed delivery note (feat/print-docs). No Figma frame exists for it: the
 * page follows the quotation document's A4 layout (QP-05 1295:987) through DocumentSheet.
 *
 *   ?ids=<deliveryId>,…   the deliveries of one shipment (one order), from the dispatch screen or the order;
 *   ?lang=ar|en           the document's language (default: the interface's).
 *
 * Quantities only — no prices, no tax wording: it is not an invoice. Its data endpoint
 * (/api/print/documents/delivery-note) follows the document gate and the order's access rules.
 */
type Seller = { nameAr: string | null; nameEn: string | null; addressAr: string | null; addressEn: string | null; phone: string | null; crNumber: string | null };
type Data = {
  order: { id: string; orderNumber: number; status: string };
  customer: { name: string; nameAr: string | null; phone: string | null; address: string | null; city: string | null; contact: { name: string; role: string | null; phone: string | null } | null };
  items: DeliveryNoteItem[];
  history: DeliveryRecord[];
  noteIds: string[];
  seller: Seller;
};
type Search = { ids?: string; lang?: string; from?: string };
const NO_SEARCH: Promise<Search> = Promise.resolve({});

export default function DeliveryNotePrintPage({ searchParams = NO_SEARCH }: { searchParams?: Promise<Search> }) {
  const sp = use(searchParams);
  const { lang } = useI18n();
  const ar = lang === "ar";
  const docLang: DocLang = sp.lang === "en" || sp.lang === "ar" ? sp.lang : lang === "en" ? "en" : "ar";
  const ids = sp.ids ?? "";
  const back = sp.from === "dispatch" ? { href: "/dashboard/dispatch", label: ar ? "التسليم" : "Dispatch" } : { href: "/dashboard/orders", label: ar ? "الطلبات" : "Orders" };
  const q = new URLSearchParams({ ids, lang: docLang === "ar" ? "en" : "ar", ...(sp.from ? { from: sp.from } : {}) });

  useD21Title(ar ? "إشعار التسليم" : "Delivery note");
  useD21Phone({ title: ar ? "إشعار التسليم" : "Delivery note", back: back.href });

  return (
    <DocumentPrintPage
      testId="delivery-note-page"
      back={back}
      title={ar ? "إشعار التسليم" : "Delivery note"}
      docLang={docLang}
      otherLanguageHref={`/dashboard/orders/print/delivery-note?${q.toString()}`}
    >
      {() => <DeliveryNoteDoc ids={ids} lang={docLang} />}
    </DocumentPrintPage>
  );
}

function DeliveryNoteDoc({ ids, lang }: { ids: string; lang: DocLang }) {
  const { lang: uiLang } = useI18n();
  const uiAr = uiLang === "ar";
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    fetch(`/api/print/documents/delivery-note?ids=${encodeURIComponent(ids)}`, { cache: "no-store" }).then(async (r) => {
      const b = await r.json().catch(() => ({}));
      if (off) return;
      if (r.ok) { setData(b as Data); setError(null); }
      else setError((uiAr ? b.errorAr : b.error) || b.error || (uiAr ? "تعذّر تحميل إشعار التسليم." : "Could not load the delivery note."));
    }).catch(() => { if (!off) setError(uiAr ? "تعذّر الاتصال بالخادم." : "Could not reach the server."); });
    return () => { off = true; };
  }, [ids, uiAr]);

  if (error) return <p className="notice er dsh-err" role="alert" data-testid="alert-error">{error}</p>;
  if (!data) return <p className="dsh-wrap dsh-wait" role="status">{uiAr ? "جارٍ التحميل…" : "Loading…"}</p>;

  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const note = buildDeliveryNote({ orderNumber: data.order.orderNumber, items: data.items, history: data.history, noteIds: data.noteIds });
  const s = data.seller;
  const sellerName = (ar ? s.nameAr || s.nameEn : s.nameEn || s.nameAr) || null;
  const sellerLines = [
    (ar ? s.addressAr || s.addressEn : s.addressEn || s.addressAr) && <bdi key="a">{ar ? s.addressAr || s.addressEn : s.addressEn || s.addressAr}</bdi>,
    s.phone && <>{L("الهاتف ", "Phone ")}<bdi dir="ltr" className="n">{s.phone}</bdi></>,
    s.crNumber && <>{L("السجل التجاري ", "CR ")}<bdi dir="ltr" className="n">{s.crNumber}</bdi></>,
  ].filter(Boolean);
  const c = data.customer;
  const customerName = ar ? c.nameAr || c.name : c.name;
  const place = [c.city, c.address].filter(Boolean).join(" · ");

  const metaStart: DocRow[] = [
    { label: L("رقم الطلب", "Order number"), value: <bdi className="mono" dir="ltr">#{note.orderNumber}</bdi>, testId: "dn-order" },
    { label: L("تاريخ التسليم", "Delivery date"), value: longDate(note.deliveredAt, lang), testId: "dn-date" },
    { label: L("نوع التسليم", "Delivery"), value: note.partial ? L("جزئي", "Partial") : L("كامل — اكتمل الطلب", "Full — the order is complete"), testId: "dn-kind" },
  ];
  const metaEnd: DocRow[] = [{ label: L("العميل", "Customer"), value: <bdi>{customerName}</bdi>, testId: "dn-customer" }];
  if (place) metaEnd.push({ label: L("العنوان", "Address"), value: <bdi>{place}</bdi>, testId: "dn-address" });
  if (c.phone) metaEnd.push({ label: L("الجوال", "Phone"), value: <bdi dir="ltr">{c.phone}</bdi>, testId: "dn-phone" });
  if (c.contact) {
    metaEnd.push({
      label: L("جهة الاتصال", "Contact"),
      value: <><bdi>{c.contact.name}</bdi>{c.contact.role ? <> · <bdi>{c.contact.role}</bdi></> : null}{c.contact.phone ? <> · <bdi dir="ltr">{c.contact.phone}</bdi></> : null}</>,
      testId: "dn-contact",
    });
  }

  const units = note.lines.filter((l) => l.isUnit).reduce((a, l) => a + l.quantity, 0);
  const kgs = Math.round(note.lines.filter((l) => !l.isUnit).reduce((a, l) => a + l.quantity, 0) * 1000) / 1000;
  const totalText = [units > 0 ? quantityText(units, true, lang) : null, kgs > 0 ? quantityText(kgs, false, lang) : null].filter(Boolean).join(" + ");

  return (
    <div className="dsh-wrap">
      <DocumentSheet
        lang={lang}
        testId="delivery-note"
        logo={{ src: BRAND_PRIMARY_SRC, alt: L("حِقبة", "Hiqbah"), width: Math.round(54 * BRAND_PRIMARY_VIEWBOX.w / BRAND_PRIMARY_VIEWBOX.h), height: 54 }}
        seller={sellerName || sellerLines.length ? { name: sellerName, lines: sellerLines, testId: "doc-seller" } : null}
        title={{
          main: L("إشعار تسليم", "Delivery note"),
          lines: [
            <bdi key="n" className="mono" dir="ltr">{note.docNumber}</bdi>,
            <span key="alt" className="alt" lang={ar ? "en" : "ar"} dir={ar ? "ltr" : "rtl"}>{ar ? "Delivery note" : "إشعار تسليم"}</span>,
          ],
        }}
        banner={note.partial ? {
          tone: "warning",
          title: L("تسليم جزئي", "Partial delivery"),
          text: L("لم يُسلَّم الطلب كاملًا بعد: المتبقي مذكور في كل سطر وتحت الجدول.", "The order is not fully delivered yet: what remains is stated on each line and below the table."),
          testId: "dn-partial-banner",
        } : null}
        metaStart={metaStart}
        metaEnd={metaEnd}
        columns={deliveryNoteColumns(lang)}
        rows={note.lines.map((l, i) => deliveryNoteCells(l, i + 1, lang))}
        extra={
          <>
            <section className="dsh-extra" data-testid="dn-total">
              <p><strong>{L("إجمالي هذا التسليم: ", "Delivered on this note: ")}</strong><bdi>{totalText || "—"}</bdi></p>
            </section>
            {note.outstanding.length > 0 ? (
              <section className="dsh-extra" data-testid="dn-outstanding">
                <h2>{L("بنود أخرى في الطلب لم تُسلَّم كاملًا", "Other lines of the order still to deliver")}</h2>
                <ul>
                  {note.outstanding.map((o) => (
                    <li key={o.itemId}>
                      <bdi>{ar ? o.name.ar : o.name.en}</bdi>{o.skuCode ? <> · <bdi className="mono" dir="ltr">{o.skuCode}</bdi></> : null}
                      {" — "}{L("المتبقي ", "remaining ")}<bdi>{quantityText(o.remaining, o.isUnit, lang)}</bdi>
                      {" "}{L("من ", "of ")}<bdi>{quantityText(o.ordered, o.isUnit, lang)}</bdi>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        }
        notes={note.notes.length ? { label: L("ملاحظات", "Notes"), text: note.notes.join("\n"), testId: "dn-notes" } : null}
        signatures={[
          { label: L("المسلِّم (السائق)", "Delivered by (driver)"), lines: [L("الاسم", "Name"), L("التوقيع", "Signature"), L("التاريخ والوقت", "Date and time")], testId: "dn-sign-driver" },
          { label: L("المستلم", "Received by"), lines: [L("الاسم", "Name"), L("التوقيع", "Signature"), L("التاريخ والوقت", "Date and time")], testId: "dn-sign-receiver" },
        ]}
        footer={{
          legal: L("يُثبت توقيع المستلم استلام الكميات المذكورة أعلاه بحالة سليمة.", "The receiver's signature confirms receipt of the quantities above in good condition."),
          page: { before: L("الصفحة ", "Page "), between: L(" من ", " of "), after: ` · ${L("طلب", "Order")} ${isolate(`#${note.orderNumber}`)}` },
          docNumber: note.docNumber,
        }}
      />
    </div>
  );
}
