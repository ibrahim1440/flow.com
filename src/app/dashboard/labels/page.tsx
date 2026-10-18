"use client";
/**
 * G-20 · Labels (Direction 2.1): search the coffee catalogue, select origins, and print them
 * through the G-21 print dialog (B-1) on any configured paper / printer profile. Without
 * labels.print there is no print action and the dialog never opens (G-21v); the print APIs refuse
 * on the server either way (B-9).
 */
import { useEffect, useMemo, useState } from "react";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { Btn, Flag, Notice, OpsBanner, OpsEmpty, OpsError, OpsLoading, OpsRoot, PageHeader, countNoun, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { PrintDialog, type DialogItem } from "@/components/print/PrintDialog";
import { PRINT_GATE_NOTE_ID, PrintNotCertifiedNotice, usePrintCertified } from "@/components/print/Certification";

type Product = {
  id: string; productNameEn: string; productNameAr: string | null;
  countryEn: string; countryAr: string | null; regionEn: string | null;
  regionAr: string | null; varietyEn: string | null; varietyAr: string | null;
  processEn: string | null; processAr: string | null; altitude: string | null;
  cupNotesEn: string | null; cupNotesAr: string | null;
  roastPathEn: string | null; roastPathAr: string | null;
};

const PRODUCT_FORMS: [string, string, string, string, string, string] = ["منتج واحد", "منتجان", "منتجات", "منتجًا", "product", "products"];
const FIELD_FORMS: [string, string, string, string, string, string] = ["حقل واحد", "حقلان", "حقول", "حقلًا", "field", "fields"];

/** Shown label fields (bilingual) with no value — they print «—» (A-6). */
function missingCount(p: Product): number {
  const pairs: [string | null, string | null][] = [
    [p.productNameEn, p.productNameAr], [p.countryEn, p.countryAr], [p.regionEn, p.regionAr], [p.varietyEn, p.varietyAr],
    [p.processEn, p.processAr], [p.altitude, p.altitude], [p.cupNotesEn, p.cupNotesAr], [p.roastPathEn, p.roastPathAr],
  ];
  return pairs.filter(([a, b]) => !a?.trim() || !b?.trim()).length;
}

export default function LabelsPage() {
  return <OpsRoot><LabelsInner /></OpsRoot>;
}

function LabelsInner() {
  const user = useUser();
  const L = useL();
  const { lang } = useI18n();
  const canPrint = hasSubPrivilege(user?.permissions ?? {}, "labels", "print");
  // The print certification gate (A-8): disabled with the explanation until the server says
  // printing is enabled (unknown counts as not enabled). The print APIs refuse on the server.
  const certified = usePrintCertified();
  const canProfiles = canPrint || user?.role === "admin" || hasSubPrivilege(user?.permissions ?? {}, "labels", "profile_manage");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState(false);
  const [printed, setPrinted] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch("/api/coffee-products", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); return r.json(); })
      .then((d: Product[]) => { if (alive) { setProducts(d); setErr(null); } })
      .catch((e) => { if (alive) setErr(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [tick]);

  const filtered = useMemo(() => (products ?? []).filter((p) =>
    `${p.productNameEn} ${p.productNameAr ?? ""} ${p.countryEn} ${p.countryAr ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())), [products, search]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const items: DialogItem[] = selected.map((id) => {
    const p = products?.find((x) => x.id === id);
    return { kind: "product", productId: id, label: (lang === "ar" ? p?.productNameAr || p?.productNameEn : p?.productNameEn) ?? id };
  });

  return (
    <div className="hr-page">
      <PageHeader title={L("الملصقات", "Labels")} actions={<>
        {canProfiles ? <a className="hr-btn" href="/dashboard/labels/profiles" data-testid="labels-profiles">{L("إعدادات الطباعة", "Print settings")}</a> : null}
        {canPrint ? (
          <Btn variant="primary" disabled={selected.length === 0 || certified !== true} onClick={() => setDialog(true)} data-testid="labels-print"
            aria-describedby={certified === false ? PRINT_GATE_NOTE_ID : undefined}>
            {L("طباعة المحدد", "Print selected")} (<span className="hr-num">{selected.length}</span>)
          </Btn>
        ) : null}
      </>}>
        <span>{products ? countNoun(products.length, lang, PRODUCT_FORMS) : "—"}</span>
        <span>{L("المحدد", "Selected")}: <span className="hr-num">{selected.length}</span></span>
        <span>{L("الطباعة من الحاسوب أو الجوال", "Print from a computer or a phone")}</span>
      </PageHeader>

      {!canPrint ? <Notice tone="info"><span data-testid="labels-no-print">{L("لا تملك صلاحية الطباعة (labels.print): تستطيع استعراض الملصقات فقط.", "You don’t have print permission (labels.print): you can view labels only.")}</span></Notice> : null}
      {canPrint && certified === false ? <PrintNotCertifiedNotice /> : null}
      {printed ? <OpsBanner tone="success" onClose={() => setPrinted(null)}><span data-testid="labels-printed">{L("سُجّلت مهمة الطباعة وفُتحت نافذة الطباعة في المتصفح.", "The print job was recorded and the browser’s print dialog opened.")}</span></OpsBanner> : null}

      <input className="hr-input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L("ابحث في المنتجات…", "Search products…")} aria-label={L("ابحث في المنتجات", "Search products")} style={{ maxWidth: 420 }} />

      {err ? <OpsError message={err} onRetry={() => setTick((t) => t + 1)} /> : !products ? <OpsLoading rows={6} /> : filtered.length === 0 ? (
        <OpsEmpty title={L("لا توجد منتجات", "No products found")} />
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow lbl-table" aria-label={L("منتجات القهوة", "Coffee products")} data-testid="labels-table">
            <thead>
              <tr>
                <th style={{ width: 44 }}><span className="hr-sr">{L("تحديد", "Select")}</span></th>
                <th>{L("المنتج", "Product")}</th>
                <th className="hr-hide-mobile">{L("الدولة", "Country")}</th>
                <th className="hr-hide-mobile">{L("الإيحاءات", "Cup notes")}</th>
                <th>{L("الحقول", "Fields")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const miss = missingCount(p);
                const on = selected.includes(p.id);
                return (
                  <tr key={p.id} aria-selected={on} className="is-clickable" onClick={() => toggle(p.id)}>
                    <td className="m-end lbl-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={on} onChange={() => toggle(p.id)} aria-label={`${L("تحديد", "Select")} ${p.productNameEn}`} style={{ width: 18, height: 18 }} />
                    </td>
                    <td className="m-title">
                      <span className="lbl-name">{lang === "ar" ? p.productNameAr || p.productNameEn : p.productNameEn}</span>
                      {miss ? <span className="hr-msub">{L("ينقص", "Missing")} {countNoun(miss, lang, FIELD_FORMS)} · {L("يُطبع «—»", "prints «—»")}</span> : null}
                      <span className="hr-caption lbl-name-alt" dir={lang === "ar" ? "ltr" : "rtl"}>{lang === "ar" ? p.productNameEn : p.productNameAr ?? "—"}</span>
                    </td>
                    <td className="hr-hide-mobile">{lang === "ar" ? p.countryAr || p.countryEn : p.countryEn}</td>
                    <td className="hr-hide-mobile"><span className="hr-caption">{(lang === "ar" ? p.cupNotesAr || p.cupNotesEn : p.cupNotesEn) ?? "—"}</span></td>
                    <td>{miss ? <Flag tone="warning">{L("ينقص", "Missing")} {countNoun(miss, lang, FIELD_FORMS)} · {L("يُطبع «—»", "prints «—»")}</Flag> : <span className="hr-caption">{L("مكتملة", "Complete")}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dialog && canPrint && certified === true ? (
        <PrintDialog open onClose={() => setDialog(false)} items={items} initialTemplate="COFFEE_ORIGIN"
          subtitle={`${countNoun(items.length, lang, PRODUCT_FORMS)} ${L("محددة في الملصقات", "selected in Labels")}`}
          onPrinted={(id) => { setPrinted(id); setDialog(false); }} />
      ) : null}
    </div>
  );
}
