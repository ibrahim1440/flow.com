"use client";
// «الجرد والتسويات» — count sessions (Figma 216:2 tab; the count dialog 278:4772 is the single-item
// form). A session is a count sheet: start it with the items to count («إجراء جرد»), enter the
// counted quantities, review the variances, then post — one approved step (inventory › adjust) that
// books every variance through the same adjustment service as a single count. API:
// /api/inventory/counts, /:id, /:id/post, /:id/cancel.
import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Btn, Field, Notice, OpsLoading, StatusDot, opsDate, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useI18n } from "@/lib/i18n/context";
import { lineVariance, movedSinceCount } from "@/lib/inventory/counts";
import type { Material } from "../../_components/stock-materials";
import type { GreenBean } from "./green";
import { fmtQty, int, timeOf, unitWord } from "./shared";

type Category = "RAW_MATERIAL" | "PACKAGING_MATERIAL";
type Summary = { lines: number; counted: number; uncounted: number; withVariance: number; gains: Record<Category, number>; losses: Record<Category, number> };
type SessionRow = { id: string; number: number; status: "OPEN" | "POSTED" | "CANCELLED"; title: string | null; createdAt: string; postedAt: string | null; createdByName: string | null; postedByName: string | null; summary: Summary };
type Line = {
  id: string; category: Category; entityId: string; systemQty: number; countedQty: number | null; notes: string | null;
  postedPreviousQty: number | null; postedNewQty: number | null; postedVariance: number | null; movementId: string | null;
  item: { name: string; nameAr: string | null; code: string; sub: string | null; unit: string; isActive: boolean } | null;
  currentQty: number | null; variance: number | null; bookable: boolean; countedByName: string | null; countedAt: string | null;
};
type Session = SessionRow & { notes: string | null; postReason: string | null; cancelledAt: string | null; lines: Line[] };

const STATUS: Record<string, [string, "success" | "warning" | "neutral", string]> = {
  OPEN: ["مفتوح", "warning", "Open"], POSTED: ["مُرحّل", "success", "Posted"], CANCELLED: ["ملغى", "neutral", "Cancelled"],
};

async function errorOf(res: Response, fallback: string): Promise<string> {
  const j = await res.json().catch(() => ({}));
  return (j as { error?: string }).error ?? fallback;
}

const fmtVar = (v: number | null, unit: string, lang: "ar" | "en") => {
  if (v === null) return "—";
  if (Math.abs(v) < 0.001) return lang === "ar" ? "مطابق" : "Matches";
  const discrete = unit === "PIECE" || unit === "UNIT";
  return `${v > 0 ? "+" : lang === "ar" ? "–" : "−"}${discrete ? int(Math.abs(v)) : Math.abs(v).toFixed(2)} ${unitWord(unit, lang, Math.abs(v))}`;
};

// ─── Start a count («إجراء جرد»): pick green-coffee lots and / or packaging materials ──────────

export function StartCountDialog({ beans, materials, onClose, onCreated, defaultCategory }: {
  beans: GreenBean[]; materials: Material[]; onClose: () => void; onCreated: (id: string) => void; defaultCategory?: Category;
}) {
  const { lang } = useI18n();
  const L = useL();
  const [cat, setCat] = useState<Category>(defaultCategory ?? "RAW_MATERIAL");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = cat === "RAW_MATERIAL"
      ? beans.filter((b) => b.isActive).map((b) => ({ key: `RAW_MATERIAL:${b.id}`, name: lang === "ar" && b.beanTypeAr ? b.beanTypeAr : b.beanType, sub: `${b.serialNumber}${b.location ? ` · ${L("رف", "Shelf")} ${b.location}` : ""}`, qty: `${fmtQty(b.quantityKg, 2)} ${unitWord("KG", lang)}` }))
      : materials.filter((m) => m.isActive).map((m) => ({ key: `PACKAGING_MATERIAL:${m.id}`, name: lang === "ar" && m.nameAr ? m.nameAr : m.name, sub: m.code, qty: `${int(m.quantityOnHand)} ${unitWord(m.unitOfMeasure, lang, m.quantityOnHand)}` }));
    return s ? list.filter((i) => `${i.name} ${i.sub}`.toLowerCase().includes(s)) : list;
  }, [cat, q, beans, materials, lang, L]);

  const allOn = items.length > 0 && items.every((i) => picked.has(i.key));
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleAll = () => setPicked((p) => { const n = new Set(p); for (const i of items) { if (allOn) n.delete(i.key); else n.add(i.key); } return n; });
  const nGreen = [...picked].filter((k) => k.startsWith("RAW_MATERIAL:")).length;
  const nPack = picked.size - nGreen;

  async function create() {
    setSaving(true);
    setError("");
    const res = await fetch("/api/inventory/counts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim() || null,
        items: [...picked].map((k) => { const [category, entityId] = k.split(":"); return { category, entityId }; }),
      }),
    });
    setSaving(false);
    if (!res.ok) { setError(await errorOf(res, L("تعذّر بدء الجرد.", "Could not start the count."))); return; }
    const s = await res.json();
    onCreated(s.id);
  }

  return (
    <Dialog open title={L("إجراء جرد", "Start a count")} className="stk-wide" onClose={onClose}
      sub={L("اختر الأصناف التي ستُعدّ. لا يتغيّر أي رصيد حتى تُرحَّل التسويات.", "Choose the items to count. No balance changes until the adjustments are posted.")}
      actions={
        <>
          <Btn variant="primary" busy={saving} disabled={picked.size === 0} onClick={create} data-testid="count-start">
            {L("بدء الجرد", "Start count")}{picked.size ? ` (${picked.size})` : ""}
          </Btn>
          <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
        </>
      }>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="hr-stack" style={{ gap: 12 }}>
        <div className="hr-tabs is-underline" role="tablist" aria-label={L("نوع الصنف", "Item kind")}>
          {(["RAW_MATERIAL", "PACKAGING_MATERIAL"] as Category[]).map((c) => (
            <button key={c} type="button" role="tab" aria-selected={cat === c} className="hr-tab" onClick={() => { setCat(c); setQ(""); }}>
              {c === "RAW_MATERIAL" ? L("البن الأخضر", "Green coffee") : L("مواد التعبئة", "Packaging materials")}
              {(c === "RAW_MATERIAL" ? nGreen : nPack) ? <span className="hr-count">{c === "RAW_MATERIAL" ? nGreen : nPack}</span> : null}
            </button>
          ))}
        </div>
        <input type="search" className="hr-input" placeholder={cat === "RAW_MATERIAL" ? L("الصنف أو الرقم التسلسلي", "Bean or serial number") : L("رمز المادة أو اسمها", "Material code or name")}
          aria-label={L("بحث", "Search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="stk-pick-head">
          <span>{lang === "ar" ? `${items.length} صنفًا` : `${items.length} items`}</span>
          <button type="button" className="hr-btn is-ghost is-sm" onClick={toggleAll} disabled={!items.length}>{allOn ? L("إلغاء تحديد الكل", "Clear all") : L("تحديد الكل", "Select all")}</button>
        </div>
        <div className="stk-pick" role="group" aria-label={L("الأصناف", "Items")}>
          {items.length === 0 ? <p className="hr-caption" style={{ padding: 12, margin: 0 }}>{L("لا أصناف.", "No items.")}</p> : items.map((i) => (
            <label key={i.key}>
              <input type="checkbox" checked={picked.has(i.key)} onChange={() => toggle(i.key)} />
              <span><span>{i.name}</span><span className="stk-pick-sub hr-id">{i.sub}</span></span>
              <span className="stk-pick-q">{i.qty}</span>
            </label>
          ))}
        </div>
        <Field label={L("عنوان الجرد (اختياري)", "Count title (optional)")}>
          <input className="hr-input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={L("مثال: جرد نهاية الشهر · المستودع", "e.g. Month-end count · warehouse")} />
        </Field>
      </div>
    </Dialog>
  );
}

// ─── The tab ──────────────────────────────────────────────────────────────────────────────────

export function CountsTab({ openId, onOpen, canEdit, canPost, onStart, onPosted }: {
  openId: string | null; onOpen: (id: string | null) => void; canEdit: boolean; canPost: boolean; onStart: () => void; onPosted: () => void;
}) {
  const { lang } = useI18n();
  const L = useL();
  const [list, setList] = useState<SessionRow[] | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let off = false;
    fetch("/api/inventory/counts").then((r) => (r.ok ? r.json() : [])).then((j) => { if (!off) setList(j); });
    return () => { off = true; };
  }, [rev, openId]);

  if (openId) return <CountSheet id={openId} canEdit={canEdit} canPost={canPost} onBack={() => onOpen(null)} onPosted={() => { setRev((r) => r + 1); onPosted(); }} />;

  const open = (list ?? []).filter((s) => s.status === "OPEN");
  const lastPosted = (list ?? []).find((s) => s.status === "POSTED");
  return (
    <section className="hr-stack" aria-label={L("الجرد والتسويات", "Counts and adjustments")}>
      <div className="stk-metrics" style={{ ["--stk-cols" as string]: 3 }}>
        <div>
          <span className="stk-lbl">{L("عمليات جرد مفتوحة", "Open counts")}</span>
          <span className={`stk-mid${open.length ? " tone-warning" : ""}`}>{list ? open.length : "—"}</span>
          <span className="stk-d">{open.length ? open.map((s) => `#${s.number}`).join("، ") : L("لا جرد قيد العدّ", "Nothing being counted")}</span>
        </div>
        <div>
          <span className="stk-lbl">{L("آخر جرد مُرحّل", "Last posted count")}</span>
          <span className="stk-mid">{lastPosted ? `#${lastPosted.number}` : "—"}</span>
          <span className="stk-d">{lastPosted ? `${opsDate(lastPosted.postedAt, lang)} · ${lastPosted.summary.withVariance} ${L("تسويات", "adjustments")}` : "—"}</span>
        </div>
        <div>
          <span className="stk-lbl">{L("أصناف عُدّت في آخر جرد", "Items in the last count")}</span>
          <span className="stk-mid">{lastPosted ? lastPosted.summary.lines : "—"}</span>
          <span className="stk-d">{lastPosted ? `${L("بفروقات", "with a variance")}: ${lastPosted.summary.withVariance}` : "—"}</span>
        </div>
      </div>

      {!list ? <OpsLoading /> : list.length === 0 ? (
        <div className="hr-state">
          <h3>{L("لم يُجرَ أي جرد بعد", "No count yet")}</h3>
          <p>{L("ابدأ جردًا لعدّ عدة أصناف ومراجعة الفروقات وترحيلها مرة واحدة.", "Start a count to count several items, review the variances and post them in one step.")}</p>
          {canEdit ? <Btn variant="primary" onClick={onStart}>{L("إجراء جرد", "Start a count")}</Btn> : null}
        </div>
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("عمليات الجرد", "Counts")}>
            <thead>
              <tr>
                <th>{L("الجرد", "Count")}</th>
                <th>{L("الحالة", "Status")}</th>
                <th className="num">{L("الأصناف", "Items")}</th>
                <th className="num">{L("عُدّ", "Counted")}</th>
                <th className="num">{L("بفروقات", "Variances")}</th>
                <th className="hr-hide-compact">{L("بدأه", "Started by")}</th>
                <th className="hr-hide-compact">{L("الترحيل", "Posted")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className="is-clickable" tabIndex={0} onClick={() => onOpen(s.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(s.id); } }}>
                  <td className="m-title">
                    <span className="strong">{L("جرد", "Count")} #{s.number}</span>{s.title ? <span className="hr-caption"> · {s.title}</span> : null}
                    <span className="hr-msub">{opsDate(s.createdAt, lang)} · {s.summary.lines} {L("أصناف", "items")} · {s.summary.withVariance} {L("بفروقات", "with variance")}</span>
                  </td>
                  <td className="m-end"><StatusDot map={STATUS} value={s.status} /></td>
                  <td className="num"><span className="hr-num">{s.summary.lines}</span></td>
                  <td className="num"><span className="hr-num">{s.summary.counted}</span></td>
                  <td className="num"><span className="hr-num">{s.summary.withVariance}</span></td>
                  <td className="hr-hide-compact hr-caption">{s.createdByName ?? "—"} · {opsDate(s.createdAt, lang)}</td>
                  <td className="hr-hide-compact hr-caption">{s.postedAt ? `${opsDate(s.postedAt, lang)} ${timeOf(s.postedAt)} · ${s.postedByName ?? "—"}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="stk-foot">{L("الجرد لا يغيّر الأرصدة حتى يُرحَّل. الترحيل يسجّل لكل فرق حركة «تسوية» في سجل الحركات تحمل السبب واسم من رحّلها.", "A count changes no balance until it is posted. Posting records an «Adjustment» movement for each variance, with the reason and who posted it.")}</p>
    </section>
  );
}

function CountSheet({ id, canEdit, canPost, onBack, onPosted }: { id: string; canEdit: boolean; canPost: boolean; onBack: () => void; onPosted: () => void }) {
  const { lang } = useI18n();
  const L = useL();
  const [s, setS] = useState<Session | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [posting, setPosting] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    let off = false;
    fetch(`/api/inventory/counts/${id}`).then(async (r) => { if (!off) { if (r.ok) setS(await r.json()); else setError(await errorOf(r, "")); } });
    return () => { off = true; };
  }, [id]);

  const editable = !!s && s.status === "OPEN" && canEdit;
  const dirty = Object.keys(draft).length + Object.keys(notes).length > 0;

  async function patch(body: Record<string, unknown>) {
    setBusy(true); setError(""); setOk("");
    const r = await fetch(`/api/inventory/counts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) { setError(await errorOf(r, L("تعذّر الحفظ.", "Could not save."))); return false; }
    setS(await r.json());
    return true;
  }

  async function save() {
    const ids = new Set([...Object.keys(draft), ...Object.keys(notes)]);
    const lines = [...ids].map((lid) => ({
      id: lid,
      ...(lid in draft ? { countedQty: draft[lid].trim() === "" ? null : draft[lid].trim() } : {}),
      ...(lid in notes ? { notes: notes[lid] } : {}),
    }));
    if (await patch({ lines })) { setDraft({}); setNotes({}); setOk(L("حُفظت الكميات المعدودة.", "Counted quantities saved.")); }
  }

  async function post() {
    if (dirty) { await save(); }
    setBusy(true); setError("");
    const r = await fetch(`/api/inventory/counts/${id}/post`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason.trim() }) });
    setBusy(false);
    if (!r.ok) { setError(await errorOf(r, L("تعذّر الترحيل.", "Could not post."))); setPosting(false); return; }
    const j = await r.json();
    setS(j.session);
    setPosting(false);
    setReason("");
    setOk(lang === "ar" ? `رُحّل الجرد: ${j.booked} تسويات سُجّلت في سجل الحركات.` : `Count posted: ${j.booked} adjustments recorded in the ledger.`);
    onPosted();
  }

  async function cancel() {
    setBusy(true); setError("");
    const r = await fetch(`/api/inventory/counts/${id}/cancel`, { method: "POST" });
    setBusy(false);
    setConfirmCancel(false);
    if (!r.ok) { setError(await errorOf(r, L("تعذّر الإلغاء.", "Could not cancel."))); return; }
    setS(await r.json());
  }

  if (!s) return error ? <Notice tone="danger">{error}</Notice> : <OpsLoading />;

  // Live preview of the sheet with the unsaved entries.
  const rows = s.lines.map((l) => {
    const raw = draft[l.id];
    const counted = raw === undefined ? l.countedQty : raw.trim() === "" ? null : Number(raw);
    const v = counted === null || !Number.isFinite(counted) ? null : lineVariance({ systemQty: l.systemQty, countedQty: counted });
    return { l, counted, v };
  });
  const uncounted = rows.filter((r) => r.counted === null).length;
  const bookable = rows.filter((r) => r.v !== null && Math.abs(r.v) >= 0.001);
  const unit = (l: Line) => l.item?.unit ?? (l.category === "RAW_MATERIAL" ? "KG" : "PIECE");
  const disp = (l: Line) => (l.item ? (lang === "ar" && l.item.nameAr ? l.item.nameAr : l.item.name) : L("صنف محذوف", "Deleted item"));
  const sumBy = (cat: Category, sign: 1 | -1) => bookable.filter((r) => r.l.category === cat && Math.sign(r.v!) === sign).reduce((a, r) => a + r.v!, 0);

  return (
    <section className="hr-stack" aria-label={`${L("جرد", "Count")} #${s.number}`}>
      <div className="ops-sechead">
        <button type="button" className="hr-btn is-ghost is-sm" onClick={onBack}>{lang === "ar" ? "→" : "←"} {L("كل عمليات الجرد", "All counts")}</button>
      </div>
      <div className="ops-sechead" style={{ marginTop: 0 }}>
        <h2>{L("جرد", "Count")} #{s.number}{s.title ? ` · ${s.title}` : ""}</h2>
        <p className="hr-caption"><StatusDot map={STATUS} value={s.status} /> · {L("بدأه", "started by")} {s.createdByName ?? "—"} · {opsDate(s.createdAt, lang)} {timeOf(s.createdAt)}</p>
        {editable ? (
          <span style={{ display: "inline-flex", gap: 8 }}>
            <Btn size="sm" variant="ghost" onClick={() => setConfirmCancel(true)} disabled={busy}>{L("إلغاء الجرد", "Cancel count")}</Btn>
            <Btn size="sm" onClick={save} disabled={!dirty || busy} data-testid="count-save">{L("حفظ الكميات", "Save quantities")}</Btn>
            {canPost ? <Btn size="sm" variant="primary" disabled={busy || uncounted > 0} onClick={() => setPosting(true)} data-testid="count-review">{L("مراجعة وترحيل", "Review and post")}</Btn> : null}
          </span>
        ) : null}
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {ok ? <Notice tone="success">{ok}</Notice> : null}
      {s.status === "OPEN" && !canPost && canEdit ? <Notice tone="info">{L("الترحيل يحتاج صلاحية «تسوية المخزون». أدخل الكميات واحفظها، وسيرحّلها من يملك الصلاحية.", "Posting needs the inventory › adjust permission. Enter and save the quantities; someone holding it will post them.")}</Notice> : null}
      {s.status === "POSTED" ? <Notice tone="success">{L("مُرحّل", "Posted")} {opsDate(s.postedAt, lang)} {s.postedAt ? timeOf(s.postedAt) : ""} · {s.postedByName ?? "—"} · {L("السبب", "Reason")}: {s.postReason}</Notice> : null}

      <div className="stk-metrics">
        <div><span className="stk-lbl">{L("أصناف", "Items")}</span><span className="stk-mid">{s.lines.length}</span><span className="stk-d">{uncounted ? `${uncounted} ${L("لم تُعدّ بعد", "not counted yet")}` : L("عُدّت كلها", "All counted")}</span></div>
        <div><span className="stk-lbl">{L("بفروقات", "With a variance")}</span><span className={`stk-mid${bookable.length ? " tone-warning" : ""}`}>{bookable.length}</span><span className="stk-d">{L("تُسجَّل كتسويات عند الترحيل", "Booked as adjustments when posted")}</span></div>
        <div><span className="stk-lbl">{L("صافي البن الأخضر", "Green coffee net")}</span><span className="stk-mid">{fmtVar(sumBy("RAW_MATERIAL", 1) + sumBy("RAW_MATERIAL", -1), "KG", lang)}</span><span className="stk-d">{L("زيادة", "gain")} {fmtQty(sumBy("RAW_MATERIAL", 1), 2)} · {L("نقص", "loss")} {fmtQty(Math.abs(sumBy("RAW_MATERIAL", -1)), 2)}</span></div>
        <div><span className="stk-lbl">{L("صافي مواد التعبئة", "Packaging net")}</span><span className="stk-mid">{fmtVar(sumBy("PACKAGING_MATERIAL", 1) + sumBy("PACKAGING_MATERIAL", -1), "PIECE", lang)}</span><span className="stk-d">{L("زيادة", "gain")} {int(sumBy("PACKAGING_MATERIAL", 1))} · {L("نقص", "loss")} {int(Math.abs(sumBy("PACKAGING_MATERIAL", -1)))}</span></div>
      </div>

      <div className="hr-tablewrap">
        <table className="hr-table is-mrow" aria-label={L("ورقة الجرد", "Count sheet")}>
          <thead>
            <tr>
              <th>{L("الصنف", "Item")}</th>
              <th className="num">{L("في النظام", "System")}</th>
              <th className="num">{L("الكمية الفعلية", "Counted")}</th>
              <th className="num">{L("الفارق", "Variance")}</th>
              <th className="hr-hide-compact">{L("ملاحظة", "Note")}</th>
              {editable ? <th aria-label={L("إزالة", "Remove")} /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ l, counted, v }) => {
              const u = unit(l);
              const digits = u === "PIECE" || u === "UNIT" ? 0 : 2;
              const moved = s.status === "OPEN" && l.currentQty !== null && movedSinceCount(l.currentQty, l.systemQty);
              return (
                <tr key={l.id} className={counted === null ? "is-uncounted" : undefined}>
                  <td className="m-title">
                    <span className="strong">{disp(l)}</span>
                    <span className="stk-sub hr-id">{l.item?.code ?? l.entityId}{l.category === "RAW_MATERIAL" && l.item?.sub ? ` · ${L("رف", "Shelf")} ${l.item.sub}` : ""}</span>
                    <span className="hr-msub">{L("في النظام", "System")} <span className="hr-num">{fmtQty(l.systemQty, digits)}</span> · {L("الفارق", "variance")} <span className="stk-qtyc">{fmtVar(v, u, lang)}</span></span>
                  </td>
                  <td className="num">
                    <span className="hr-num" style={{ color: "var(--text-secondary)" }}>{digits ? fmtQty(l.systemQty, digits) : int(l.systemQty)}</span>
                    {moved ? <span className="stk-moved">{L("الآن", "now")} {fmtQty(l.currentQty, digits)}</span> : null}
                  </td>
                  <td className="num m-end">
                    {editable ? (
                      <input className="hr-input stk-count-in" inputMode="decimal" type="number" min={0} step={digits ? 1 : 0.001}
                        aria-label={`${L("الكمية الفعلية", "Counted")} · ${disp(l)}`} data-testid="count-qty"
                        value={draft[l.id] ?? (l.countedQty === null ? "" : String(l.countedQty))}
                        onChange={(e) => setDraft((d) => ({ ...d, [l.id]: e.target.value }))} />
                    ) : <span className="hr-num" style={{ fontWeight: 600 }}>{digits ? fmtQty(l.countedQty, digits) : int(l.countedQty)}</span>}
                  </td>
                  <td className="num">
                    <span className={`stk-qtyc ${v === null || Math.abs(v) < 0.001 ? "hr-muted" : v > 0 ? "stk-var-pos" : "stk-var-neg"}`}>{fmtVar(v, u, lang)}</span>
                    {s.status === "POSTED" && l.movementId ? <span className="stk-sub">{L("سُجّلت", "booked")} {fmtQty(l.postedPreviousQty, digits)} {lang === "ar" ? "←" : "→"} {fmtQty(l.postedNewQty, digits)}</span> : null}
                  </td>
                  <td className="hr-hide-compact">
                    {editable ? (
                      <input className="hr-input" maxLength={300} aria-label={`${L("ملاحظة", "Note")} · ${disp(l)}`} placeholder={L("اختياري", "Optional")}
                        value={notes[l.id] ?? l.notes ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))} />
                    ) : <span className="hr-caption">{l.notes ?? "—"}</span>}
                  </td>
                  {editable ? (
                    <td className="stk-acts">
                      <Btn size="sm" variant="ghost" className="hr-iconbtn" aria-label={`${L("إزالة", "Remove")} · ${disp(l)}`} title={L("إزالة من الجرد", "Remove from the count")} disabled={busy}
                        onClick={() => patch({ remove: [l.id] })}><Trash2 size={16} /></Btn>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={posting} title={L("ترحيل التسويات", "Post the adjustments")} onClose={() => !busy && setPosting(false)}
        sub={`${L("جرد", "Count")} #${s.number} · ${bookable.length} ${L("تسويات", "adjustments")}`}
        actions={
          <>
            <Btn variant="primary" busy={busy} disabled={reason.trim().length < 8} onClick={post} data-testid="count-post">{L("ترحيل التسويات", "Post adjustments")}</Btn>
            <Btn onClick={() => setPosting(false)} disabled={busy}>{L("إلغاء", "Cancel")}</Btn>
          </>
        }>
        <div className="hr-stack" style={{ gap: 12 }}>
          {bookable.length === 0 ? <Notice tone="info">{L("كل الكميات مطابقة: يُغلق الجرد دون أي تسوية.", "Every quantity matches: the count closes with no adjustment.")}</Notice> : (
            <ul className="stk-glegend">
              {bookable.map(({ l, v }) => (
                <li key={l.id}><span>{disp(l)} <span className="hr-caption hr-id">{l.item?.code}</span></span><span className={`stk-qtyc ${v! > 0 ? "stk-var-pos" : "stk-var-neg"}`}>{fmtVar(v, unit(l), lang)}</span></li>
              ))}
            </ul>
          )}
          <p className="hr-caption" style={{ margin: 0 }}>{L("يُطبَّق كل فارق على الرصيد الحالي، فلا تضيع حركة حدثت بعد العدّ (تحميص أو استلام).", "Each variance is applied to the current balance, so a movement made after the count (a roast, a receipt) is kept.")}</p>
          <Field label={`${L("سبب التسوية", "Reason")} *`} help={L("مطلوب، 8 أحرف على الأقل. يظهر في سجل الحركات مع اسمك.", "Required, at least 8 characters. Shown in the ledger with your name.")}>
            <textarea className="hr-textarea" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-testid="count-reason"
              placeholder={L("مثال: جرد نهاية أكتوبر · المستودع الرئيسي", "e.g. October month-end count · main store")} />
          </Field>
        </div>
      </Dialog>

      <Dialog open={confirmCancel} title={L("إلغاء الجرد", "Cancel the count")} onClose={() => setConfirmCancel(false)}
        actions={<><Btn variant="danger" busy={busy} onClick={cancel}>{L("إلغاء الجرد", "Cancel count")}</Btn><Btn onClick={() => setConfirmCancel(false)}>{L("رجوع", "Back")}</Btn></>}>
        <p style={{ margin: 0 }}>{L("لن تُسجَّل أي تسوية، ويبقى الجرد في السجل ملغى.", "No adjustment is recorded; the count stays on record as cancelled.")}</p>
      </Dialog>
    </section>
  );
}

