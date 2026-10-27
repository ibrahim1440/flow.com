"use client";
// Item categories (unified inventory, phase 1; migration 20261112090000_item_categories) — linked from the
// inventory page header. Add a main category or a sub-category, rename it (Arabic / English), set its default
// unit, reorder, archive or restore. A main category picks its type once (supplies or general stock); a
// sub-category takes its main category's. The seeded green, roasted and finished categories are locked: renamed
// or reordered only. Each category is booked to an inventory account that follows its type — never chosen here.
// Writes: inventory › receive or adjust (as the bean records); every change is in the settings trail.
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Lock } from "lucide-react";
import { Btn, Field, Notice, OpsBanner, OpsLoading, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import "@/components/ops/stock.css";
import { useUser } from "../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { ITEM_UNITS, ROLE_LABEL, TEMPLATE_LABEL, UNIT_LABEL, USER_ROOT_TEMPLATES, type CategoryInventoryRole, type CategoryTemplate, type ItemUnit } from "@/lib/inventory/item-categories";
import type { CategoryNode } from "../_parts/add-item";

type Editing = { mode: "new"; parent: CategoryNode | null } | { mode: "edit"; cat: CategoryNode };

export default function CategoriesPage() {
  const user = useUser();
  const { lang } = useI18n();
  const L = useL();
  const canWrite = !!user && (hasSubPrivilege(user.permissions, "inventory", "receive") || hasSubPrivilege(user.permissions, "inventory", "adjust"));
  const [cats, setCats] = useState<CategoryNode[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: "success" | "danger" } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/inventory/categories${showArchived ? "?archived=1" : ""}`);
    setCats(r.ok ? await r.json() : []);
  }, [showArchived]);
  useEffect(() => {
    let off = false;
    fetch(`/api/inventory/categories${showArchived ? "?archived=1" : ""}`).then(async (r) => { const j = r.ok ? await r.json() : []; if (!off) setCats(j); });
    return () => { off = true; };
  }, [showArchived]);

  const pair = (m: Record<string, [string, string]>, k: string) => (m[k] ? (lang === "ar" ? m[k][0] : m[k][1]) : k);
  const all = cats ?? [];
  const roots = all.filter((c) => !c.parentId);

  async function call(url: string, method: string, body: unknown): Promise<boolean> {
    setBusy(true);
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) {
      setToast({ msg: localizeApiError(await r.json().catch(() => ({})), lang) ?? L("تعذّر الحفظ.", "Could not save."), tone: "danger" });
      return false;
    }
    return true;
  }

  async function move(c: CategoryNode, dir: -1 | 1) {
    const sibs = all.filter((x) => x.parentId === c.parentId && x.isActive);
    const i = sibs.findIndex((x) => x.id === c.id);
    const j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    const ids = sibs.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    if (await call("/api/inventory/categories/reorder", "POST", { parentId: c.parentId, ids })) load();
  }

  async function archive(c: CategoryNode, archived: boolean) {
    if (await call(`/api/inventory/categories/${c.id}`, "PATCH", { archived })) {
      setToast({ msg: archived ? L("أُرشف التصنيف.", "Category archived.") : L("استُعيد التصنيف.", "Category restored."), tone: "success" });
      load();
    }
  }

  const row = (c: CategoryNode, child: boolean, idx: number, count: number) => {
    const viewOnly = c.template === "GREEN_COFFEE" || c.template === "ROASTED_COFFEE" || c.template === "FINISHED";
    const kids = child ? 0 : all.filter((x) => x.parentId === c.id).reduce((a, k) => a + k.itemCount, 0);
    return (
      <tr key={c.id} className={`${child ? "cat-row-child" : "cat-row-root"}${c.isActive ? "" : " is-inactive"}`} data-testid={`catrow-${c.id}`}>
        <td className="cat-name m-title">
          <span className="strong">{c.nameAr}</span>
          <span className="stk-sub" dir="ltr">{c.nameEn ?? "—"}</span>
          <span className="hr-msub">{pair(TEMPLATE_LABEL, c.template)} · {L("الأصناف", "Items")} <span className="hr-num">{c.itemCount + kids}</span></span>
        </td>
        <td className="hr-hide-mobile">{pair(TEMPLATE_LABEL, c.template)}</td>
        <td className="hr-hide-compact hr-caption">{pair(ROLE_LABEL as Record<string, [string, string]>, c.inventoryRole as CategoryInventoryRole)}</td>
        <td className="hr-hide-mobile">{pair(UNIT_LABEL, c.defaultUnit as ItemUnit)}</td>
        <td className="num"><span className="hr-num">{c.itemCount + kids}</span></td>
        <td className="hr-hide-mobile">
          {c.isSystem ? <span className="cat-lock"><Lock size={12} aria-hidden="true" /> {L("أساسي", "System")}</span> : c.isActive ? L("نشط", "Active") : L("مؤرشف", "Archived")}
        </td>
        <td className="stk-acts">
          {canWrite ? (
            <>
              {c.isActive ? (
                <>
                  <Btn size="sm" variant="ghost" aria-label={L("تحريك لأعلى", "Move up")} title={L("تحريك لأعلى", "Move up")} disabled={busy || idx === 0} onClick={() => move(c, -1)}><ArrowUp size={14} /></Btn>
                  <Btn size="sm" variant="ghost" aria-label={L("تحريك لأسفل", "Move down")} title={L("تحريك لأسفل", "Move down")} disabled={busy || idx === count - 1} onClick={() => move(c, 1)}><ArrowDown size={14} /></Btn>
                  <Btn size="sm" onClick={() => setEditing({ mode: "edit", cat: c })} data-testid={`cat-edit-${c.id}`}>{L("تعديل", "Edit")}</Btn>
                  {!child && !viewOnly ? <Btn size="sm" onClick={() => setEditing({ mode: "new", parent: c })} data-testid={`cat-addsub-${c.id}`}>{L("+ تصنيف فرعي", "+ Sub-category")}</Btn> : null}
                  {!c.isSystem ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => archive(c, true)} data-testid={`cat-archive-${c.id}`}>{L("أرشفة", "Archive")}</Btn> : null}
                </>
              ) : (
                <Btn size="sm" disabled={busy} onClick={() => archive(c, false)} data-testid={`cat-restore-${c.id}`}>{L("استعادة", "Restore")}</Btn>
              )}
            </>
          ) : null}
        </td>
      </tr>
    );
  };

  return (
    <OpsRoot className="stk-inventory">
      <div className="hr-page">
        <PageHeader
          title={L("تصنيفات المخزون", "Inventory categories")}
          actions={<>
            <Link className="hr-btn is-ghost" href="/dashboard/inventory">{L("العودة إلى المخزون", "Back to inventory")}</Link>
            {canWrite ? <Btn variant="primary" onClick={() => setEditing({ mode: "new", parent: null })} data-testid="cat-add-root">{L("+ تصنيف رئيسي", "+ Main category")}</Btn> : null}
          </>}
        >
          <span className="hr-caption">{L("التصنيف يصف نوع المخزون، لا مكانه. لكل تصنيف حساب مخزون يتبع نوعه تلقائيًا.", "A category says what the stock is, not where it is. Each category is booked to the inventory account its type implies.")}</span>
        </PageHeader>

        {toast ? <OpsBanner tone={toast.tone} onClose={() => setToast(null)}><span data-testid="cat-toast">{toast.msg}</span></OpsBanner> : null}
        {!canWrite ? <Notice tone="info">{L("تستطيع استعراض التصنيفات فقط؛ التعديل لمن يملك صلاحية استلام المخزون أو تسويته.", "You can view the categories only; changes need the inventory receive or adjust permission.")}</Notice> : null}

        <div className="stk-tool">
          <Btn size="sm" className="stk-toggle" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>{L("إظهار المؤرشفة", "Show archived")}</Btn>
        </div>

        {!cats ? <OpsLoading /> : (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow" aria-label={L("تصنيفات المخزون", "Inventory categories")} data-testid="categories-table">
              <thead>
                <tr>
                  <th>{L("التصنيف", "Category")}</th>
                  <th className="hr-hide-mobile">{L("النوع", "Type")}</th>
                  <th className="hr-hide-compact">{L("يُسجَّل على", "Booked to")}</th>
                  <th className="hr-hide-mobile">{L("الوحدة", "Unit")}</th>
                  <th className="num">{L("الأصناف", "Items")}</th>
                  <th className="hr-hide-mobile">{L("الحالة", "Status")}</th>
                  <th aria-label={L("الإجراءات", "Actions")} />
                </tr>
              </thead>
              <tbody>
                {roots.map((r) => {
                  const kids = all.filter((c) => c.parentId === r.id);
                  const activeRoots = roots.filter((x) => x.isActive);
                  const activeKids = kids.filter((x) => x.isActive);
                  return [row(r, false, activeRoots.indexOf(r), activeRoots.length), ...kids.map((k) => row(k, true, activeKids.indexOf(k), activeKids.length))];
                })}
              </tbody>
            </table>
          </div>
        )}

        {editing ? (
          <CategoryDialog editing={editing} all={all} onClose={() => setEditing(null)}
            onSaved={(msg) => { setEditing(null); setToast({ msg, tone: "success" }); load(); }} />
        ) : null}
      </div>
    </OpsRoot>
  );
}

function CategoryDialog({ editing, all, onClose, onSaved }: { editing: Editing; all: CategoryNode[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const { lang } = useI18n();
  const L = useL();
  const cat = editing.mode === "edit" ? editing.cat : null;
  const parent = editing.mode === "new" ? editing.parent : cat?.parentId ? all.find((c) => c.id === cat.parentId) ?? null : null;
  const [nameAr, setNameAr] = useState(cat?.nameAr ?? "");
  const [nameEn, setNameEn] = useState(cat?.nameEn ?? "");
  const [template, setTemplate] = useState<CategoryTemplate>(cat ? (cat.template as CategoryTemplate) : parent ? (parent.template as CategoryTemplate) : "GENERAL");
  const [unit, setUnit] = useState<string>(cat?.defaultUnit ?? parent?.defaultUnit ?? "PIECE");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pair = (m: Record<string, [string, string]>, k: string) => (m[k] ? (lang === "ar" ? m[k][0] : m[k][1]) : k);
  const typeLocked = !!cat || !!parent;

  async function save() {
    setSaving(true);
    setError("");
    const body = cat
      ? { nameAr, nameEn, defaultUnit: unit }
      : { nameAr, nameEn, defaultUnit: unit, parentId: parent?.id ?? null, ...(parent ? {} : { template }) };
    const r = await fetch(cat ? `/api/inventory/categories/${cat.id}` : "/api/inventory/categories", { method: cat ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setSaving(false);
    if (!r.ok) { setError(localizeApiError(await r.json().catch(() => ({})), lang) ?? L("تعذّر الحفظ.", "Could not save.")); return; }
    onSaved(cat ? L("حُفظ التصنيف.", "Category saved.") : L("أُضيف التصنيف.", "Category added."));
  }

  const title = cat ? L("تعديل التصنيف", "Edit category") : parent ? L("تصنيف فرعي جديد", "New sub-category") : L("تصنيف رئيسي جديد", "New main category");
  return (
    <Dialog open title={title} sub={parent ? (lang === "ar" ? parent.nameAr : parent.nameEn || parent.nameAr) : undefined} onClose={onClose}
      actions={<>
        <Btn variant="primary" busy={saving} disabled={!nameAr.trim()} onClick={save} data-testid="cat-save">{L("حفظ", "Save")}</Btn>
        <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
      </>}>
      {error ? <Notice tone="danger"><span data-testid="cat-error">{error}</span></Notice> : null}
      <div className="hr-form" data-testid="category-form">
        <Field label={`${L("الاسم بالعربية", "Arabic name")} *`}>
          <input className="hr-input" dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={80} data-testid="cat-name-ar" />
        </Field>
        <Field label={L("الاسم بالإنجليزية", "English name")} help={L("اختياري", "Optional")}>
          <input className="hr-input" dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={80} data-testid="cat-name-en" />
        </Field>
        <Field label={L("النوع", "Type")} help={typeLocked ? (cat ? L("لا يتغيّر بعد الإنشاء.", "Fixed once created.") : L("يأخذ نوع التصنيف الرئيسي.", "Takes the main category's type.")) : L("يحدد النموذج وحساب المخزون.", "Sets the form and the inventory account.")}>
          {typeLocked ? (
            <input className="hr-input" value={pair(TEMPLATE_LABEL, template)} disabled readOnly />
          ) : (
            <Select className="hr-select" value={template} onChange={(e) => setTemplate(e.target.value as CategoryTemplate)} data-testid="cat-template">
              {USER_ROOT_TEMPLATES.map((t) => <option key={t} value={t}>{pair(TEMPLATE_LABEL, t)}</option>)}
            </Select>
          )}
        </Field>
        <Field label={L("الوحدة الافتراضية", "Default unit")}>
          <Select className="hr-select" value={unit} onChange={(e) => setUnit(e.target.value)} data-testid="cat-unit">
            {ITEM_UNITS.map((u) => <option key={u} value={u}>{pair(UNIT_LABEL, u)}</option>)}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
