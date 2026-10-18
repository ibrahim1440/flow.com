"use client";

import { useState, useEffect, useCallback, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Plus, Trash2, X, Link2, QrCode, ClipboardList, CheckSquare, Square, PackagePlus } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useUser } from "@/app/dashboard/user-context";
import { canEdit } from "@/lib/auth-shared";
import { Dialog, Notice } from "@/components/hr/ui";
import { Btn, CUP_FORMS, GUEST_FORMS, SCORER_FORMS, OpsEmpty, OpsError, OpsLoading, OpsRoot, PageHeader, SCORE_FORMS, StatusDot, Tabs, countNoun, opsDate, scorersOf, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";



type SessionBatch = {
  id: string;
  order: number;
  isExternalSample: boolean;
  externalSampleName: string | null;
  externalSupplierName: string | null;
  batch: {
    batchNumber: string;
    roastProfile: string | null;
    greenBean: { beanType: string; serialNumber: string } | null;
    orderItem: { beanTypeName: string } | null;
  } | null;
};

type SessionItem =
  | { type: "batch"; batchId: string; label: string; sub: string }
  | { type: "external"; externalSampleName: string; externalSupplierName: string; label: string };

type Session = {
  id: string;
  name: string;
  date: string;
  status: "Open" | "Closed";
  sessionToken: string | null;
  batchId: string | null;
  greenBeanId: string | null;
  batch: { batchNumber: string } | null;
  greenBean: { serialNumber: string; beanType: string } | null;
  sessionBatches: SessionBatch[];
  _count: { scores: number };
  // E6 close policy (counts only — blind-safe). minScorers: the current setting while open,
  // the snapshot taken at close afterwards, null for a session closed before the policy.
  /** Complete staff scorers: every required cup scored (owner decision 3). */
  staffScorers: number;
  /** Staff who scored only some cups — kept, not counted. */
  partialScorers: number;
  guestScorers: number;
  requiredCups: number;
  minScorers: number | null;
  closeKind: "COMPLETE" | "INCOMPLETE" | null;
  closeReason: string | null;
};

type CloseRequest = { kind: "COMPLETE" | "INCOMPLETE"; reason?: string };
/** The server's rule for a reason (lib/cupping/close-policy): something besides whitespace and format characters. */
const hasVisibleText = (s: string) => s.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0\u2800\s\u0085]/gu, "") !== "";
type CloseResult = { ok: true } | { ok: false; code?: string; message: string };

type AvailableBatch = {
  id: string;
  batchNumber: string;
  status: string;
  roastProfile: string | null;
  greenBean: { beanType: string; serialNumber: string } | null;
  // Nullable since roast-to-stock: a batch roasted for the shelf has no order behind it.
  orderItem: { beanTypeName: string; order: { orderNumber: number } } | null;
};

// ── Invite ────────────────────────────────────────────────────────────────────
// G-03: a dialog at 1440 and a sheet on the phone; at 768–1279 the same content opens as a
// 404 px drawer under the 52 px top bar, with no scrim, so the list stays visible (OG-D
// geometry, decision 3 annex). The QR code is the app's real code, labelled as one block.

const DRAWER_MQ = "(min-width: 768px) and (max-width: 1279px)";

function InviteModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const L = useL();
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  // D-9: at 768–1279 the invite is a drawer with no scrim, so it is NOT modal — the list
  // beside it stays usable. Elsewhere it is the HR Dialog (modal, focus trapped).
  // Known on the first render (the invite only ever mounts on the client, after a click), so
  // the modal Dialog never flashes at 1024 and the drawer captures the Invite button (N-1).
  const [drawer, setDrawer] = useState(() => typeof window !== "undefined" && window.matchMedia(DRAWER_MQ).matches);
  const titleId = useId();
  const asideRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => {
    const mq = window.matchMedia(DRAWER_MQ);
    const on = () => setDrawer(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // The drawer: focus moves in on open and back to the opener on close; Esc closes it.
  useEffect(() => {
    if (!drawer) return;
    const opener = document.activeElement as HTMLElement | null;
    asideRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [drawer]);

  const isMulti = session.sessionBatches.length > 0;
  const guestUrl = isMulti
    ? `${origin}/guest-cupping/session/${session.sessionToken}`
    : `${origin}/guest-cupping/${session.id}`;

  async function handleCopy() {
    await navigator.clipboard.writeText(guestUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const title = L("دعوة مقيّمين", "Invite scorers");
  const body = (
    <>
      <p className="hr-caption" style={{ margin: 0 }}>{session.name}</p>
      {isMulti && (
        <Notice>{L("جلسة معمّاة: الضيف يرى «كوب 1، كوب 2…» فقط، لا أسماء البن.", "Blind session: guests see «Cup 1, Cup 2…» only, never the coffee names.")}</Notice>
      )}
      {origin && (
        <figure className="ops-qr" role="img" aria-label={L("رمز QR لرابط الضيف", "QR code for the guest link")}>
          <QRCodeSVG value={guestUrl} size={160} bgColor="#FFFFFF" fgColor="#1F1A17" level="M" />
        </figure>
      )}
      <p className="hr-caption" style={{ margin: 0 }}>{L("صفحة الضيف غير معتمدة على الجوال في المرحلة الأولى؛ يُفضّل فتح الرابط على جهاز مكتبي.", "The guest page is not certified on phones in Phase 1; open the link on a desktop computer where possible.")}</p>
      <div className="hr-field">
        <label htmlFor="guest-link" className="hr-label">{L("رابط الضيف", "Guest link")}</label>
        <div className="ops-copyrow">
          <input id="guest-link" className="hr-input" dir="ltr" readOnly value={guestUrl} onFocus={(e) => e.currentTarget.select()} />
          <Btn onClick={handleCopy} aria-live="polite">
            {copied ? L("نُسخ ✓", "Copied ✓") : <><Link2 size={14} aria-hidden="true" /> {L("نسخ", "Copy")}</>}
          </Btn>
        </div>
      </div>
      <Notice tone="warning">{L("الرابط لا ينتهي ولا يُلغى، ومن يملكه يقيّم دون دخول. شاركه مع المقيّمين فقط.", "The link never expires and cannot be revoked; anyone holding it can score without signing in. Share it with scorers only.")}</Notice>
    </>
  );

  if (drawer) {
    return (
      <aside ref={asideRef} tabIndex={-1} role="dialog" aria-labelledby={titleId} className="ops-invite-drawer" data-testid="cupping-invite">
        <div className="hr-dialog-head">
          <h2 className="hr-section" id={titleId}>{title}</h2>
          <Btn variant="ghost" size="sm" aria-label={L("إغلاق", "Close")} onClick={onClose}>✕</Btn>
        </div>
        <div className="hr-dialog-body">{body}</div>
        <div className="hr-dialog-actions"><Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn></div>
      </aside>
    );
  }
  return (
    <div className="ops-invite" data-testid="cupping-invite">
      <Dialog open title={title} onClose={onClose} actions={<Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn>}>{body}</Dialog>
    </div>
  );
}

// Dialogs from a table row are portalled (a <div> inside <tbody> is invalid markup) into the
// shell element, which carries the Direction 2.1 tokens, `dir` and `lang`.
const portalHost = () => document.querySelector<HTMLElement>(".d21") ?? document.body;

// ── Session Card ──────────────────────────────────────────────────────────────

function SessionCard({
  session,
  isAdmin,
  onClose,
  onDelete,
}: {
  session: Session;
  isAdmin: boolean;
  onClose: (id: string, req: CloseRequest) => Promise<CloseResult>;
  onDelete: (id: string) => void;
}) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState("");
  const [reason, setReason] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  // G-8 (decision 5): closing reveals the cups and scores to everyone and cannot be undone,
  // so it is confirmed first.
  const [askClose, setAskClose] = useState(false);

  const isMulti = session.sessionBatches.length > 0;
  const L = useL();
  const { lang } = useI18n();
  // E6: n = distinct staff scorers, m = the minimum that applies (guests never count).
  const minScorers = session.minScorers ?? 2;
  const meetsMinimum = session.staffScorers >= minScorers;
  const isIncomplete = session.status === "Closed" && session.closeKind === "INCOMPLETE";
  function dismissClose() { setAskClose(false); setCloseError(""); setReason(""); }
  async function submitClose(req: CloseRequest) {
    setClosing(true);
    setCloseError("");
    const r = await onClose(session.id, req);
    setClosing(false);
    // The dialog stays open on a refusal, with the server's reason and the typed reason kept.
    if (r.ok) dismissClose();
    else setCloseError(r.message);
  }
  const cups = isMulti
    ? session.sessionBatches.map((sb, i) => `${L("كوب", "Cup")} ${i + 1}: ${sb.isExternalSample ? (sb.externalSampleName ?? L("عينة خارجية", "External")) : (sb.batch?.batchNumber ?? "—")}`).join(" · ")
    : [session.batch ? session.batch.batchNumber : null, session.greenBean ? `${session.greenBean.beanType} #${session.greenBean.serialNumber}` : null].filter(Boolean).join(" · ");

  return (
    <>
      {showInvite && createPortal(<OpsRoot><InviteModal session={session} onClose={() => setShowInvite(false)} /></OpsRoot>, portalHost())}
      {askClose && createPortal(<OpsRoot className="ops-dialog-44"><Dialog
        open={askClose}
        title={meetsMinimum ? L("إغلاق الجلسة؟", "Close the session?") : L("الجلسة دون الحد الأدنى للمقيّمين", "Below the minimum of scorers")}
        onClose={() => { if (!closing) dismissClose(); }}
        actions={<>
          {meetsMinimum ? (
            <Btn variant="danger" busy={closing} onClick={() => submitClose({ kind: "COMPLETE" })}>
              {closing ? L("جارٍ الإغلاق…", "Closing…") : L("إغلاق نهائي", "Close for good")}
            </Btn>
          ) : (
            <Btn variant="danger" busy={closing} disabled={!hasVisibleText(reason)} onClick={() => submitClose({ kind: "INCOMPLETE", reason: reason.trim() })}>
              {closing ? L("جارٍ الإغلاق…", "Closing…") : L("إغلاق كجلسة غير مكتملة", "Close as incomplete")}
            </Btn>
          )}
          <Btn disabled={closing} onClick={dismissClose}>{L("رجوع", "Back")}</Btn>
        </>}
      >
        {closeError ? <Notice tone="danger">{closeError}</Notice> : null}
        <dl className="ops-props">
          <dt>{L("الجلسة", "Session")}</dt><dd>{session.name}</dd>
          <dt>{L("المقيّمون", "Scorers")}</dt>
          <dd data-testid="cupping-close-scorers">
            <span>{scorersOf(session.staffScorers, minScorers, lang)}</span>
            {session.partialScorers > 0 ? <div className="hr-caption" data-testid="cupping-close-partial">{L("لم يُكمل كل الأكواب ولا يُحتسب", "Did not score every cup, not counted")}: {countNoun(session.partialScorers, lang, SCORER_FORMS)}</div> : null}
            {session.guestScorers > 0 ? <div className="hr-caption">{L("ضيوف لا يُحتسبون", "Guests, not counted")}: {countNoun(session.guestScorers, lang, GUEST_FORMS)}</div> : null}
          </dd>
          <dt>{L("التقييمات", "Scores")}</dt>
          <dd>{countNoun(session._count.scores, lang, SCORE_FORMS)}{isMulti ? <> · {countNoun(session.sessionBatches.length, lang, CUP_FORMS)}</> : null}</dd>
          <dt>{L("بعد الإغلاق", "After closing")}</dt>
          <dd>{L("تُكشف الأكواب والمتوسطات للجميع · لا تقييمات جديدة · لا إعادة فتح", "Cups and averages are revealed to everyone · no new scores · no reopening")}</dd>
        </dl>
        {meetsMinimum ? (
          <Notice>{L("الإغلاق لا يغيّر حالة أي دفعة.", "Closing changes no batch status.")}</Notice>
        ) : (
          <>
            <Notice tone="warning">
              <span data-testid="cupping-close-blocked">
                {L(
                  "لا يمكن الإغلاق العادي قبل بلوغ الحد الأدنى من مقيّمي الموظفين الذين قيّموا كل الأكواب. يمكنك إغلاقها كجلسة غير مكتملة مع ذكر السبب: تُحفظ كل التقييمات، وتُميَّز الجلسة بـ«غير مكتملة»، ولا تدخل في النتائج النهائية.",
                  "A normal close needs the minimum of staff scorers who scored every cup. You can close it as incomplete with a reason: every score is kept, the session is marked “Incomplete”, and it is left out of final results.",
                )}
              </span>
            </Notice>
            <label className="hr-field" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="hr-label">{L("سبب الإغلاق كجلسة غير مكتملة", "Reason for closing as incomplete")} *</span>
              <textarea className="hr-textarea" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} aria-required="true" data-testid="cupping-close-reason" />
            </label>
          </>
        )}
      </Dialog></OpsRoot>, portalHost())}
      <tr data-testid={`cupping-session-${session.id}`}>
        <td className="m-title">
          <span className="strong">{session.name}</span>
          <span className="ops-line">
            {/* D-4: FREEZE D1 operational date — «اليوم», «أمس», «5 أكتوبر», Gregorian. */}
            {opsDate(session.date, lang)}
            {isMulti ? <> · {L("تذوق أعمى", "Blind")} · {countNoun(session.sessionBatches.length, lang, CUP_FORMS)}</> : null}
            {session.status === "Open" ? <> · <span data-testid="cupping-row-scorers">{scorersOf(session.staffScorers, minScorers, lang)}</span></> : null}
            <span className="hr-mobile-only"> · {countNoun(session._count.scores, lang, SCORE_FORMS)}</span>
          </span>
        </td>
        <td><span className="hr-caption" style={{ margin: 0 }}>{cups || "—"}</span></td>
        <td className="m-end is-stack">
          {/* E6: «غير مكتملة» marks a session an administrator closed below the minimum. A
              session closed before the policy (closeKind null) keeps the plain «مغلقة». */}
          <StatusDot map={{ Open: [L("مفتوحة", "Open"), "info"], Closed: [L("مغلقة", "Closed"), "success"], Incomplete: [L("غير مكتملة", "Incomplete"), "warning"] }} value={isIncomplete ? "Incomplete" : session.status} />
        </td>
        <td className="num"><span className="hr-num">{session._count.scores}</span></td>
        <td className="ops-actions">
          <Btn size="sm" variant={session.status === "Open" ? "primary" : "secondary"} onClick={() => router.push(`/dashboard/cupping/${session.id}`)}>
            {session.status === "Open" ? L("تقييم / إدارة", "Score / Manage") : L("عرض النتائج", "View Results")}
          </Btn>
          {session.status === "Open" && (
            <Btn size="sm" onClick={() => setShowInvite(true)}><QrCode size={14} aria-hidden="true" /> {L("دعوة", "Invite")}</Btn>
          )}
          {isAdmin && session.status === "Open" && (
            <Btn size="sm" onClick={() => setAskClose(true)}>{L("إغلاق", "Close")}</Btn>
          )}
          {isAdmin && (
            confirmDelete ? (
              <>
                <Btn size="sm" variant="danger" onClick={() => onDelete(session.id)}>{L("تأكيد الحذف", "Confirm")}</Btn>
                <Btn size="sm" variant="ghost" aria-label={L("إلغاء", "Cancel")} onClick={() => setConfirmDelete(false)}><X size={12} aria-hidden="true" /></Btn>
              </>
            ) : (
              <button type="button" className="hr-btn is-ghost is-sm" aria-label={L("حذف الجلسة", "Delete session")} title={L("حذف الجلسة", "Delete session")} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
            )
          )}
        </td>
      </tr>
    </>
  );
}

// ── New Session Modal ─────────────────────────────────────────────────────────

function NewSessionModal({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const L = useL();
  const { lang } = useI18n();
  const [name, setName] = useState("");
  const [batches, setBatches] = useState<AvailableBatch[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [inputTab, setInputTab] = useState<"batches" | "external">("batches");

  const [extName, setExtName] = useState("");
  const [extSupplier, setExtSupplier] = useState("");
  const [externalSamples, setExternalSamples] = useState<{ externalSampleName: string; externalSupplierName: string }[]>([]);

  useEffect(() => {
    fetch("/api/roasting-batches?statuses=Pending+QC,Passed")
      .then((r) => r.json())
      .then((data: AvailableBatch[]) => setBatches(data))
      .catch(() => {})
      .finally(() => setLoadingBatches(false));
  }, []);

  function toggleBatch(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function addExternalSample() {
    if (!extName.trim()) return;
    setExternalSamples((prev) => [
      ...prev,
      { externalSampleName: extName.trim(), externalSupplierName: extSupplier.trim() },
    ]);
    setExtName("");
    setExtSupplier("");
  }

  function removeExternalSample(idx: number) {
    setExternalSamples((prev) => prev.filter((_, i) => i !== idx));
  }

  const totalItems = selectedIds.size + externalSamples.length;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError(L("اسم الجلسة مطلوب.", "Session name is required.")); return; }
    setSaving(true);
    setError("");

    const items: SessionItem[] = [
      ...[...selectedIds].map((id) => {
        const b = batches.find((x) => x.id === id)!;
        return {
          type: "batch" as const,
          batchId: id,
          label: b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? ""),
          sub: b.batchNumber,
        };
      }),
      ...externalSamples.map((s) => ({
        type: "external" as const,
        ...s,
        label: s.externalSampleName,
      })),
    ];

    const body: Record<string, unknown> = { name };
    if (items.length > 0) {
      body.items = items.map((item) =>
        item.type === "batch"
          ? { batchId: item.batchId }
          : { isExternalSample: true, externalSampleName: item.externalSampleName, externalSupplierName: item.externalSupplierName }
      );
    }

    const res = await fetch("/api/cupping/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json();
      setError(j.error || L("تعذّر إنشاء الجلسة.", "Couldn't create the session."));
      setSaving(false);
      return;
    }
    onCreated();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="new-cup-title" className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Fixed header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-0 shrink-0">
          <h2 id="new-cup-title" className="font-extrabold text-charcoal text-lg">{L("جلسة تذوق جديدة", "New cupping session")}</h2>
          <button type="button" aria-label={L("إغلاق", "Close")} onClick={onClose} className="text-brown/40 hover:text-charcoal transition-colors"><X size={20} aria-hidden="true" /></button>
        </div>

        <form onSubmit={handleCreate} className="flex flex-col flex-1 overflow-hidden min-h-0 px-6 pt-4 pb-6 gap-4">

          {/* Session name */}
          <div className="shrink-0">
            <label htmlFor="cup-session-name" className="block text-xs font-bold text-brown/70 uppercase tracking-wide mb-1.5">{L("اسم الجلسة *", "Session name *")}</label>
            <input
              id="cup-session-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={L("مثال: تجربة إثيوبيا المعمّاة — أكتوبر", "e.g. Ethiopia blind trial — October")}
              className="w-full px-4 py-2.5 rounded-xl border-2 border-border bg-cream text-charcoal text-sm focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 transition-colors"
            />
          </div>

          {/* Cart — always visible */}
          <div className="shrink-0">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-bold text-brown/50 uppercase tracking-wide">{L("الأكواب المحددة", "Selected cups")}</p>
              {totalItems > 0 && (
                <span className="text-xs font-extrabold text-orange">{countNoun(totalItems, lang, CUP_FORMS)}</span>
              )}
            </div>
            <div className={`min-h-[46px] px-3 py-2 rounded-xl border-2 transition-colors ${
              totalItems > 0 ? "border-orange/30 bg-orange/5" : "border-dashed border-border bg-cream/40"
            }`}>
              {totalItems === 0 ? (
                <p className="text-xs text-brown/25 py-1.5 text-center select-none">
                  {L("لم تُختر أكواب بعد", "No cups selected yet")}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {[...selectedIds].map((id, i) => {
                    const b = batches.find((x) => x.id === id);
                    const label = b ? (b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? "")) : L("دفعة", "Batch");
                    const sub = b?.batchNumber ?? "";
                    return (
                      <span key={id} className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg bg-orange/10 border border-orange/25 text-xs font-bold text-orange">
                        <span className="text-orange/40 text-[10px] font-mono tabular-nums">{i + 1}.</span>
                        <span className="truncate max-w-[72px]">{label}</span>
                        {sub && <span className="text-orange/40 font-mono text-[10px]">#{sub}</span>}
                        <button type="button" aria-label={L(`إزالة ${label}`, `Remove ${label}`)} onClick={() => toggleBatch(id)} className="ml-0.5 text-orange/40 hover:text-red-500 transition-colors leading-none">
                          <X size={11} />
                        </button>
                      </span>
                    );
                  })}
                  {externalSamples.map((s, i) => (
                    <span key={`ext-${i}`} className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg bg-amber-100 border border-amber-300 text-xs font-bold text-amber-800">
                      <span className="text-amber-500 text-[10px] font-mono tabular-nums">{selectedIds.size + i + 1}.</span>
                      <span className="truncate max-w-[72px]">{s.externalSampleName}</span>
                      <button type="button" aria-label={L(`إزالة ${s.externalSampleName}`, `Remove ${s.externalSampleName}`)} onClick={() => removeExternalSample(i)} className="ml-0.5 text-amber-400 hover:text-red-500 transition-colors leading-none">
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Tab switcher */}
          <div className="shrink-0 flex gap-1 p-1 bg-cream rounded-xl border border-border">
            <button
              type="button"
              onClick={() => setInputTab("batches")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-bold transition-all ${
                inputTab === "batches" ? "bg-white shadow-sm text-charcoal" : "text-brown/50 hover:text-charcoal"
              }`}
            >
              <ClipboardList size={14} aria-hidden="true" />
              {L("حمصات مسجّلة", "Registered roasts")}
            </button>
            <button
              type="button"
              onClick={() => setInputTab("external")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-bold transition-all ${
                inputTab === "external" ? "bg-white shadow-sm text-charcoal" : "text-brown/50 hover:text-charcoal"
              }`}
            >
              <PackagePlus size={14} aria-hidden="true" />
              {L("عيّنة خارجية", "External sample")}
            </button>
          </div>

          {/* Tab content — scrollable */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {inputTab === "batches" ? (
              loadingBatches ? (
                <p className="text-xs text-brown/40 py-8 text-center">{L("جارٍ تحميل الدفعات…", "Loading batches…")}</p>
              ) : batches.length === 0 ? (
                <p className="text-xs text-brown/40 py-8 text-center">{L("لا توجد دفعات بانتظار الجودة أو مقبولة.", "No batches pending QC or passed.")}</p>
              ) : (
                <div className="space-y-1.5 pr-0.5">
                  {batches.map((b) => {
                    const checked = selectedIds.has(b.id);
                    const label = b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? "");
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => toggleBatch(b.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 text-left transition-all ${
                          checked ? "border-orange bg-orange/5" : "border-border hover:border-orange/30"
                        }`}
                      >
                        {checked
                          ? <CheckSquare size={16} className="text-orange shrink-0" />
                          : <Square size={16} className="text-brown/30 shrink-0" />}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-charcoal truncate">{label}</p>
                          <p className="text-[10px] font-mono text-brown/50">
                            {b.batchNumber} · {b.status === "Passed" ? L("مقبولة", "Passed") : b.status === "Pending QC" ? L("بانتظار الجودة", "Pending QC") : b.status}{b.roastProfile ? ` · ${b.roastProfile}` : ""}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )
            ) : (
              <div className="space-y-2.5 pr-0.5 pt-1">
                <input
                  type="text"
                  value={extName}
                  onChange={(e) => setExtName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExternalSample(); } }}
                  aria-label={L("اسم العيّنة *", "Sample name *")}
                  placeholder={L("اسم العيّنة *", "Sample name *")}
                  className="w-full px-3 py-2.5 rounded-xl border-2 border-border bg-cream text-sm focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 transition-colors"
                />
                <input
                  type="text"
                  value={extSupplier}
                  onChange={(e) => setExtSupplier(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExternalSample(); } }}
                  aria-label={L("المورد (اختياري)", "Supplier (optional)")}
                  placeholder={L("المورد (اختياري)", "Supplier (optional)")}
                  className="w-full px-3 py-2.5 rounded-xl border-2 border-border bg-cream text-sm focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 transition-colors"
                />
                <button
                  type="button"
                  onClick={addExternalSample}
                  disabled={!extName.trim()}
                  className="w-full py-2.5 rounded-xl bg-charcoal text-white text-sm font-bold hover:bg-charcoal/80 transition-colors disabled:opacity-40"
                >
                  {L("+ إضافة العيّنة", "+ Add sample")}
                </button>
                {externalSamples.length === 0 && (
                  <p className="text-xs text-brown/30 text-center pt-4 pb-2">
                    {L("اكتب اسمًا ثم اضغط «إضافة».", "Enter a name, then press Add.")}<br />
                    {L("تظهر العيّنات المضافة في قائمة الأكواب أعلاه.", "Added samples appear in the cup list above.")}
                  </p>
                )}
              </div>
            )}
          </div>

          {error && <p className="text-xs text-red-500 font-medium shrink-0">{error}</p>}

          {/* Fixed footer */}
          <div className="flex gap-2 shrink-0 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border-2 border-border text-sm font-bold text-brown hover:bg-gray-50 transition-colors"
            >
              {L("إلغاء", "Cancel")}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-orange text-white text-sm font-bold hover:bg-orange/90 transition-colors disabled:opacity-50"
            >
              {saving ? L("جارٍ الإنشاء…", "Creating…") : totalItems > 0 ? L(`إنشاء الجلسة (${countNoun(totalItems, "ar", CUP_FORMS)})`, `Create session (${countNoun(totalItems, "en", CUP_FORMS)})`) : L("إنشاء الجلسة", "Create session")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function CuppingPage() {
  const user = useUser();
  const L = useL();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [tab, setTab] = useState<"active" | "history">("active");

  const isAdmin = user?.role === "admin";
  const canCreateSession = canEdit(user?.permissions ?? {}, "cupping");

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/cupping/sessions");
    if (res.ok) { setSessions(await res.json()); setLoadError(false); }
    else { await res.text(); setLoadError(true); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  async function handleClose(id: string, req: CloseRequest): Promise<CloseResult> {
    const res = await fetch(`/api/cupping/sessions/${id}/close`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (res.ok) { fetchSessions(); return { ok: true }; }
    const j: { code?: string } = await res.json().catch(() => ({}));
    // The counts may have moved since the list loaded (a score arrived, the minimum changed,
    // someone else closed it): refresh so the dialog shows the server's figures.
    fetchSessions();
    const message =
      j.code === "CUPPING_MIN_SCORERS_NOT_MET" ? L("لم يبلغ عدد المقيّمين الحد الأدنى بعد، فلا يمكن الإغلاق العادي.", "The session has not reached the minimum of scorers, so it cannot be closed normally.")
      : j.code === "CUPPING_MIN_SCORERS_MET" ? L("بلغت الجلسة الحد الأدنى للمقيّمين؛ أغلقها إغلاقًا عاديًا.", "The session meets the minimum of scorers; close it normally.")
      : j.code === "CUPPING_INCOMPLETE_REASON_REQUIRED" ? L("اكتب سبب الإغلاق كجلسة غير مكتملة.", "Write the reason for closing as incomplete.")
      : j.code === "CUPPING_ALREADY_CLOSED" ? L("أُغلقت هذه الجلسة مسبقًا.", "This session is already closed.")
      : res.status === 403 ? L("الإغلاق للمشرف فقط.", "Only an administrator can close a session.")
      : L("تعذّر إغلاق الجلسة. لم يتغير شيء.", "The session could not be closed. Nothing changed.");
    return { ok: false, code: j.code, message };
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/cupping/sessions/${id}`, { method: "DELETE" });
    if (res.ok) setSessions((p) => p.filter((s) => s.id !== id));
  }

  const activeSessions = sessions.filter((s) => s.status === "Open");
  const historySessions = sessions.filter((s) => s.status === "Closed");

  const list = tab === "active" ? activeSessions : historySessions;

  return (
    <OpsRoot>
    <div className="hr-page">
      {showModal && (
        <NewSessionModal
          onCreated={() => { setShowModal(false); fetchSessions(); }}
          onClose={() => setShowModal(false)}
        />
      )}

      <PageHeader
        title={L("التذوق", "Cupping")} // N-25: the nav and crumb name (D-7)
        actions={canCreateSession ? (
          <Btn variant="primary" onClick={() => setShowModal(true)}><Plus size={16} aria-hidden="true" /> {L("جلسة جديدة", "New session")}</Btn>
        ) : null}
      >
        <span>{L("تقييم حسّي جماعي بنموذج SCA · لا يغيّر حالة الدفعة", "Specialty Coffee Association — collaborative sensory evaluation · does not change a batch's status")}</span>
      </PageHeader>

      <Tabs
        label={L("جلسات التذوق", "Cupping sessions")}
        value={tab}
        onChange={(k) => setTab(k)}
        items={[
          { key: "active", label: L("قائمة التقييم النشطة", "Active sessions"), count: activeSessions.length },
          { key: "history", label: L("سجل التذوق", "Cupping history"), count: historySessions.length },
        ]}
      />

      {loadError ? (
        <OpsError message={L("تعذّر تحميل جلسات التذوق.", "Cupping sessions could not be loaded.")} onRetry={fetchSessions} />
      ) : loading ? (
        <OpsLoading rows={4} label={L("جارٍ تحميل الجلسات…", "Loading sessions…")} />
      ) : list.length === 0 ? (
        tab === "active" ? (
          <OpsEmpty title={L("لا توجد جلسات نشطة", "No active sessions")} body={isAdmin ? L("أنشئ جلسة وادعُ الفريق للتقييم.", "Create a session and invite the team to score.") : undefined} />
        ) : (
          <OpsEmpty title={L("لا توجد جلسات مكتملة بعد", "No completed sessions yet")} body={L("تظهر هنا الجلسات المغلقة مع نتائجها.", "Closed sessions with their results will appear here.")} />
        )
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow ops-qc" aria-label={L("جلسات التذوق", "Cupping sessions")}>
            <thead>
              <tr>
                <th>{L("الجلسة", "Session")}</th>
                <th>{L("الأكواب", "Cups")}</th>
                <th>{L("الحالة", "Status")}</th>
                <th className="num">{L("التقييمات", "Scores")}</th>
                <th aria-label={L("الإجراءات", "Actions")} />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <SessionCard key={s.id} session={s} isAdmin={isAdmin} onClose={handleClose} onDelete={handleDelete} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </OpsRoot>
  );
}
