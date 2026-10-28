"use client";

// «تقييم المخزون» (Figma ACC-100 / 100s; «المخزون والتكلفة» before unified inventory phase 4): the inventory's MONEY —
// its cost and its match with the books. The quantities and their daily movement are the operations inventory's
// («المخزون والمشتريات › المخزون»), linked from the scope line. Sections:
//   قيمة المخزون — the value by category (phase 1: root → sub-category, a subtotal per inventory account) or by
//                  location (phase 3: an ESTIMATE, site qty × the company's average cost), the per-account match with
//                  the general ledger, the items; filters (category, location), CSV; every item opens its cost-ledger
//                  movements (?item=), each linked to its source document and journal entry;
//   تكلفة الإنتاج — production cost per roast (green cost, loss, cost per roasted kg);
//   بضاعة مستلمة لم تُرحَّل فاتورتها — the open receipts whose invoice is not posted (GRNI): «بلا فاتورة» or «فاتورة
//                  بانتظار الاعتماد» (phase 4, council F2 — with the one-step invoice a receipt can carry an unposted invoice);
//   المخزون الافتتاحي — the go-live valuation (on hand × owner-entered or last-known cost → the opening grid);
//   السياسة والرواتب — the abnormal-loss threshold and the payroll accounts' alignment.
// Old addresses (?tab=reconciliation|batches|receipts…) land on the view that holds them now.
import Link from "next/link";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OpsLoading, Btn } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { GL_STATE, LEGACY_INVENTORY_TAB, MOVE_KIND, SOURCE_DOC, SOURCE_EVENT, plain } from "@/lib/accounting/source-links";
import { useUser } from "../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { AcctShell, Msg, Term, money, todayRiyadh, useApi, useCanOpen, useHasAccounting, useLang, useWrite, type Setup } from "./shell";

type RoleKey = "INVENTORY_GREEN" | "INVENTORY_PACKAGING" | "INVENTORY_CAFE" | "INVENTORY_ROASTED" | "INVENTORY_PACKED";
const ROLE_AR: Record<string, [string, string]> = {
  INVENTORY_GREEN: ["البن الأخضر", "Green coffee"], INVENTORY_PACKAGING: ["مواد التغليف", "Packaging"], INVENTORY_CAFE: ["مواد المقهى", "Café consumables"],
  INVENTORY_ROASTED: ["البن المحمص", "Roasted coffee"], INVENTORY_PACKED: ["المنتجات المعبأة", "Packed goods"],
};
const KIND_AR: Record<string, [string, string]> = { GREEN_BEAN: ["لوط أخضر", "Green lot"], MATERIAL: ["مادة", "Material"], ROASTED_BATCH: ["دفعة محمصة", "Roast"], FG_LOT: ["لوط معبأ", "Packed lot"] };
const SOURCE_AR: Record<string, [string, string]> = { OWNER: ["أدخلها المالك", "Owner"], MOVING_AVG: ["المتوسط المرجّح", "Moving average"], LAST_RECEIPT: ["آخر استلام", "Last receipt"], LAST_PURCHASE: ["آخر شراء", "Last purchase"], NONE: ["لا تكلفة معروفة", "No known cost"] };
const UNIT: Record<string, [string, string]> = { kg: ["كغ", "kg"], gram: ["غ", "g"], piece: ["قطعة", "pcs"], unit: ["وحدة", "units"], liter: ["لتر", "L"] };
const LOC_TYPE: Record<string, [string, string]> = { ROASTERY: ["محمصة", "Roastery"], WAREHOUSE: ["مستودع", "Warehouse"], CAFE: ["مقهى", "Café"], BRANCH: ["فرع", "Branch"], OTHER: ["أخرى", "Other"], TRANSIT: ["نظام", "System"] };
/** The system TRANSIT location (council M2): what was sent and not yet received — named the same in the table and the filter. */
const TRANSIT_LABEL: [string, string] = ["في الطريق (بضاعة مرسلة لم تُستلم)", "In transit (sent, not yet received)"];

type Rec = {
  asOf: string; active: boolean; goLiveDate: string | null; openingPosted: boolean; openingAppliedAt: string | null;
  inventory: { role: RoleKey; account: { id: string; code: string; name: string } | null; subLedger: string; gl: string; difference: string; skipped: string; openingPending: string; unexplained: string; status: "MATCHED" | "EXPLAINED" | "UNEXPLAINED" }[];
  totals: { subLedger: string; gl: string; difference: string };
  wip: { account: { code: string; name: string } | null; gl: string };
  grni: { account: { code: string; name: string } | null; openReceipts: string; gl: string; difference: string; count: number; noInvoice: { count: number; value: string }; awaitingApproval: { count: number; value: string } };
  ap: { account: { code: string; name: string } | null; openItems: string; gl: string; difference: string };
  supplierClaims?: { account: { code: string; name: string } | null; count: number; openClaims: string; gl: string; difference: string; openingPending: string; unexplained: string; status: string };
};
type Site = { locationId: string; qty: string; value: string };
type VRow = {
  id: string; kind: string; entityId: string; role: string; account: { code: string; name: string; nameEn: string } | null; categoryId: string; rootId: string; categoryName: string | null; categoryNameEn: string | null;
  label: string; sub: string | null; unit: string; exists: boolean; qty: string; opsQty: string | null; avgCost: string; value: string; uncosted: boolean; drift: string | null;
  sites: Site[]; shown: { qty: string; value: string; estimate: boolean }; itemHref: string; movementsHref: string | null; siteQtyDiff: string | null; noLedger: boolean; splitFrom: { id: string; label: string; href: string } | null;
};
type CatGroup = { id: string; nameAr: string; nameEn: string | null; value: string; count: number; direct: { value: string; count: number; role: string | null }; children: { id: string; nameAr: string; nameEn: string | null; role: string; value: string; count: number }[] };
type Report = {
  asOf: string; filters: { category: string | null; location: string | null }; estimate: boolean; total: string; shownTotal: string; count: number; rows: VRow[]; categories: CatGroup[];
  accounts: { role: string; value: string; count: number; account: { code: string; name: string; nameEn: string } | null; ledger: string; gl: string; difference: string; unexplained: string; status: string }[];
  reconciliation: { ledger: string; gl: string; difference: string; unexplained: string };
  locations: { id: string; code: string; nameAr: string; nameEn: string | null; type: string; isActive: boolean; isProduction: boolean; isTransit: boolean; value: string; count: number }[];
  unallocated: string; unallocatedCount: number; locationsTotal: string; uncostedAtSites: number;
  qtyDifferences: { id: string; label: string; sub: string | null; unit: string; ledgerQty: string; siteQty: string; difference: string }[];
  categoryOptions: { id: string; nameAr: string; nameEn: string | null; parentId: string | null; sortOrder: number }[];
};
type Moves = {
  holder: { id: string; kind: string; entityId: string; role: string; account: { code: string; name: string; nameEn: string } | null; label: string; sub: string | null; unit: string; qty: string; avgCost: string; value: string; opsQty: string | null; category: { id: string; nameAr: string; nameEn: string | null; parent: { id: string; nameAr: string; nameEn: string | null } | null } | null; itemHref: string; splitFrom: { id: string; label: string; href: string } | null };
  moves: { id: string; day: string; kind: string; qty: string; value: string; unitCost: string; qtyAfter: string; valueAfter: string; sourceModule: string; sourceType: string; sourceId: string; sourceEvent: string; eventCode: string; sourceNumber: string | null; docCode?: string; sourceHref: string | null; lots: { id: string; label: string; href: string }[]; journalEntryId: string | null; journalHref: string | null; glState: string; reason: string | null }[];
  paging: { page: number; pages: number; pageSize: number; count: number };
  totals: { qty: string; value: string; ties: boolean };
};
type Batches = { from: string; to: string; rows: { id: string; batchNumber: string; date: string; product: string | null; greenLot: string | null; greenKg: string; roastedKg: string; lossKg: string; lossPct: string | null; greenCost: string | null; abnormalCost: string | null; roastedCost: string | null; roastedUnitCost: string | null; greenUnitCost: string | null; posted: boolean; journalEntryId: string | null }[]; totals: { greenKg: string; roastedKg: string; greenCost: string; roastedCost: string; abnormalCost: string; lossPct: string | null; roastedUnitCost: string | null } };
type Receipt = { purchaseRecordId: string; supplierName: string; type: string; date: string; quantity: string; value: string; glState: string; notes: string | null; invoice: { id: string; number: string | null; status: string | null } | null };
type Opening = { goLiveDate: string | null; openingPosted: boolean; appliedAt: string | null; total: string; missing: number; byRole: { role: string; value: string; count: number }[]; grni: { count: number; value: string };
  supplierClaims?: { count: number; value: string; suppliers: { supplierId: string; name: string; value: string }[] };
  apOpening?: { supplierId: string; name: string; expected: string; grid: string; difference: string }[]; rows: { kind: string; entityId: string; label: string; sub: string | null; role: string; unit: string; qty: string; unitCost: string | null; source: string; value: string }[] };
type Policy = { abnormalRoastLossPct: string | null; abnormalUseProductLimit: boolean; updatedAt: string | null };
type Align = { aligned: boolean; hrAccountingEnabled: boolean; rows: { key: string; role: string | null; why: string; whyEn?: string; hrAccount: { code: string; name: string } | null; roleAccount: { code: string; name: string } | null; status: string }[] };

const VIEWS = [["value", "قيمة المخزون", "Inventory value"], ["batches", "تكلفة الإنتاج", "Production cost"], ["grni", "بضاعة مستلمة لم تُرحَّل فاتورتها", "Received, not yet billed in the books"], ["opening", "المخزون الافتتاحي", "Opening inventory"], ["policy", "السياسة والرواتب", "Policy & payroll"]] as const;
type Go = (patch: Record<string, string | null>) => void;

/**
 * The screen. Also served at /dashboard/inventory/valuation (phase 4, council F7) for the inventory › valuation duty, which
 * holds no accounting module: the cost-ledger figures only (value by category and location, the drill-down, cost per
 * roast); the general-ledger match, received-not-billed, the opening tool and the policy stay the accounting module's.
 */
export function InventoryValuationScreen() {
  const { L } = useLang();
  const acct = useHasAccounting();
  const user = useUser();
  const valuer = !!user && hasSubPrivilege(user.permissions, "inventory", "valuation");
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const canOpen = useCanOpen();
  const legacy = sp.get("tab");
  const views = acct ? VIEWS : VIEWS.filter((v) => v[0] === "value" || v[0] === "batches");
  const view = (views.find((v) => v[0] === (sp.get("view") ?? (legacy ? LEGACY_INVENTORY_TAB[legacy] : null)))?.[0] ?? "value") as (typeof VIEWS)[number][0];
  const item = sp.get("item");
  // An old address (?tab=…) is replaced by the view that holds it now.
  useEffect(() => {
    if (!legacy) return;
    const p = new URLSearchParams(sp.toString());
    p.delete("tab");
    const v = LEGACY_INVENTORY_TAB[legacy];
    if (v && v !== "value") p.set("view", v);
    router.replace(p.toString() ? `${path}?${p}` : path);
  }, [legacy, path, router, sp]);
  const go: Go = (patch) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") p.delete(k); else p.set(k, v); }
    router.replace(p.toString() ? `${path}?${p}` : path, { scroll: false });
  };
  const setup = useApi<Setup>(acct ? "/api/accounting/setup" : null);
  const role = (r: string) => L(ROLE_AR[r]?.[0] ?? r, ROLE_AR[r]?.[1] ?? r);
  const csvQuery = new URLSearchParams({ format: "csv", ...(sp.get("cat") ? { category: sp.get("cat")! } : {}), ...(sp.get("loc") ? { location: sp.get("loc")! } : {}) });
  return (
    <AcctShell setup={setup.data} title={L("تقييم المخزون", "Inventory valuation")}
      actions={item ? undefined : view === "value" ? <a className="hr-btn" href={`/api/accounting/inventory/valuation/groups?${csvQuery}`} data-testid="valuation-csv">{L("تصدير CSV", "Export CSV")}</a> : view === "batches" ? <a className="hr-btn" href={`/api/accounting/inventory/batches?format=csv&from=${sp.get("from") ?? ""}&to=${sp.get("to") ?? ""}`}>{L("تصدير CSV", "Export CSV")}</a> : undefined}>
      <p className="acct-scope" data-testid="valuation-scope">
        <span>{acct ? L("هذه الشاشة للقيمة بالريال فقط: تكلفة المخزون ومطابقتها مع دفتر الأستاذ. الكميات وحركتها اليومية في شاشة المخزون.", "This screen is money only: the inventory's cost and its match with the general ledger. Quantities and their daily movement are in the Inventory screen.")
          : L("هذه الشاشة للقيمة بالريال فقط: تكلفة المخزون من سجل التكلفة. الكميات وحركتها اليومية في شاشة المخزون؛ المطابقة مع دفتر الأستاذ لمن يملك صلاحية المحاسبة.", "This screen is money only: the inventory's cost from the cost ledger. Quantities and their daily movement are in the Inventory screen; the match with the general ledger is for accounting.")}</span>
        {canOpen("/dashboard/inventory") ? <Link href="/dashboard/inventory" data-testid="valuation-qty-link">{L("الكميات في المخزون ←", "Quantities in Inventory →")}</Link> : null}
      </p>
      {user && !acct && !valuer ? <p role="alert" className="hr-err" data-testid="valuation-forbidden">{L("لا صلاحية لعرض تقييم المخزون (المخزون › تقييم المخزون وتكلفة الإنتاج).", "You have no access to the inventory valuation (inventory › valuation and production cost).")}</p>
        : item ? <DrillView id={item} back={() => go({ item: null })} /> : (
        <>
          <div className="acct-row">
            <div className="acct-seg" role="group" aria-label={L("القسم", "Section")}>
              {views.map(([k, ar, en]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => go({ view: k === "value" ? null : k, tab: null })} data-testid={`inv-view-${k}`}>{L(ar, en)}</button>)}
            </div>
          </div>
          {view === "value" ? <ValueView role={role} sp={sp} go={go} acct={acct} base={path} /> : view === "batches" ? <BatchView from={sp.get("from")} to={sp.get("to")} go={go} /> : view === "grni" ? <GrniView /> : view === "opening" ? <OpeningView role={role} canEdit={!!setup.data?.can.opening} /> : <PolicyView canEdit={!!setup.data?.can.settings} />}
        </>
      )}
    </AcctShell>
  );
}

function Metric({ k, v, s, bad, testId }: { k: ReactNode; v: string; s?: string; bad?: boolean; testId?: string }) {
  const { L } = useLang();
  return <div className="acct-metric"><span className="k">{k}</span><span className={`v${bad ? " is-bad" : ""}`} data-testid={testId}>{money(v)} <small className="acct-hint">{L("ر.س", "SAR")}</small></span>{s ? <span className="s">{s}</span> : null}</div>;
}

const pct = (part: string, whole: string) => (Number(whole) ? `${((Number(part) * 100) / Number(whole)).toFixed(1)}%` : "—");

function ValueView({ role, sp, go, acct, base }: { role: (r: string) => string; sp: { get(k: string): string | null }; go: Go; acct: boolean; base: string }) {
  const { L, lang } = useLang();
  const by = sp.get("by") === "location" ? "location" : "category";
  const cat = sp.get("cat") ?? "";
  const loc = sp.get("loc") ?? "";
  // The general-ledger side only for the accounting module (council F7): an inventory › valuation holder sees the cost ledger.
  const rec = useApi<Rec>(acct ? "/api/accounting/inventory/reconciliation" : null);
  const q = new URLSearchParams({ ...(cat ? { category: cat } : {}), ...(loc ? { location: loc } : {}) }).toString();
  const rep = useApi<Report>(`/api/accounting/inventory/valuation/groups${q ? `?${q}` : ""}`);
  if ((acct && rec.error) || rep.error) return <p role="alert" className="hr-err">{rec.error ?? rep.error}</p>;
  if ((acct && !rec.data) || !rep.data) return <OpsLoading />;
  const r = rec.data, v = rep.data;
  const name = (x: { nameAr: string; nameEn: string | null }) => (lang === "en" ? x.nameEn || x.nameAr : x.nameAr);
  const st = (s: string) => s === "MATCHED" ? <span className="hr-dot tone-success"><span>{L("مطابق", "Matched")}</span></span> : s === "EXPLAINED" ? <span className="hr-dot tone-info"><span>{L("فرق مفسَّر", "Explained")}</span></span> : <span className="hr-dot tone-warning"><span>{L("غير مسوّى", "Unreconciled")}</span></span>;
  const unexplained = r ? r.inventory.reduce((s, x) => s + Number(x.unexplained), 0) : 0;
  const filtered = !!(cat || loc);
  const showGl = !!r && !filtered;
  const accTotal = v.accounts.reduce((s, a) => s + Number(a.value), 0);
  const catTotal = v.categories.reduce((s, c) => s + Number(c.value), 0);
  const ties = Math.abs(accTotal - catTotal) < 0.005 && (filtered || !r || Math.abs(catTotal - Number(r.totals.subLedger)) < 0.005);
  const roots = v.categoryOptions.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder);
  const siteName = (l: Report["locations"][number]) => (l.isTransit ? L(TRANSIT_LABEL[0], TRANSIT_LABEL[1]) : name(l));
  const locName = (id: string) => { const l = v.locations.find((x) => x.id === id); return l ? siteName(l) : id; };
  const accCell = (a: { code: string; name: string; nameEn: string } | null, rk: string | null) => a ? <><span className="acct-code">{a.code}</span> {lang === "en" ? a.nameEn : a.name}</> : rk ? <Term tech={rk}><span className="acct-warn">{role(rk)} · {L("الحساب غير محدد في الإعدادات", "no account set in settings")}</span></Term> : "—";
  return (
    <>
      {r ? (
        <div className="acct-metrics" data-testid="inv-metrics">
          <Metric k={<Term tech="Inventory cost sub-ledger">{L("سجل تكلفة المخزون", "Inventory cost ledger")}</Term>} v={r.totals.subLedger} s={L("الكمية × متوسط التكلفة المرجّح", "Quantity × moving average cost")} testId="inv-subledger" />
          <Metric k={<Term tech="GL">{L("دفتر الأستاذ · حسابات المخزون", "General ledger · inventory accounts")}</Term>} v={r.totals.gl} s={L("أرصدة الحسابات المرحّلة", "Posted account balances")} testId="inv-gl" />
          <Metric k={L("الفرق", "Difference")} v={r.totals.difference} bad={Math.abs(unexplained) > 0.004} s={Math.abs(unexplained) > 0.004 ? L("فيه جزء غير مفسَّر", "Partly unexplained") : L("مفسَّر بالكامل", "Fully explained")} testId="inv-diff" />
          <Metric k={<Term tech="WIP – roasting">{L("تحميص تحت التشغيل", "Roasting in progress")}</Term>} v={r.wip.gl} s={L("يجب أن يكون صفرًا", "Should be zero")} bad={Number(r.wip.gl) !== 0} />
        </div>
      ) : (
        <div className="acct-metrics" data-testid="inv-metrics">
          <Metric k={<Term tech="Inventory cost sub-ledger">{L("سجل تكلفة المخزون", "Inventory cost ledger")}</Term>} v={filtered ? v.shownTotal : v.accounts.reduce((a, x) => a + Number(x.value), 0).toFixed(2)} s={filtered ? L("حسب الفلاتر", "As filtered") : L("الكمية × متوسط التكلفة المرجّح", "Quantity × moving average cost")} testId="inv-subledger" />
        </div>
      )}

      <div className="acct-filters" data-testid="val-filters">
        <div className="acct-seg" role="group" aria-label={L("التجميع", "Group by")}>
          <button type="button" aria-pressed={by === "category"} onClick={() => go({ by: null })} data-testid="val-by-category-btn">{L("حسب التصنيف", "By category")}</button>
          <button type="button" aria-pressed={by === "location"} onClick={() => go({ by: "location" })} data-testid="val-by-location-btn">{L("حسب الموقع", "By location")}</button>
        </div>
        <label className="hr-field"><span className="hr-label">{L("التصنيف", "Category")}</span>
          <Select value={cat} onChange={(e) => go({ cat: e.target.value })} data-testid="val-filter-category">
            <option value="">{L("كل التصنيفات", "All categories")}</option>
            {roots.map((root) => {
              const kids = v.categoryOptions.filter((c) => c.parentId === root.id).sort((a, b) => a.sortOrder - b.sortOrder);
              return [<option key={root.id} value={root.id}>{name(root)}</option>, ...kids.map((k) => <option key={k.id} value={k.id}>{"— "}{name(k)}</option>)];
            })}
          </Select></label>
        <label className="hr-field"><span className="hr-label">{L("الموقع", "Location")}</span>
          <Select value={loc} onChange={(e) => go({ loc: e.target.value })} data-testid="val-filter-location">
            <option value="">{L("كل المواقع (قيمة الشركة)", "All locations (company value)")}</option>
            {v.locations.map((l) => <option key={l.id} value={l.id}>{siteName(l)}</option>)}
          </Select></label>
        {filtered ? <button type="button" className="hr-btn is-ghost" onClick={() => go({ cat: null, loc: null })} data-testid="val-clear">{L("مسح الفلاتر", "Clear filters")}</button> : null}
        <span className="acct-hint hr-num" data-testid="val-count">{L(`${v.count} صنفًا`, `${v.count} items`)}</span>
      </div>

      {loc || by === "location" ? (
        <p className="acct-hint" data-testid="val-estimate-note"><span className="acct-estimate">{L("تقدير", "Estimate")}</span>{" "}
          {L("قيمة الموقع تقديرية: القيمة الدفترية للصنف موزّعة على مواقعه بنسبة كمياتها (أي كمية الموقع × متوسط تكلفة الشركة حين تطابق الكميات السجل). التقييم المحاسبي واحد للشركة؛ التحويل بين المواقع ينقل الكمية بتكلفتها ولا يُنشئ قيدًا. البن المحمص غير المعبأ يُحسب في موقع الإنتاج، واللوط المعبأ في موقعه.",
             "A location's value is an estimate: the item's book value spread over its sites in proportion to their quantities (site qty × the company average when the quantities agree with the ledger). Valuation is one for the company; a transfer moves quantity at cost and posts no entry. Unpacked roasted coffee counts at the production site, a packed lot at its own site.")}</p>
      ) : null}

      {by === "category" ? (
        <section className="acct-card">
          <h2>{L("القيمة حسب التصنيف", "Value by category")} <span className="acct-hint">{loc ? L(`في ${locName(loc)} · تقدير`, `at ${locName(loc)} · estimate`) : L("التصنيف الرئيسي ثم الفرعي · بالتكلفة", "Main then sub-category · at cost")} · <span className="hr-num">{v.asOf}</span></span></h2>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="val-by-category">
              <thead><tr><th>{L("التصنيف", "Category")}</th><th className="acct-hide-m">{L("حساب المخزون", "Inventory account")}</th><th className="num acct-hide-m">{L("الأصناف", "Items")}</th><th className="num">{loc ? L("القيمة التقديرية", "Estimated value") : L("القيمة", "Value")}</th><th className="num acct-hide-m">{L("النسبة", "Share")}</th></tr></thead>
              <tbody>
                {v.categories.map((g) => (
                  <Fragment key={g.id}>
                    <tr className="is-sub" data-cat={g.id}>
                      <td><button type="button" className="acct-linkbtn" onClick={() => go({ cat: g.id === "_none" ? null : g.id })}>{name(g)}</button></td>
                      <td className="acct-hide-m">{g.children.length === 0 && g.direct.role ? accCell(v.accounts.find((a) => a.role === g.direct.role)?.account ?? null, g.direct.role) : ""}</td>
                      <td className="num hr-num acct-hide-m">{g.count}</td><td className="num hr-num" data-testid={`val-cat-${g.id}`}>{money(g.value)}</td><td className="num hr-num acct-hide-m">{pct(g.value, v.shownTotal)}</td>
                    </tr>
                    {g.children.length && g.direct.count ? (
                      <tr className="is-child"><td>{L("مباشرة على التصنيف الرئيسي", "Directly on the main category")}</td><td className="acct-hide-m">{accCell(v.accounts.find((a) => a.role === g.direct.role)?.account ?? null, g.direct.role)}</td><td className="num hr-num acct-hide-m">{g.direct.count}</td><td className="num hr-num">{money(g.direct.value)}</td><td className="num hr-num acct-hide-m">{pct(g.direct.value, v.shownTotal)}</td></tr>
                    ) : null}
                    {g.children.map((c) => (
                      <tr key={c.id} className="is-child" data-cat={c.id}>
                        <td><button type="button" className="acct-linkbtn" onClick={() => go({ cat: c.id })}>{name(c)}</button></td>
                        <td className="acct-hide-m">{accCell(v.accounts.find((a) => a.role === c.role)?.account ?? null, c.role)}</td>
                        <td className="num hr-num acct-hide-m">{c.count}</td><td className="num hr-num" data-testid={`val-cat-${c.id}`}>{money(c.value)}</td><td className="num hr-num acct-hide-m">{pct(c.value, v.shownTotal)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
                {!v.categories.length ? <tr><td colSpan={5} className="acct-hint">{filtered ? L("لا أصناف بقيمة تطابق الفلاتر.", "No valued items match the filters.") : L("لا أصناف بتكلفة بعد.", "No costed items yet.")}</td></tr> : null}
                <tr className="is-total"><td>{L("المجموع", "Total")}</td><td className="acct-hide-m" /><td className="num hr-num acct-hide-m">{v.count}</td><td className="num hr-num" data-testid="val-cat-total">{money(v.shownTotal)}</td><td className="acct-hide-m" /></tr>
              </tbody>
            </table>
          </div>
          <h3>{L("المجموع حسب حساب المخزون", "Subtotal by inventory account")}</h3>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="inv-recon">
              <thead><tr><th>{L("الحساب", "Account")}</th><th className="num">{loc ? L("القيمة التقديرية", "Estimated value") : L("سجل التكلفة", "Cost ledger")}</th>{!showGl ? null : <><th className="num">{L("دفتر الأستاذ", "General ledger")}</th><th className="num acct-hide-m">{L("الفرق", "Difference")}</th><th className="num acct-hide-m">{L("حركات قبل التفعيل", "Not posted (before go-live)")}</th><th className="num acct-hide-m">{L("افتتاحي لم يُرحَّل", "Opening not posted")}</th><th className="acct-hide-m">{L("الحالة", "Status")}</th></>}</tr></thead>
              <tbody>
                {v.accounts.map((a) => {
                  const x = r?.inventory.find((y) => y.role === a.role);
                  return (
                    <tr key={a.role} data-role={a.role}>
                      <td className="acct-acc">{accCell(a.account, a.role)}</td>
                      <td className="num hr-num" data-testid={`val-acc-${a.role}`}>{money(showGl && x ? x.subLedger : a.value)}</td>
                      {!showGl || !x ? null : <><td className={`num hr-num${x.status === "UNEXPLAINED" ? " acct-bad" : ""}`}>{money(x.gl)}</td>
                        <td className={`num hr-num acct-hide-m${Number(x.difference) ? " acct-bad" : ""}`}>{money(x.difference)}</td>
                        <td className="num hr-num acct-hide-m">{money(x.skipped, true)}</td><td className="num hr-num acct-hide-m">{money(x.openingPending, true)}</td>
                        <td className="acct-hide-m">{st(x.status)}</td></>}
                    </tr>
                  );
                })}
                <tr className="is-total"><td>{L("المجموع", "Total")}</td><td className="num hr-num" data-testid="val-acc-total">{money(showGl && r ? r.totals.subLedger : v.shownTotal)}</td>{!showGl || !r ? null : <><td className="num hr-num">{money(r.totals.gl)}</td><td className="num hr-num acct-hide-m">{money(r.totals.difference)}</td><td className="acct-hide-m" /><td className="acct-hide-m" /><td className="acct-hide-m" /></>}</tr>
              </tbody>
            </table>
          </div>
          <p className={`acct-hint ${ties ? "acct-good" : "acct-bad"}`} data-testid="val-tie">
            {ties ? (!r ? L("مجموع التصنيفات = مجموع الحسابات = سجل التكلفة. المطابقة مع دفتر الأستاذ لمن يملك صلاحية المحاسبة.", "Σ categories = Σ accounts = the cost ledger. The match with the general ledger is for accounting.") : filtered ? L("مجموع التصنيفات = مجموع الحسابات. المطابقة مع دفتر الأستاذ تُعرض بلا فلاتر.", "Σ categories = Σ accounts. The match with the general ledger shows without filters.") : L("مجموع التصنيفات = مجموع الحسابات = سجل التكلفة؛ الفرق مع دفتر الأستاذ مفصَّل لكل حساب أعلاه.", "Σ categories = Σ accounts = the cost ledger; the difference with the general ledger is itemised per account above."))
              : L("مجموع التصنيفات لا يساوي مجموع الحسابات — أبلغ الدعم الفني.", "Σ categories does not equal Σ accounts — report it to support.")}
          </p>
          {!showGl || !r ? null : (
            <>
              <div className="acct-cards">
                <div className="acct-card" data-testid="val-grni-card"><h3><Term tech="GRNI">{L("بضاعة مستلمة لم تُرحَّل فاتورتها", "Received, not yet billed in the books")}</Term>{r.grni.account ? <>{" "}<span className="acct-code">{r.grni.account.code}</span></> : null}</h3><p className="hr-num">{L("الاستلامات المفتوحة", "Open receipts")} {money(r.grni.openReceipts)} · {L("دفتر الأستاذ", "General ledger")} {money(r.grni.gl)} · <b className={Number(r.grni.difference) ? "acct-bad" : "acct-good"}>{L("الفرق", "Difference")} {money(r.grni.difference)}</b></p><p className="acct-hint hr-num" data-testid="val-grni-split">{L("بلا فاتورة", "No invoice")} {r.grni.noInvoice.count} · {money(r.grni.noInvoice.value)} — {L("فاتورة بانتظار الاعتماد", "Invoice awaiting approval")} {r.grni.awaitingApproval.count} · {money(r.grni.awaitingApproval.value)}</p></div>
                <div className="acct-card"><h3><Term tech="AP">{L("الذمم الدائنة", "Accounts payable")}</Term>{r.ap.account ? <>{" "}<span className="acct-code">{r.ap.account.code}</span></> : null}</h3><p className="hr-num">{L("فواتير المشتريات المفتوحة", "Open purchase invoices")} {money(r.ap.openItems)} · {L("دفتر الأستاذ", "General ledger")} {money(r.ap.gl)} · <b className={Number(r.ap.difference) ? "acct-bad" : "acct-good"}>{L("الفرق", "Difference")} {money(r.ap.difference)}</b></p></div>
                {r.supplierClaims?.account ? <div className="acct-card" data-testid="val-claims-card"><h3><Term tech="SUPPLIER_CLAIMS">{L("مطالبات الموردين", "Supplier claims")}</Term>{" "}<span className="acct-code">{r.supplierClaims.account.code}</span></h3><p className="hr-num">{L("المطالبات المفتوحة", "Open claims")} {money(r.supplierClaims.openClaims)} · {L("دفتر الأستاذ", "General ledger")} {money(r.supplierClaims.gl)} · <b className={r.supplierClaims.status === "UNEXPLAINED" ? "acct-bad" : "acct-good"}>{L("الفرق", "Difference")} {money(r.supplierClaims.difference)}</b></p>{Number(r.supplierClaims.openingPending) ? <p className="acct-hint hr-num">{L("بانتظار الأرصدة الافتتاحية", "Awaiting the opening balances")} {money(r.supplierClaims.openingPending)}</p> : null}</div> : null}
              </div>
              <p className="acct-hint">{L("الحركات قبل تاريخ البدء أو قبل التفعيل تُحدّث سجل التكلفة ولا تُرحَّل؛ يدخل رصيدها دفتر الأستاذ من خلال المخزون الافتتاحي. الفرق غير المفسَّر يُبحث قبل إقفال الفترة.", "Movements before go-live or activation update the cost ledger without posting; their balance enters the general ledger through the opening inventory. An unexplained difference is investigated before the period is closed.")}</p>
            </>
          )}
        </section>
      ) : (
        <section className="acct-card">
          <h2>{L("القيمة حسب الموقع", "Value by location")} <span className="acct-estimate">{L("تقدير", "Estimate")}</span> <span className="acct-hint">{cat ? L("للتصنيف المختار", "for the chosen category") : L("كل التصنيفات", "all categories")} · <span className="hr-num">{v.asOf}</span></span></h2>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="val-by-location">
              <thead><tr><th>{L("الموقع", "Location")}</th><th className="acct-hide-m">{L("النوع", "Type")}</th><th className="num acct-hide-m">{L("الأصناف", "Items")}</th><th className="num">{L("القيمة التقديرية", "Estimated value")}</th><th className="num acct-hide-m">{L("النسبة", "Share")}</th></tr></thead>
              <tbody>
                {v.locations.map((l) => (
                  <tr key={l.id} data-loc={l.id} className={l.isActive ? undefined : "is-muted"}>
                    <td><button type="button" className="acct-linkbtn" onClick={() => go({ loc: l.id, by: null })}>{siteName(l)}</button>{l.isTransit ? null : <>{" "}<span className="acct-code">{l.code}</span></>}{l.isProduction ? <span className="acct-sub">{L("موقع الإنتاج", "Production site")}</span> : null}{l.isTransit ? <span className="acct-sub">{L("تحويلات على خطوتين لم تُستلم بعد؛ داخلة في قيمة الشركة", "Two-step transfers not yet received; part of the company value")}</span> : null}</td>
                    <td className="acct-hide-m">{l.isTransit ? L("في الطريق", "In transit") : L(LOC_TYPE[l.type]?.[0] ?? l.type, LOC_TYPE[l.type]?.[1] ?? l.type)}</td>
                    <td className="num hr-num acct-hide-m">{l.count}</td><td className="num hr-num" data-testid={`val-loc-${l.code}`}>{money(l.value)}</td><td className="num hr-num acct-hide-m">{pct(l.value, v.locationsTotal)}</td>
                  </tr>
                ))}
                {Number(v.unallocated) ? <tr data-loc="_unallocated"><td><Term tech={L("قيمة أصناف بلا كمية في أي موقع", "Value of items with no quantity at any site")}>{L("غير موزّع على موقع", "Not at any location")}</Term><span className="acct-sub">{L(`${v.unallocatedCount} صنفًا لها قيمة في سجل التكلفة ولا كمية لها في أي موقع`, `${v.unallocatedCount} items valued in the cost ledger with no quantity at any site`)}</span></td><td className="acct-hide-m" /><td className="num hr-num acct-hide-m">{v.unallocatedCount}</td><td className="num hr-num acct-warn" data-testid="val-loc-unallocated">{money(v.unallocated)}</td><td className="num hr-num acct-hide-m">{pct(v.unallocated, v.locationsTotal)}</td></tr> : null}
                <tr className="is-total"><td>{L("قيمة الشركة", "Company value")}</td><td className="acct-hide-m" /><td className="acct-hide-m" /><td className="num hr-num" data-testid="val-loc-total">{money(v.locationsTotal)}</td><td className="acct-hide-m" /></tr>
              </tbody>
            </table>
          </div>
          <p className="acct-hint">{L("مجموع المواقع + غير الموزّع = قيمة الشركة بالتكلفة (سجل التكلفة). الكسور تُقرَّب إلى الهللة ويأخذ أكبر موقع باقي التقريب.", "Σ locations + not at any location = the company value at cost (the cost ledger). Halalas are rounded; the largest site takes the rounding remainder.")}</p>
          {v.qtyDifferences.length ? (
            <div className="acct-banner-note" data-testid="val-qty-diff">
              <b>{L("فرق كمية يُراجع في الجرد", "Quantity difference to check in a count")}</b>{" "}<span className="acct-hint">{L("كمية سجل التكلفة لا تساوي مجموع كميات المواقع؛ القيمة موزّعة على المواقع بنسبة كمياتها، والفرق كمية لا مبلغ.", "The cost-ledger quantity differs from the sites' total; the value is spread over the sites by their quantities — the difference is a quantity, not money.")}</span>
              <ul className="acct-qtydiff">{v.qtyDifferences.map((d) => <li key={d.id}>{d.label}{d.sub ? <>{" "}<bdi className="acct-code">{d.sub}</bdi></> : null}: <span className="hr-num">{L(`السجل ${d.ledgerQty} · المواقع ${Number(d.siteQty)} · الفرق ${Number(d.difference)}`, `ledger ${d.ledgerQty} · sites ${Number(d.siteQty)} · difference ${Number(d.difference)}`)}</span> {L(UNIT[d.unit]?.[0] ?? d.unit, UNIT[d.unit]?.[1] ?? d.unit)}</li>)}</ul>
            </div>
          ) : null}
          {v.uncostedAtSites ? <p className="acct-hint acct-warn" data-testid="val-uncosted-sites">{L(`${v.uncostedAtSites} صنفًا في المواقع بلا تكلفة في سجل التكلفة — مدرجة في الأصناف أدناه بقيمة صفر؛ تُقيَّم من المخزون الافتتاحي أو بفاتورة مشتريات.`, `${v.uncostedAtSites} items at the sites have no cost in the cost ledger — listed below at zero; value them through the opening inventory or a purchase invoice.`)}</p> : null}
        </section>
      )}

      <section className="acct-card">
        <h2>{L("الأصناف", "Items")} <span className="acct-hint">{L("اضغط الصنف لعرض حركات تكلفته ومستنداتها", "Open an item for its cost movements and their documents")}</span></h2>
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="inv-items">
            <thead><tr><th>{L("الصنف", "Item")}</th><th className="acct-hide-m">{L("التصنيف", "Category")}</th><th className="acct-hide-m">{L("الحساب", "Account")}</th><th className="num">{loc ? L("الكمية في الموقع", "Qty at location") : L("الكمية", "Qty")}</th><th className="num acct-hide-m">{L("متوسط التكلفة", "Average cost")}</th><th className="num">{loc ? L("القيمة التقديرية", "Estimated value") : L("القيمة", "Value")}</th></tr></thead>
            <tbody>
              {v.rows.map((x) => (
                <tr key={x.id} className={!x.exists ? "is-muted" : undefined} data-item={x.id}>
                  <td>
                    {x.movementsHref ? <Link href={`${base}?item=${encodeURIComponent(x.id)}`} data-testid={`val-item-${x.id}`} scroll={false}>{x.label}</Link> : <span data-testid={`val-item-${x.id}`}>{x.label}</span>}
                    {x.uncosted ? <span className="acct-warn" data-uncosted="1"> · {x.noLedger ? L("بلا تكلفة · لا رصيد في سجل التكلفة", "uncosted · not in the cost ledger") : L("بلا تكلفة", "uncosted")}</span> : null}{x.drift ? <span className="acct-warn"> · {L("فرق كمية", "qty difference")} <span className="hr-num">{x.drift}</span></span> : null}
                    {x.splitFrom ? <span className="acct-sub" data-testid={`val-split-${x.id}`}>{L("مفصول من اللوط", "Split from lot")} <Link href={x.splitFrom.href}><bdi>{x.splitFrom.label}</bdi></Link></span> : null}
                    <span className="acct-sub">{x.sub ? <><bdi className="acct-code">{x.sub}</bdi> · </> : null}{L(KIND_AR[x.kind]?.[0] ?? x.kind, KIND_AR[x.kind]?.[1] ?? x.kind)}{x.sites.length > 1 && !loc ? ` · ${L(`${x.sites.length} مواقع`, `${x.sites.length} locations`)}` : ""}</span>
                  </td>
                  <td className="acct-hide-m">{lang === "en" ? x.categoryNameEn ?? x.categoryName ?? "—" : x.categoryName ?? "—"}</td>
                  <td className="acct-hide-m">{x.account ? <span className="acct-code">{x.account.code}</span> : <Term tech={x.role}><span className="acct-warn">{role(x.role)}</span></Term>}</td>
                  <td className="num hr-num acct-nowrap">{Number(x.shown.qty).toLocaleString("en-US", { maximumFractionDigits: 3 })} {L(UNIT[x.unit]?.[0] ?? x.unit, UNIT[x.unit]?.[1] ?? x.unit)}</td><td className="num hr-num acct-hide-m">{Number(x.avgCost).toFixed(2)}</td><td className="num hr-num acct-nowrap">{money(x.shown.value)}</td>
                </tr>
              ))}
              {!v.rows.length ? <tr><td colSpan={6} className="acct-hint">{filtered ? L("لا أصناف تطابق الفلاتر.", "No items match the filters.") : L("لا أصناف بتكلفة بعد.", "No costed items yet.")}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function DrillView({ id, back }: { id: string; back: () => void }) {
  const { L, lang } = useLang();
  const canOpen = useCanOpen();
  const [page, setPage] = useState(1);
  const m = useApi<Moves>(`/api/accounting/inventory/movements?item=${encodeURIComponent(id)}&page=${page}`);
  if (m.error) return <><p role="alert" className="hr-err">{m.error}</p><div><button type="button" className="hr-btn" onClick={back}>{L("رجوع إلى التقييم", "Back to the valuation")}</button></div></>;
  if (!m.data) return <OpsLoading />;
  const { holder: h, moves, totals, paging } = m.data;
  const nm = (x: { nameAr: string; nameEn: string | null }) => (lang === "en" ? x.nameEn || x.nameAr : x.nameAr);
  const gl = (s: string) => <span className={`hr-dot tone-${s === "POSTED" ? "success" : s === "SKIPPED" ? "warning" : "neutral"}`} title={s === "SKIPPED" ? L("قبل تاريخ البدء أو قبل تفعيل المحاسبة: يدخل دفتر الأستاذ من خلال الأرصدة الافتتاحية", "Before go-live or activation: enters the general ledger through the opening balances") : s === "NONE" ? L("لا أثر على دفتر الأستاذ (تحويل بين المواقع بالتكلفة نفسها، أو قيمة صفر)", "No effect on the general ledger (a transfer between sites at the same cost, or a zero value)") : undefined}><span>{plain(GL_STATE, s, lang)}</span></span>;
  return (
    <>
      <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }} data-testid="drill-title">{h.label}{h.sub ? <>{" "}<span className="acct-code">{h.sub}</span></> : null}</h2>
          <p className="acct-hint">
            {h.category ? <>{h.category.parent ? `${nm(h.category.parent)} › ` : ""}{nm(h.category)}</> : "—"} · {L(KIND_AR[h.kind]?.[0] ?? h.kind, KIND_AR[h.kind]?.[1] ?? h.kind)}
            {" · "}{h.account ? <><span className="acct-code">{h.account.code}</span> {lang === "en" ? h.account.nameEn : h.account.name}</> : <Term tech={h.role}>{L("الحساب غير محدد في الإعدادات", "No account set in settings")}</Term>}
          </p>
        </div>
        <div className="acct-actions">
          <button type="button" className="hr-btn" onClick={back} data-testid="drill-back">{L("رجوع إلى التقييم", "Back to the valuation")}</button>
          {h.splitFrom && canOpen(h.splitFrom.href) ? <Link className="hr-btn" href={h.splitFrom.href} data-testid="drill-split-from">{L(`اللوط الأصلي ${h.splitFrom.label}`, `Source lot ${h.splitFrom.label}`)}</Link> : null}
          {canOpen(h.itemHref) ? <Link className="hr-btn" href={h.itemHref} data-testid="drill-item-page">{h.kind === "GREEN_BEAN" || h.kind === "FG_LOT" ? L("صفحة اللوط", "Lot page") : L("الصنف في المخزون", "Item in Inventory")}</Link> : null}
        </div>
      </div>
      <div className="acct-metrics">
        <div className="acct-metric"><span className="k">{L("الكمية في سجل التكلفة", "Cost-ledger quantity")}</span><span className="v" data-testid="drill-qty">{h.qty} <small className="acct-hint">{L(UNIT[h.unit]?.[0] ?? h.unit, UNIT[h.unit]?.[1] ?? h.unit)}</small></span>{h.opsQty !== null && h.opsQty !== h.qty ? <span className="s acct-warn">{L(`في المخزون ${h.opsQty}`, `In Inventory ${h.opsQty}`)}</span> : null}</div>
        <div className="acct-metric"><span className="k">{L("متوسط التكلفة المرجّح", "Moving average cost")}</span><span className="v">{Number(h.avgCost).toFixed(4)}</span><span className="s">{L("ر.س لكل وحدة", "SAR per unit")}</span></div>
        <Metric k={L("القيمة", "Value")} v={h.value} testId="drill-value" />
      </div>
      <section className="acct-card">
        <h2>{L("حركات التكلفة", "Cost movements")} <span className="acct-hint hr-num">{paging.count}</span> <span className="acct-hint">{L("الأحدث أولًا", "newest first")}</span></h2>
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="drill-moves">
            <thead><tr><th className="acct-hide-m">{L("التاريخ", "Date")}</th><th>{L("الحركة", "Movement")}</th><th className="acct-hide-m">{L("المستند", "Document")}</th><th className="num">{L("الكمية", "Qty")}</th><th className="num acct-hide-m">{L("تكلفة الوحدة", "Unit cost")}</th><th className="num">{L("القيمة", "Value")}</th><th className="num acct-hide-m">{L("القيمة بعدها", "Value after")}</th><th>{L("القيد", "Entry")}</th></tr></thead>
            <tbody>
              {moves.map((x) => {
                const ev = SOURCE_EVENT[x.eventCode] ?? SOURCE_EVENT[x.eventCode.split(".")[0]] ? plain(SOURCE_EVENT, x.eventCode, lang) : "";
                const doc = <>{plain(SOURCE_DOC, x.docCode ?? x.sourceType, lang)}{x.sourceNumber ? <>{" "}<bdi className="acct-code">{x.sourceNumber}</bdi></> : null}{ev ? <span className="acct-sub">{ev}</span> : null}</>;
                // A packing run that made several lots lists each lot (council F4).
                const lots = x.lots.length ? <span className="acct-sub" data-testid={`drill-lots-${x.id}`}>{L("اللوطات:", "Lots:")} {x.lots.map((l, i) => <Fragment key={l.id}>{i ? " · " : ""}{canOpen(l.href) ? <Link href={l.href}><bdi>{l.label}</bdi></Link> : <bdi>{l.label}</bdi>}</Fragment>)}</span> : null;
                const link = (testId: string | undefined) => <>{x.sourceHref && canOpen(x.sourceHref) ? <Link href={x.sourceHref} data-testid={testId} data-src={x.docCode ?? x.sourceType}>{doc}</Link> : <span data-src={testId ? x.docCode ?? x.sourceType : undefined}>{doc}</span>}{lots}</>;
                return (
                  <tr key={x.id} data-move={x.id}>
                    <td className="hr-num acct-hide-m">{x.day}</td>
                    <td><Term tech={x.kind}>{plain(MOVE_KIND, x.kind, lang)}</Term>{x.reason ? <span className="acct-sub acct-hide-m">{x.reason}</span> : null}
                      <span className="acct-sub acct-show-m"><span className="hr-num">{x.day}</span> · {link(undefined)}</span></td>
                    <td className="acct-hide-m" title={`${x.sourceType} · ${x.sourceEvent}`}>{link(`drill-src-${x.id}`)}</td>
                    <td className="num hr-num acct-nowrap">{x.qty}</td><td className="num hr-num acct-hide-m">{Number(x.unitCost).toFixed(4)}</td>
                    <td className={`num hr-num acct-nowrap${Number(x.value) < 0 ? " acct-bad" : ""}`}>{money(x.value)}</td><td className="num hr-num acct-hide-m">{money(x.valueAfter)}</td>
                    <td>{x.journalHref ? <Link href={x.journalHref} data-testid={`drill-je-${x.id}`}>{L("فتح القيد", "Open entry")}</Link> : gl(x.glState)}</td>
                  </tr>
                );
              })}
              {!moves.length ? <tr><td colSpan={8} className="acct-hint">{L("لا حركات.", "No movements.")}</td></tr> : null}
              <tr className="is-total"><td className="acct-hide-m" /><td>{L("مجموع كل الحركات", "Total, all movements")}</td><td className="acct-hide-m" /><td className="num hr-num">{totals.qty}</td><td className="acct-hide-m" /><td className="num hr-num" data-testid="drill-total">{money(totals.value)}</td><td className="acct-hide-m" /><td /></tr>
            </tbody>
          </table>
        </div>
        {paging.pages > 1 ? (
          <div className="acct-actions" data-testid="drill-paging">
            <button type="button" className="hr-btn is-sm" disabled={paging.page <= 1} onClick={() => setPage(paging.page - 1)}>{L("الأحدث", "Newer")}</button>
            <span className="acct-hint hr-num">{L(`صفحة ${paging.page} من ${paging.pages}`, `Page ${paging.page} of ${paging.pages}`)}</span>
            <button type="button" className="hr-btn is-sm" disabled={paging.page >= paging.pages} onClick={() => setPage(paging.page + 1)} data-testid="drill-older">{L("الأقدم", "Older")}</button>
          </div>
        ) : null}
        <p className={`acct-hint ${totals.ties ? "acct-good" : "acct-bad"}`} data-testid="drill-tie">{totals.ties ? L("مجموع كل الحركات = رصيد الصنف في سجل التكلفة.", "Σ all movements = the item's cost-ledger balance.") : L("مجموع الحركات لا يساوي الرصيد — أبلغ الدعم الفني.", "Σ movements does not equal the balance — report it to support.")}</p>
      </section>
    </>
  );
}

function BatchView({ from, to, go }: { from: string | null; to: string | null; go: (p: Record<string, string | null>) => void }) {
  const { L } = useLang();
  const f = from ?? `${todayRiyadh().slice(0, 7)}-01`;
  const t = to ?? todayRiyadh();
  const b = useApi<Batches>(`/api/accounting/inventory/batches?from=${f}&to=${t}`);
  return (
    <>
      <div className="acct-row">
        <label className="hr-field"><span className="hr-label">{L("من", "From")}</span><input type="date" className="hr-input" value={f} onChange={(e) => e.target.value && go({ from: e.target.value })} /></label>
        <label className="hr-field"><span className="hr-label">{L("إلى", "To")}</span><input type="date" className="hr-input" value={t} onChange={(e) => e.target.value && go({ to: e.target.value })} /></label>
      </div>
      {b.error ? <p role="alert" className="hr-err">{b.error}</p> : !b.data ? <OpsLoading /> : (
        <>
          <div className="acct-metrics">
            <Metric k={L("تكلفة البن الأخضر", "Green cost")} v={b.data.totals.greenCost} s={L(`${b.data.totals.greenKg} كغ أخضر`, `${b.data.totals.greenKg} kg green`)} />
            <Metric k={L("تكلفة المحمص", "Roasted cost")} v={b.data.totals.roastedCost} s={L(`${b.data.totals.roastedKg} كغ محمص`, `${b.data.totals.roastedKg} kg roasted`)} />
            <Metric k={L("فاقد غير طبيعي", "Abnormal loss")} v={b.data.totals.abnormalCost} s={L(`متوسط الفاقد ${b.data.totals.lossPct ?? "—"}%`, `Average loss ${b.data.totals.lossPct ?? "—"}%`)} />
            <div className="acct-metric"><span className="k">{L("تكلفة الكيلو المحمص", "Cost per roasted kg")}</span><span className="v" data-testid="roast-unit-cost">{b.data.totals.roastedUnitCost ? Number(b.data.totals.roastedUnitCost).toFixed(2) : "—"}</span><span className="s">{L("الفاقد الطبيعي محمَّل على التكلفة", "Normal loss absorbed")}</span></div>
          </div>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="batch-costs">
              <thead><tr><th>{L("الدفعة", "Roast")}</th><th className="acct-hide-m">{L("المنتج", "Product")}</th><th className="num">{L("أخضر كغ", "Green kg")}</th><th className="num">{L("محمص كغ", "Roasted kg")}</th><th className="num">{L("الفاقد", "Loss")}</th><th className="num">{L("تكلفة الأخضر", "Green cost")}</th><th className="num acct-hide-m">{L("فاقد غير طبيعي", "Abnormal")}</th><th className="num">{L("تكلفة الكيلو المحمص", "Cost / roasted kg")}</th></tr></thead>
              <tbody>
                {b.data.rows.map((x) => (
                  <tr key={x.id}>
                    <td><span className="acct-code">{x.batchNumber}</span> <span className="acct-hint hr-num">{x.date}</span>{x.journalEntryId ? <> · <Link href={`/dashboard/accounting/journals/${x.journalEntryId}`}>{L("القيد", "Entry")}</Link></> : null}</td>
                    <td className="acct-hide-m">{x.product ?? "—"}</td>
                    <td className="num hr-num">{x.greenKg}</td><td className="num hr-num">{x.roastedKg}</td><td className="num hr-num">{x.lossPct ? `${x.lossPct}%` : "—"}</td>
                    <td className="num hr-num">{x.greenCost ? money(x.greenCost) : <span className="acct-hint">{L("بلا تكلفة", "uncosted")}</span>}</td>
                    <td className="num hr-num acct-hide-m">{x.abnormalCost && Number(x.abnormalCost) ? <span className="acct-bad">{money(x.abnormalCost)}</span> : "—"}</td>
                    <td className="num hr-num">{x.roastedUnitCost ? Number(x.roastedUnitCost).toFixed(2) : "—"}</td>
                  </tr>
                ))}
                {!b.data.rows.length ? <tr><td colSpan={8} className="acct-hint">{L("لا دفعات في هذه الفترة.", "No roasts in this range.")}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <p className="acct-hint">{L("تكلفة الكيلو المحمص = (تكلفة الأخضر − الفاقد غير الطبيعي) ÷ الكيلوات المحمصة. الفاقد فوق الحد الذي يحدده المالك يُحمَّل على مصروف فاقد التحميص.", "Cost per roasted kg = (green cost − abnormal loss) ÷ roasted kg. Loss above the owner's threshold is expensed to abnormal roast loss.")}</p>
        </>
      )}
    </>
  );
}

function GrniView() {
  const { L } = useLang();
  const canOpen = useCanOpen();
  const r = useApi<Receipt[]>("/api/accounting/ap/receipts");
  if (r.error) return <p role="alert" className="hr-err">{r.error}</p>;
  if (!r.data) return <OpsLoading />;
  const total = r.data.reduce((s, x) => s + Number(x.value), 0);
  const none = r.data.filter((x) => !x.invoice), waiting = r.data.filter((x) => !!x.invoice);
  const sum = (xs: Receipt[]) => xs.reduce((s, x) => s + Number(x.value), 0);
  return (
    <section className="acct-card">
      <h2><Term tech="GRNI — goods received not invoiced">{L("بضاعة مستلمة لم تُرحَّل فاتورتها", "Received, not yet billed in the books")}</Term> <span className="acct-hint hr-num">{r.data.length} · {money(total)} {L("ر.س", "SAR")}</span></h2>
      <div className="acct-metrics" data-testid="grni-split">
        <div className="acct-metric"><span className="k">{L("بلا فاتورة", "No invoice")}</span><span className="v">{money(sum(none))}</span><span className="s">{L(`${none.length} استلامًا — تحتاج فاتورة مشتريات`, `${none.length} receipts — need a purchase invoice`)}</span></div>
        <div className="acct-metric"><span className="k">{L("فاتورة بانتظار الاعتماد", "Invoice awaiting approval")}</span><span className="v">{money(sum(waiting))}</span><span className="s">{L(`${waiting.length} استلامًا — فاتورتها مسودة أو مقدّمة ولم تُرحَّل`, `${waiting.length} receipts — the invoice is a draft or submitted, not posted`)}</span></div>
      </div>
      <div className="hr-tablewrap">
        <table className="hr-table is-dense" data-testid="grni-table">
          <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("المورد", "Supplier")}</th><th className="acct-hide-m">{L("النوع", "Type")}</th><th className="num">{L("القيمة", "Value")}</th><th>{L("الفاتورة", "Invoice")}</th><th className="acct-hide-m">{L("دفتر الأستاذ", "General ledger")}</th></tr></thead>
          <tbody>
            {r.data.map((x) => (
              <tr key={x.purchaseRecordId} data-invoice={x.invoice ? "awaiting" : "none"}>
                <td className="hr-num">{x.date}</td><td>{x.supplierName}</td><td className="acct-hide-m">{x.type === "GREEN_BEAN" ? L("بن أخضر", "Green coffee") : L("مواد", "Materials")}</td>
                <td className="num hr-num acct-nowrap">{money(x.value)}</td>
                <td>{x.invoice ? <>{canOpen(`/dashboard/purchases/invoices/${x.invoice.id}`) ? <Link className="acct-code" href={`/dashboard/purchases/invoices/${x.invoice.id}`}>{x.invoice.number}</Link> : <span className="acct-code">{x.invoice.number}</span>}<span className="acct-sub">{x.invoice.status === "DRAFT" ? L("مسودة لم تُقدَّم", "Draft, not submitted") : L("فاتورة بانتظار الاعتماد", "Invoice awaiting approval")}</span></> : <span className="hr-dot tone-warning"><span>{L("بلا فاتورة", "No invoice")}</span></span>}</td>
                <td className="acct-hide-m">{x.glState === "POSTED" ? <span className="hr-dot tone-success"><span>{L("الاستلام مرحّل", "Receipt posted")}</span></span> : <span className="hr-dot tone-neutral"><span>{L("قبل التفعيل", "Before go-live")}</span></span>}</td>
              </tr>
            ))}
            {!r.data.length ? <tr><td colSpan={6} className="acct-hint">{L("كل الاستلامات رُحّلت فواتيرها.", "Every receipt's invoice is posted.")}</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="acct-hint">{L("بضاعة دخلت المخزون وفاتورتها لم تُرحَّل بعد: إما لا فاتورة لها (تظهر في «المشتريات › الاستلامات» بحالة «لم تُفوتر بعد»)، أو فاتورتها مسودة أو بانتظار الاعتماد. عند ترحيل الفاتورة يُقفل الاستلام؛ الفرق بين قيمة الاستلام والفاتورة فرق سعر يُحمَّل على المخزون ما دام في المخزن.", "Goods in stock whose invoice is not posted yet: either no invoice (shown as «Not invoiced yet» under «Purchases › Receipts»), or the invoice is a draft or awaiting approval. Posting the invoice closes the receipt; the difference between the receipt and the invoice is a price difference added to the stock while it is on hand.")}</p>
    </section>
  );
}

function OpeningView({ role, canEdit }: { role: (r: string) => string; canEdit: boolean }) {
  const { L } = useLang();
  const op = useApi<Opening>("/api/accounting/inventory/opening");
  const w = useWrite();
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  if (op.error) return <p role="alert" className="hr-err">{op.error}</p>;
  if (!op.data) return <OpsLoading />;
  const o = op.data;
  const locked = o.openingPosted || !canEdit;
  async function save() {
    const list = Object.entries(costs).map(([k, v]) => { const [kind, entityId] = k.split("|"); return { kind, entityId, unitCost: v.trim() === "" ? null : v.trim() }; });
    if (await w.run("save", "/api/accounting/inventory/opening", "PUT", { costs: list }, L("حُفظت التكاليف.", "Costs saved."))) { setCosts({}); op.reload(); }
  }
  async function apply() {
    if (await w.run("apply", "/api/accounting/inventory/opening/apply", "POST", {}, L("طُبّق التقييم على سجل التكلفة وجدول الأرصدة الافتتاحية.", "Applied to the cost ledger and the opening grid."))) { setConfirm(false); op.reload(); }
  }
  return (
    <>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <div className="acct-metrics">
        <Metric k={L("قيمة المخزون الافتتاحي", "Opening inventory value")} v={o.total} s={L(`${o.rows.length} صنفًا على الرف`, `${o.rows.length} items on hand`)} testId="opening-inv-total" />
        {o.byRole.filter((b) => Number(b.value)).map((b) => <Metric key={b.role} k={role(b.role)} v={b.value} s={L(`${b.count} صنفًا`, `${b.count} items`)} />)}
        <div className="acct-metric"><span className="k">{L("بلا تكلفة", "Without a cost")}</span><span className={`v${o.missing ? " is-bad" : ""}`}>{o.missing}</span><span className="s">{L("أدخل تكلفتها قبل التطبيق", "Enter their cost before applying")}</span></div>
      </div>
      <p className="acct-hint">
        {L("الكمية الموجودة الآن × تكلفة يدخلها المالك، وإلا آخر تكلفة معروفة (المتوسط، آخر استلام، آخر شراء). التطبيق يضبط سجل التكلفة ويضيف سطر مخزون لكل حساب في جدول الأرصدة الافتتاحية (وسطر «بضاعة مستلمة لم تُرحَّل فاتورتها» لكل مورد) — دون ترحيل أي حركة سابقة. يُعاد التطبيق حتى تُرحَّل الأرصدة الافتتاحية.", "On hand now × the owner's cost, else the last known cost (moving average, last receipt, last purchase). Applying sets the cost ledger and adds one inventory line per account to the opening grid (and a received-not-yet-billed line per supplier) — no past movement is posted. Repeatable until the opening is posted.")}
        {" "}{L("تاريخ البدء", "Go-live")}: <span className="hr-num">{o.goLiveDate ?? "—"}</span>{o.appliedAt ? <> · {L("آخر تطبيق", "Last applied")} <span className="hr-num">{o.appliedAt.slice(0, 16).replace("T", " ")}</span></> : null}
        {o.grni.count ? <> · {L("بضاعة مستلمة لم تُرحَّل فاتورتها قبل التفعيل", "Received, not yet billed in the books, before go-live")} {o.grni.count} ({money(o.grni.value)})</> : null}
        {o.supplierClaims?.count ? <span data-testid="opening-claims"> · {L("مطالبات موردين مفتوحة قبل التفعيل (مدين مطالبات الموردين لكل مورد)", "Open supplier claims before go-live (Dr supplier claims per supplier)")} {money(o.supplierClaims.value)}</span> : null}
      </p>
      {o.apOpening?.length ? (
        <div className="hr-tablewrap"><table className="hr-table is-dense" data-testid="opening-ap-check" aria-label={L("الذمم الدائنة الافتتاحية لكل مورد", "Opening AP per supplier")}>
          <thead><tr><th>{L("المورد", "Supplier")}</th><th className="num">{L("المتوقع (الإجمالي − المدفوع − الإشعارات)", "Expected (gross − paid − credited)")}</th><th className="num">{L("في الجدول", "In the grid")}</th><th className="num">{L("الفرق", "Difference")}</th></tr></thead>
          <tbody>{o.apOpening.map((a) => <tr key={a.supplierId}><td>{a.name}</td><td className="num hr-num">{money(a.expected)}</td><td className="num hr-num">{money(a.grid)}</td><td className={`num hr-num${Number(a.difference) ? " acct-bad" : ""}`}>{money(a.difference)}</td></tr>)}</tbody>
        </table><p className="acct-hint">{L("فواتير مشتريات اعتُمدت قبل التفعيل بلا قيد: رصيدها الافتتاحي لكل مورد يُدخَل في جدول الأرصدة الافتتاحية بالإجمالي ناقص المدفوع والإشعارات الدائنة.", "Purchase invoices approved before activation, with no entry: each supplier's opening AP is entered in the opening grid at gross less what was paid and credited.")}</p></div>
      ) : null}
      <div className="hr-tablewrap">
        <table className="hr-table is-dense acct-lines" data-testid="opening-inv-table">
          <thead><tr><th>{L("الصنف", "Item")}</th><th className="acct-hide-m">{L("الحساب", "Account")}</th><th className="num">{L("الكمية", "Qty")}</th><th className="num">{L("تكلفة الوحدة", "Unit cost")}</th><th className="acct-hide-m">{L("المصدر", "Source")}</th><th className="num">{L("القيمة", "Value")}</th></tr></thead>
          <tbody>
            {o.rows.map((x) => {
              const k = `${x.kind}|${x.entityId}`;
              return (
                <tr key={k}>
                  <td>{x.label}{x.sub ? <>{" "}<span className="acct-code">{x.sub}</span></> : null}</td>
                  <td className="acct-hide-m">{role(x.role)}</td>
                  <td className="num hr-num">{x.qty} {x.unit}</td>
                  <td className="num">{locked ? <span className="hr-num">{x.unitCost ? Number(x.unitCost).toFixed(4) : "—"}</span> : <input className="hr-input acct-amount" inputMode="decimal" style={{ width: 110 }} value={costs[k] ?? (x.source === "OWNER" ? x.unitCost ?? "" : "")} placeholder={x.unitCost ? Number(x.unitCost).toFixed(4) : L("أدخل", "Enter")} onChange={(e) => setCosts({ ...costs, [k]: e.target.value })} aria-label={L("تكلفة الوحدة", "Unit cost")} />}</td>
                  <td className="acct-hide-m">{x.source === "NONE" ? <span className="acct-warn">{L(SOURCE_AR.NONE[0], SOURCE_AR.NONE[1])}</span> : L(SOURCE_AR[x.source]?.[0] ?? x.source, SOURCE_AR[x.source]?.[1] ?? x.source)}</td>
                  <td className="num hr-num">{money(x.value)}</td>
                </tr>
              );
            })}
            {!o.rows.length ? <tr><td colSpan={6} className="acct-hint">{L("لا مخزون على الرف.", "Nothing on hand.")}</td></tr> : null}
          </tbody>
        </table>
      </div>
      {locked ? (o.openingPosted ? <p className="acct-hint">{L("رُحّلت الأرصدة الافتتاحية؛ التقييم الافتتاحي نهائي.", "The opening balances are posted; the opening valuation is final.")}</p> : null) : (
        <div className="acct-actions">
          <Btn onClick={save} busy={w.busy === "save"} disabled={!Object.keys(costs).length} data-testid="opening-inv-save">{L("حفظ التكاليف", "Save costs")}</Btn>
          <Btn variant="primary" onClick={() => setConfirm(true)} data-testid="opening-inv-apply">{L("تطبيق على الأرصدة الافتتاحية", "Apply to the opening balances")}</Btn>
          <Link className="hr-btn is-ghost" href="/dashboard/accounting/opening">{L("فتح جدول الأرصدة الافتتاحية", "Open the opening grid")}</Link>
        </div>
      )}
      <Dialog open={confirm} title={L("تطبيق المخزون الافتتاحي", "Apply the opening inventory")} onClose={() => setConfirm(false)}
        actions={<><Btn onClick={() => setConfirm(false)}>{L("إلغاء", "Cancel")}</Btn><Btn variant="primary" busy={w.busy === "apply"} onClick={apply} data-testid="opening-inv-confirm">{L("تطبيق", "Apply")}</Btn></>}>
        <p>{L(`يضبط سجل التكلفة على ${money(o.total)} ر.س، ويستبدل أسطر المخزون في جدول الأرصدة الافتتاحية. أسطر الجدول الأخرى تبقى كما هي.`, `Sets the cost ledger to SAR ${money(o.total)} and replaces the inventory lines of the opening grid. The other lines stay as they are.`)}</p>
        {o.missing ? <p className="acct-warn">{L(`${o.missing} صنفًا بلا تكلفة سيُقيَّم بصفر.`, `${o.missing} items without a cost will be valued at zero.`)}</p> : null}
      </Dialog>
    </>
  );
}

function PolicyView({ canEdit }: { canEdit: boolean }) {
  const { L } = useLang();
  const pol = useApi<Policy>("/api/accounting/inventory/settings");
  const al = useApi<Align>("/api/accounting/payroll-alignment");
  const w = useWrite();
  const [pct, setPct] = useState<string | null>(null);
  const [useProduct, setUseProduct] = useState<boolean | null>(null);
  const status = (s: string) => s === "ALIGNED" ? <span className="hr-dot tone-success"><span>{L("مطابق", "Aligned")}</span></span> : s === "NO_ROLE" ? <span className="hr-dot tone-neutral"><span>{L("يحدده المحاسب", "Accountant's choice")}</span></span> : s === "MISALIGNED" ? <span className="hr-dot tone-danger"><span>{L("حساب مختلف", "Different account")}</span></span> : <span className="hr-dot tone-warning"><span>{s === "HR_UNMAPPED" ? L("غير مربوط في الموارد البشرية", "Not mapped in HR") : L("الحساب غير محدد في الإعدادات", "No account set in settings")}</span></span>;
  return (
    <>
      <Msg error={w.error ?? pol.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <section className="acct-card">
        <h2>{L("فاقد التحميص", "Roast loss")}</h2>
        <p className="acct-hint">{L("الفاقد الطبيعي (فقد الوزن بالتحميص) يُحمَّل على تكلفة البن المحمص. الفاقد فوق هذه النسبة من وزن الأخضر غير طبيعي ويُحمَّل على مصروف «فاقد التحميص غير الطبيعي». فارغ = كل الفاقد طبيعي.", "Normal loss (moisture and chaff) is absorbed into roasted cost. Loss above this share of the green weight is abnormal and expensed to «abnormal roast loss». Empty = every loss is normal.")}</p>
        {!pol.data ? <OpsLoading rows={2} /> : (
          <div className="acct-row">
            <label className="hr-field"><span className="hr-label">{L("حد الفاقد الطبيعي %", "Normal loss limit %")}</span>
              <input className="hr-input acct-amount" inputMode="decimal" disabled={!canEdit} value={pct ?? pol.data.abnormalRoastLossPct ?? ""} placeholder={L("كل الفاقد طبيعي", "All loss normal")} onChange={(e) => setPct(e.target.value)} data-testid="loss-threshold" /></label>
            <label className="hr-field"><span className="hr-label"><input type="checkbox" disabled={!canEdit} checked={useProduct ?? pol.data.abnormalUseProductLimit} onChange={(e) => setUseProduct(e.target.checked)} data-testid="loss-use-product" /> {L("حد كل منتج: الفاقد المتوقع + 5 نقاط (حد المحطة «فوق الحد»)", "Per product: expected loss + 5 points (the station's «above» boundary)")}</span></label>
            {canEdit ? <Btn variant="primary" busy={w.busy === "pct"} disabled={pct === null && useProduct === null} onClick={async () => { if (await w.run("pct", "/api/accounting/inventory/settings", "PUT", { abnormalRoastLossPct: (pct ?? pol.data!.abnormalRoastLossPct ?? "") === "" ? null : pct ?? pol.data!.abnormalRoastLossPct, abnormalUseProductLimit: useProduct ?? pol.data!.abnormalUseProductLimit }, L("حُفظت السياسة.", "Policy saved."))) { setPct(null); setUseProduct(null); pol.reload(); } }}>{L("حفظ", "Save")}</Btn> : null}
          </div>
        )}
      </section>
      <section className="acct-card">
        <h2>{L("الرواتب في الدفتر", "Payroll in the ledger")} {al.data ? (al.data.aligned ? <span className="hr-dot tone-success"><span>{L("مطابقة", "Aligned")}</span></span> : <span className="hr-dot tone-warning"><span>{L("تحتاج مراجعة", "Needs review")}</span></span>) : null}</h2>
        <p className="acct-hint">{L("قيود الرواتب تُرحّلها الموارد البشرية بضوابطها (قفل الرواتب، موافقة شخصين). المطلوب أن يكون حساب كل بند في الموارد البشرية هو الحساب نفسه المحدد له في إعدادات المحاسبة؛ يُغيَّر من إعدادات الموارد البشرية لا من هنا.", "Payroll journals are posted by HR under its own controls (the payroll lock, two-person approvals). Each HR item must use the same account as accounting settings give it; a change is made in HR's account map, not here.")}</p>
        {al.error ? <p role="alert" className="hr-err">{al.error}</p> : !al.data ? <OpsLoading rows={4} /> : (
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="payroll-align">
              <thead><tr><th>{L("البند", "Item")}</th><th>{L("الحساب في الموارد البشرية", "Account in HR")}</th><th>{L("الحساب في إعدادات المحاسبة", "Account in accounting settings")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
              <tbody>
                {al.data.rows.map((x) => (
                  <tr key={x.key} data-key={x.key}><td><Term tech={x.role ? `${x.key} · ${x.role}` : x.key}>{L(x.why, x.whyEn ?? x.key)}</Term></td><td>{x.hrAccount ? <><span className="acct-code">{x.hrAccount.code}</span> {x.hrAccount.name}</> : "—"}</td><td>{x.roleAccount ? <><span className="acct-code">{x.roleAccount.code}</span> {x.roleAccount.name}</> : "—"}</td><td>{status(x.status)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
