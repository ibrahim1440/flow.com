"use client";
// Stock locations («مواقع المخزون») — unified inventory phase 3 (migration 20261115090000_stock_locations), linked from the
// inventory page header. WHERE stock is: the roasting plant, the warehouse, the café, later more branches. The owner adds,
// renames, reorders, makes one the default receiving site or the production site (each after a confirmation that says what
// it changes), deactivates a site that closes (refused while it holds stock: «انقل الرصيد أولًا», with the prefilled
// transfer; and for the default / production site) and reactivates it. A site that was never used can be deleted; one with
// history is kept (deactivated). Writes: inventory › adjust; every change is in the person audit. A viewer who holds the
// accounting module also sees «القيمة حسب الموقع» — an estimate (site quantity × company moving-average cost).
import { localizeApiError } from "@/lib/i18n/api-errors";
import { formatMoney } from "@/lib/format/money";
import { useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Btn, Field, Notice, OpsBanner, OpsError, OpsLoading, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import "@/components/ops/stock.css";
import { useUser } from "../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { LOCATION_TYPES, LOCATION_TYPE_LABEL, locationName, suggestLocationCode, type LocationType } from "@/lib/inventory/locations";
import { useLocations, type Loc } from "../_parts/locations";

type Refusal = { msg: string; href?: string | null };

export default function LocationsPage() {
  const user = useUser();
  const { lang } = useI18n();
  const L = useL();
  const canWrite = !!user && hasSubPrivilege(user.permissions, "inventory", "adjust");
  const { state, failed, reload } = useLocations(true);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Loc | "new" | null>(null);
  const [closing, setClosing] = useState<Loc | null>(null);
  const [making, setMaking] = useState<{ loc: Loc; role: "default" | "production" } | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: "success" | "danger"; href?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const pair = (k: string) => (LOCATION_TYPE_LABEL[k as LocationType] ? LOCATION_TYPE_LABEL[k as LocationType][lang === "ar" ? 0 : 1] : k);
  const all = state?.locations ?? [];
  const active = all.filter((l) => l.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
  const rows = showInactive ? [...active, ...all.filter((l) => !l.isActive)] : active;
  const withValue = all.some((l) => typeof l.valueEstimate === "number");
  const cols = withValue ? 6 : 5;
  const value = (l: Loc) => (typeof l.valueEstimate === "number" ? <span className="hr-num">{L(`${formatMoney(l.valueEstimate.toFixed(2))} ر.س`, `SAR ${formatMoney(l.valueEstimate.toFixed(2))}`)}</span> : null);

  async function call(url: string, method: string, body?: unknown): Promise<{ ok: true } | { ok: false; refusal: Refusal }> {
    setBusy(true);
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    setBusy(false);
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => ({}));
    return { ok: false, refusal: { msg: localizeApiError(j, lang) ?? L("تعذّر الحفظ.", "Could not save."), href: j?.location?.transferHref ?? null } };
  }
  async function act(l: Loc, body: Record<string, unknown>, done: string) {
    const r = await call(`/api/inventory/locations/${l.id}`, "PATCH", body);
    if (r.ok) { setToast({ msg: done, tone: "success" }); reload(); } else setToast({ msg: r.refusal.msg, tone: "danger", href: r.refusal.href });
  }
  async function move(l: Loc, dir: -1 | 1) {
    const ids = active.map((x) => x.id);
    const i = ids.indexOf(l.id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await call("/api/inventory/locations/reorder", "POST", { ids });
    if (r.ok) reload(); else setToast({ msg: r.refusal.msg, tone: "danger" });
  }
  async function remove(l: Loc) {
    const r = await call(`/api/inventory/locations/${l.id}`, "DELETE");
    if (r.ok) { setToast({ msg: L("حُذف الموقع.", "Location deleted."), tone: "success" }); reload(); } else setToast({ msg: r.refusal.msg, tone: "danger" });
  }

  const holds = (l: Loc) => {
    const h = l.holdings;
    if (!h || !h.any) return <span className="hr-caption">{L("لا رصيد", "No stock")}</span>;
    const parts = [
      h.green ? L(`${h.green} لوت بن أخضر`, `${h.green} green lot${h.green === 1 ? "" : "s"}`) : null,
      h.materials ? L(`${h.materials} مادة`, `${h.materials} material${h.materials === 1 ? "" : "s"}`) : null,
      h.finished ? L(`${h.finished} دفعة جاهزة`, `${h.finished} finished lot${h.finished === 1 ? "" : "s"}`) : null,
    ].filter(Boolean);
    return <span>{parts.join(" · ")}</span>;
  };

  return (
    <OpsRoot className="stk-inventory">
      <div className="hr-page">
        <PageHeader
          title={L("مواقع المخزون", "Stock locations")}
          actions={<>
            <Link className="hr-btn is-ghost" href="/dashboard/inventory">{L("العودة إلى المخزون", "Back to inventory")}</Link>
            <Link className="hr-btn is-ghost" href="/dashboard/inventory/transfers" data-testid="locations-transfers-link">{L("تحويلات المخزون", "Stock transfers")}</Link>
            {canWrite ? <Btn variant="primary" onClick={() => setEditing("new")} data-testid="loc-add">{L("+ موقع جديد", "+ New location")}</Btn> : null}
          </>}
        >
          <span className="hr-caption">{L("الموقع يحدّد مكان المخزون (المصنع، المستودع، المقهى، الفروع)، والتصنيف يحدّد نوعه. التقييم والتكلفة للشركة كلها، لا لكل موقع.", "A location says where stock is (the plant, the warehouse, the café, the branches); a category says what it is. Valuation and cost are company-wide, not per location.")}</span>
        </PageHeader>

        {toast ? (
          <OpsBanner tone={toast.tone} onClose={() => setToast(null)}>
            <span data-testid="loc-toast">{toast.msg}</span>
            {toast.href ? <> <Link className="ops-link" href={toast.href} data-testid="loc-toast-transfer">{L("انقل الرصيد الآن", "Move the stock now")}</Link></> : null}
          </OpsBanner>
        ) : null}
        {!canWrite ? <Notice tone="info">{L("تستطيع استعراض المواقع فقط؛ إضافتها وتعديلها لمن يملك صلاحية تسوية المخزون.", "You can view the locations only; adding and changing them needs the inventory adjust permission.")}</Notice> : null}

        <div className="stk-tool">
          <Btn size="sm" className="stk-toggle" aria-pressed={showInactive} onClick={() => setShowInactive((v) => !v)} data-testid="loc-show-inactive">{L("إظهار الموقوفة", "Show inactive")}</Btn>
        </div>

        {failed ? <OpsError message={L("تعذّر تحميل المواقع.", "Could not load the locations.")} onRetry={reload} /> : !state ? <OpsLoading /> : (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow" aria-label={L("مواقع المخزون", "Stock locations")} data-testid="locations-table">
              <thead>
                <tr>
                  <th>{L("الموقع", "Location")}</th>
                  <th className="hr-hide-mobile">{L("النوع", "Type")}</th>
                  <th className="hr-hide-mobile">{L("الرصيد فيه", "Holds")}</th>
                  {withValue ? <th className="hr-hide-mobile" title={L("تقدير: كمية الموقع × متوسط التكلفة للشركة. التقييم للشركة كلها، لا لكل موقع.", "An estimate: the site's quantity × the company moving-average cost. Valuation is company-wide, not per site.")}>{L("القيمة حسب الموقع (تقديرية)", "Value by site (estimate)")}</th> : null}
                  <th className="hr-hide-mobile">{L("الحالة", "Status")}</th>
                  <th aria-label={L("الإجراءات", "Actions")} />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const idx = active.indexOf(l);
                  return (
                    <tr key={l.id} className={l.isActive ? undefined : "is-inactive"} data-testid={`locrow-${l.code}`}>
                      <td className="m-title">
                        <span className="strong">{lang === "ar" ? l.nameAr : l.nameEn || l.nameAr}</span>{" "}
                        <span className="hr-id hr-caption">{l.code}</span>
                        {lang === "ar" && l.nameEn ? <span className="stk-sub" dir="ltr">{l.nameEn}</span> : null}
                        {l.isDefault || l.isProduction || !l.isActive ? <span className="loc-badges">
                          {l.isDefault ? <span className="stk-flag tone-success" data-testid={`loc-default-${l.code}`}>{L("موقع الاستلام الافتراضي", "Default receiving site")}</span> : null}
                          {l.isProduction ? <span className="stk-flag tone-info" data-testid={`loc-production-${l.code}`}>{L("موقع الإنتاج", "Production site")}</span> : null}
                          {!l.isActive ? <span className="stk-flag tone-warning">{L("موقوف", "Inactive")}</span> : null}
                        </span> : null}
                        <span className="hr-msub">{pair(l.type)} · {holds(l)}</span>
                        {withValue ? <span className="hr-msub">{L("القيمة التقديرية: ", "Estimated value: ")}{value(l)}</span> : null}
                        {!l.isActive && l.deactivationReason ? <span className="hr-msub">{L("سبب الإيقاف: ", "Deactivated: ")}{l.deactivationReason}</span> : null}
                      </td>
                      <td className="hr-hide-mobile">{pair(l.type)}{l.address ? <span className="stk-sub">{l.address}</span> : null}</td>
                      <td className="hr-hide-mobile">{holds(l)}</td>
                      {withValue ? <td className="hr-hide-mobile" data-testid={`loc-value-${l.code}`}>{value(l)}</td> : null}
                      <td className="hr-hide-mobile">{l.isActive ? L("نشط", "Active") : L("موقوف", "Inactive")}</td>
                      <td className="stk-acts stk-macts">
                        {canWrite ? (l.isActive ? (
                          <>
                            <Btn size="sm" variant="ghost" aria-label={L("تحريك لأعلى", "Move up")} title={L("تحريك لأعلى", "Move up")} disabled={busy || idx <= 0} onClick={() => move(l, -1)}><ArrowUp size={14} /></Btn>
                            <Btn size="sm" variant="ghost" aria-label={L("تحريك لأسفل", "Move down")} title={L("تحريك لأسفل", "Move down")} disabled={busy || idx === active.length - 1} onClick={() => move(l, 1)}><ArrowDown size={14} /></Btn>
                            <Btn size="sm" onClick={() => setEditing(l)} data-testid={`loc-edit-${l.code}`}>{L("تعديل", "Edit")}</Btn>
                            {!l.isDefault ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => setMaking({ loc: l, role: "default" })} data-testid={`loc-makedefault-${l.code}`}>{L("اجعله الافتراضي", "Make default")}</Btn> : null}
                            {!l.isProduction ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => setMaking({ loc: l, role: "production" })} data-testid={`loc-makeproduction-${l.code}`}>{L("اجعله موقع الإنتاج", "Make production site")}</Btn> : null}
                            <Btn size="sm" variant="ghost" disabled={busy} onClick={() => setClosing(l)} data-testid={`loc-deactivate-${l.code}`}>{L("إيقاف", "Deactivate")}</Btn>
                            {!l.hasHistory && !l.isDefault && !l.isProduction && !l.holdings?.any ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => remove(l)} data-testid={`loc-delete-${l.code}`}>{L("حذف", "Delete")}</Btn> : null}
                          </>
                        ) : (
                          <Btn size="sm" disabled={busy} onClick={() => act(l, { action: "reactivate" }, L("أُعيد تفعيل الموقع.", "Location reactivated."))} data-testid={`loc-reactivate-${l.code}`}>{L("إعادة التفعيل", "Reactivate")}</Btn>
                        )) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={cols}>{L(`${active.length} موقع نشط`, `${active.length} active location${active.length === 1 ? "" : "s"}`)} · {L("يسحب التحميص والتعبئة والتسليم من موقع الإنتاج، وتُسجَّل فيه أي تسوية بلا موقع. الاستلام يذهب إلى موقع الاستلام الافتراضي ما لم يُختر غيره.", "Roasting, packing and dispatch draw at the production site, and an adjustment with no site named is booked there. Receipts go to the default receiving site unless another is chosen.")}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {editing ? (
          <LocationDialog loc={editing === "new" ? null : editing} taken={new Set(all.map((l) => l.code))} onClose={() => setEditing(null)}
            onSaved={(msg) => { setEditing(null); setToast({ msg, tone: "success" }); reload(); }} />
        ) : null}
        {making ? (
          <SiteRoleDialog loc={making.loc} role={making.role} busy={busy} onClose={() => setMaking(null)}
            onConfirm={async () => {
              const { loc, role } = making;
              setMaking(null);
              await act(loc, { action: role }, role === "default"
                ? L(`أصبح «${loc.nameAr}» موقع الاستلام الافتراضي.`, `«${loc.nameEn || loc.nameAr}» is now the default receiving site.`)
                : L(`أصبح «${loc.nameAr}» موقع الإنتاج.`, `«${loc.nameEn || loc.nameAr}» is now the production site.`));
            }} />
        ) : null}
        {closing ? (
          <DeactivateDialog loc={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); setToast({ msg: L("أُوقف الموقع. يبقى في السجلات والتقارير.", "Location deactivated. It stays in the history and reports."), tone: "success" }); reload(); }} />
        ) : null}
      </div>
    </OpsRoot>
  );
}

function LocationDialog({ loc, taken, onClose, onSaved }: { loc: Loc | null; taken: Set<string>; onClose: () => void; onSaved: (msg: string) => void }) {
  const { lang } = useI18n();
  const L = useL();
  const [nameAr, setNameAr] = useState(loc?.nameAr ?? "");
  const [nameEn, setNameEn] = useState(loc?.nameEn ?? "");
  const [code, setCode] = useState(loc?.code ?? "");
  const [codeTouched, setCodeTouched] = useState(!!loc);
  const [type, setType] = useState<string>(loc?.type ?? "BRANCH");
  const [address, setAddress] = useState(loc?.address ?? "");
  const [notes, setNotes] = useState(loc?.notes ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const shownCode = codeTouched ? code : suggestLocationCode(nameEn, taken);

  async function save() {
    setSaving(true);
    setError("");
    const body = { nameAr, nameEn, code: shownCode, type, address, notes };
    const r = await fetch(loc ? `/api/inventory/locations/${loc.id}` : "/api/inventory/locations", { method: loc ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setSaving(false);
    if (!r.ok) { setError(localizeApiError(await r.json().catch(() => ({})), lang) ?? L("تعذّر الحفظ.", "Could not save.")); return; }
    onSaved(loc ? L("حُفظ الموقع.", "Location saved.") : L("أُضيف الموقع.", "Location added."));
  }

  return (
    <Dialog open title={loc ? L("تعديل الموقع", "Edit location") : L("موقع جديد", "New location")} sub={loc ? locationName(loc, lang) : undefined} onClose={onClose}
      actions={<>
        <Btn variant="primary" busy={saving} disabled={!nameAr.trim() || !shownCode.trim()} onClick={save} data-testid="loc-save">{L("حفظ", "Save")}</Btn>
        <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
      </>}
    >
      {error ? <Notice tone="danger"><span data-testid="loc-error">{error}</span></Notice> : null}
      <div className="hr-form">
        <Field label={`${L("الاسم بالعربية", "Arabic name")} *`}>
          <input className="hr-input" value={nameAr} maxLength={80} onChange={(e) => setNameAr(e.target.value)} data-testid="loc-name-ar" placeholder={L("مثال: فرع الجبيل", "e.g. فرع الجبيل")} />
        </Field>
        <Field label={L("الاسم بالإنجليزية", "English name")}>
          <input className="hr-input" dir="ltr" value={nameEn} maxLength={80} onChange={(e) => setNameEn(e.target.value)} data-testid="loc-name-en" placeholder="e.g. Jubail branch" />
        </Field>
        <Field label={`${L("النوع", "Type")} *`}>
          <Select className="hr-select" value={type} onChange={(e) => setType(e.target.value)} data-testid="loc-type">
            {LOCATION_TYPES.map((t) => <option key={t} value={t}>{LOCATION_TYPE_LABEL[t][lang === "ar" ? 0 : 1]}</option>)}
          </Select>
        </Field>
        <Field label={`${L("الرمز", "Code")} *`} help={L("رمز قصير بالإنجليزية يظهر في التقارير والملصقات، مثل JUB.", "A short code shown on reports and labels, e.g. JUB.")}>
          <input className="hr-input hr-id" dir="ltr" value={shownCode} maxLength={16} onChange={(e) => { setCodeTouched(true); setCode(e.target.value.toUpperCase()); }} data-testid="loc-code" />
        </Field>
        <Field label={L("العنوان", "Address")} wide>
          <input className="hr-input" value={address} maxLength={300} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label={L("ملاحظات", "Notes")} wide>
          <textarea className="hr-textarea" rows={2} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** The confirmation before a site becomes the default receiving site or the production site: what it does and does not change. */
function SiteRoleDialog({ loc, role, busy, onClose, onConfirm }: { loc: Loc; role: "default" | "production"; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const { lang } = useI18n();
  const L = useL();
  const isDefault = role === "default";
  return (
    <Dialog open title={isDefault ? L("تغيير موقع الاستلام الافتراضي", "Change the default receiving site") : L("تغيير موقع الإنتاج", "Change the production site")} sub={locationName(loc, lang)} onClose={onClose}
      actions={<>
        <Btn variant="primary" busy={busy} onClick={onConfirm} data-testid="loc-role-confirm">{isDefault ? L("اجعله الافتراضي", "Make default") : L("اجعله موقع الإنتاج", "Make production site")}</Btn>
        <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
      </>}
    >
      <p style={{ margin: 0 }} data-testid="loc-role-note">
        {isDefault
          ? L("هذا يغيّر فقط المكان الذي تذهب إليه الاستلامات الجديدة افتراضيًا. لا ينقل أي رصيد، ولا يغيّر موقع الإنتاج الذي يسحب منه التحميص والتعبئة، ولا مكان تسجيل التسويات بلا موقع.",
              "This only changes where new receipts go by default. It moves no stock, and it does not change the production site that roasting and packing draw from, nor where an adjustment with no site named is booked.")
          : L("سيسحب التحميص والتعبئة والتسليم من هذا الموقع، وتُسجَّل فيه أي تسوية بلا موقع. لا ينقل أي رصيد: انقل البن والمواد إليه بتحويل مخزون.",
              "Roasting, packing and dispatch will draw at this site, and an adjustment with no site named is booked here. It moves no stock: move the coffee and materials here with a stock transfer.")}
      </p>
    </Dialog>
  );
}

function DeactivateDialog({ loc, onClose, onDone }: { loc: Loc; onClose: () => void; onDone: () => void }) {
  const { lang } = useI18n();
  const L = useL();
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setRefusal(null);
    const r = await fetch(`/api/inventory/locations/${loc.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deactivate", reason }) });
    setSaving(false);
    if (r.ok) { onDone(); return; }
    const j = await r.json().catch(() => ({}));
    setRefusal({ msg: localizeApiError(j, lang) ?? L("تعذّر الإيقاف.", "Could not deactivate."), href: j?.location?.transferHref ?? null });
  }
  return (
    <Dialog open title={L("إيقاف الموقع", "Deactivate location")} sub={locationName(loc, lang)} onClose={onClose}
      actions={<>
        <Btn variant="danger" busy={saving} disabled={reason.trim().length < 3} onClick={save} data-testid="loc-deactivate-confirm">{L("إيقاف الموقع", "Deactivate location")}</Btn>
        <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
      </>}
    >
      {refusal ? (
        <Notice tone="danger">
          <span data-testid="loc-deactivate-refusal">{refusal.msg}</span>
          {refusal.href ? <> <Link className="ops-link" href={refusal.href} data-testid="loc-deactivate-transfer">{L("انقل الرصيد أولًا ←", "Move the stock first →")}</Link></> : null}
        </Notice>
      ) : null}
      <p style={{ margin: 0 }}>{L("الموقع الموقوف يختفي من قوائم الاختيار ولا يستقبل مخزونًا، ويبقى في السجلات والتقارير. يُعاد تفعيله متى شئت.", "An inactive location disappears from the pickers and receives no stock; it stays in the history and reports. You can reactivate it at any time.")}</p>
      <Field label={`${L("سبب الإيقاف", "Reason")} *`} help={L("مثال: إغلاق الفرع.", "e.g. the branch closed.")}>
        <input className="hr-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="loc-deactivate-reason" />
      </Field>
    </Dialog>
  );
}
