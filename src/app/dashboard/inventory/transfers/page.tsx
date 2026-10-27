"use client";
// «تحويلات المخزون» — the transfer list (unified inventory phase 3, 20261115090000_stock_locations): filters by location
// (either side), status, date and creator (the owner's monthly review of who moved what — council EA3); a row opens the
// transfer. «تحويل جديد» opens the one-step form.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Field, OpsEmpty, OpsError, OpsLoading, OpsRoot, PageHeader, opsDate, rowOpen, useL } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import "@/components/ops/stock.css";
import { useUser } from "../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { locationName } from "@/lib/inventory/locations";
import { LocationSelect, useLocations } from "../_parts/locations";
import { unitWord } from "../_parts/shared";

type Row = {
  id: string; ref: string; transferDate: string; status: string; lineCount: number; createdBy: string; createdByName: string | null;
  fromLocation: { id: string; code: string; nameAr: string; nameEn: string | null }; toLocation: { id: string; code: string; nameAr: string; nameEn: string | null };
  items: { code: string; name: string; nameEn: string; qty: number; unit: string }[];
};

export default function TransfersPage() {
  const user = useUser();
  const router = useRouter();
  const { lang } = useI18n();
  const L = useL();
  const canWrite = !!user && (hasSubPrivilege(user.permissions, "inventory", "receive") || hasSubPrivilege(user.permissions, "inventory", "adjust"));
  const { state } = useLocations(true);
  const [loc, setLoc] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [by, setBy] = useState("");
  const [creators, setCreators] = useState<Map<string, string>>(() => new Map());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let off = false;
    const p = new URLSearchParams();
    if (loc) p.set("location", loc);
    if (status) p.set("status", status);
    if (dateFrom) p.set("dateFrom", dateFrom);
    if (dateTo) p.set("dateTo", dateTo);
    if (by) p.set("by", by);
    fetch(`/api/inventory/transfers?${p}`).then(async (r) => {
      if (off) return;
      if (!r.ok) { setFailed(true); return; }
      const list = (await r.json()) as Row[];
      setRows(list);
      setFailed(false);
      // The creator filter offers everyone seen so far (the first, unfiltered page names them).
      setCreators((m) => { const n = new Map(m); for (const x of list) if (x.createdBy && !n.has(x.createdBy)) n.set(x.createdBy, x.createdByName ?? x.createdBy); return n.size === m.size ? m : n; });
    }).catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [loc, status, dateFrom, dateTo, by]);

  const name = (l: Row["fromLocation"]) => locationName(l, lang);
  return (
    <OpsRoot className="stk-inventory">
      <div className="hr-page">
        <PageHeader
          title={L("تحويلات المخزون", "Stock transfers")}
          actions={<>
            <Link className="hr-btn is-ghost" href="/dashboard/inventory/locations">{L("المواقع", "Locations")}</Link>
            {canWrite ? <Link className="hr-btn is-primary" href="/dashboard/inventory/transfers/new" data-testid="transfer-new">{L("+ تحويل جديد", "+ New transfer")}</Link> : null}
          </>}
        >
          <span className="hr-caption">{L("نقل البن الأخضر والمواد بين المواقع. لا يغيّر رصيد الشركة ولا قيمته، ولا يُنشئ قيدًا محاسبيًا.", "Moves green coffee and materials between locations. The company's quantity and value do not change, and no journal entry is made.")}</span>
        </PageHeader>

        <div className="loc-filter stk-tool" data-testid="transfer-filters">
          <Field label={L("الموقع", "Location")}>
            <LocationSelect locations={state?.locations ?? []} value={loc} onChange={setLoc} allOption={L("كل المواقع", "All locations")} label={L("الموقع", "Location")} testId="transfer-filter-location" />
          </Field>
          <Field label={L("الحالة", "Status")}>
            <Select className="hr-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={L("الحالة", "Status")}>
              <option value="">{L("الكل", "All")}</option>
              <option value="POSTED">{L("منفّذ", "Posted")}</option>
              <option value="CANCELLED">{L("ملغى", "Cancelled")}</option>
            </Select>
          </Field>
          <Field label={L("من تاريخ", "From")}><input className="hr-input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></Field>
          <Field label={L("إلى تاريخ", "To")}><input className="hr-input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></Field>
          <Field label={L("أنشأه", "Created by")}>
            <Select className="hr-select" value={by} onChange={(e) => setBy(e.target.value)} aria-label={L("أنشأه", "Created by")} data-testid="transfer-filter-by">
              <option value="">{L("الكل", "Everyone")}</option>
              {[...creators].map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </Select>
          </Field>
        </div>

        {failed ? <OpsError message={L("تعذّر تحميل التحويلات.", "Could not load the transfers.")} /> : !rows ? <OpsLoading /> : rows.length === 0 ? (
          <OpsEmpty title={loc || status || dateFrom || dateTo || by ? L("لا تحويلات بهذه الفلاتر", "No transfers match these filters") : L("لا تحويلات بعد", "No transfers yet")}
            body={L("التحويل ينقل المخزون من موقع إلى آخر في خطوة واحدة.", "A transfer moves stock from one location to another in one step.")} />
        ) : (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow" aria-label={L("تحويلات المخزون", "Stock transfers")} data-testid="transfers-table">
              <thead>
                <tr>
                  <th>{L("التحويل", "Transfer")}</th>
                  <th className="hr-hide-mobile">{L("التاريخ", "Date")}</th>
                  <th className="hr-hide-mobile">{L("من ← إلى", "From → to")}</th>
                  <th className="hr-hide-compact">{L("الأصناف", "Items")}</th>
                  <th className="hr-hide-compact">{L("أنشأه", "Created by")}</th>
                  <th className="hr-hide-mobile">{L("الحالة", "Status")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} {...rowOpen(() => router.push(`/dashboard/inventory/transfers/${r.id}`))} data-testid={`trfrow-${r.ref}`}>
                    <td className="m-title">
                      <span className="strong hr-id">{r.ref}</span>
                      {r.status === "CANCELLED" ? <> <span className="stk-flag tone-warning">{L("ملغى", "Cancelled")}</span></> : null}
                      <span className="hr-msub">{opsDate(r.transferDate, lang)} · {name(r.fromLocation)} ← {name(r.toLocation)}</span>
                      <span className="hr-msub">{r.items.map((i) => `${lang === "ar" ? i.name : i.nameEn} ${Number(i.qty.toFixed(3))} ${unitWord(i.unit, lang, i.qty)}`).join(" · ")}{r.lineCount > 3 ? " …" : ""}</span>
                    </td>
                    <td className="hr-hide-mobile">{opsDate(r.transferDate, lang)}</td>
                    <td className="hr-hide-mobile"><span className="trf-route">{name(r.fromLocation)} <span aria-hidden="true">←</span><span className="hr-sr">{L("إلى", "to")}</span> {name(r.toLocation)}</span></td>
                    <td className="hr-hide-compact hr-caption">{r.items.map((i) => `${i.code} · ${Number(i.qty.toFixed(3))} ${unitWord(i.unit, lang, i.qty)}`).join("، ")}{r.lineCount > 3 ? ` (+${r.lineCount - 3})` : ""}</td>
                    <td className="hr-hide-compact">{r.createdByName ?? "—"}</td>
                    <td className="hr-hide-mobile">{r.status === "CANCELLED" ? L("ملغى", "Cancelled") : L("منفّذ", "Posted")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </OpsRoot>
  );
}
