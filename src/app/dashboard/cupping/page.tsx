"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  FlaskConical, Plus, Users, Lock, LockOpen, ChevronRight, Trash2, X,
  Link2, Check, QrCode, Coffee, History, ClipboardList, CheckSquare, Square,
  PackagePlus,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useUser } from "@/app/dashboard/layout";

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
    orderItem: { beanTypeName: string };
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
};

type AvailableBatch = {
  id: string;
  batchNumber: string;
  status: string;
  roastProfile: string | null;
  greenBean: { beanType: string; serialNumber: string } | null;
  orderItem: { beanTypeName: string; order: { orderNumber: number } };
};

// ── Invite Modal ──────────────────────────────────────────────────────────────

function InviteModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => { setOrigin(window.location.origin); }, []);

  const isMulti = session.sessionBatches.length > 0;
  const guestUrl = isMulti
    ? `${origin}/guest-cupping/session/${session.sessionToken}`
    : `${origin}/guest-cupping/${session.id}`;

  async function handleCopy() {
    await navigator.clipboard.writeText(guestUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-extrabold text-charcoal text-lg">Invite Guests</h2>
            <p className="text-xs text-brown/50 mt-0.5 truncate max-w-[220px]">{session.name}</p>
          </div>
          <button onClick={onClose} className="text-brown/40 hover:text-charcoal transition-colors">
            <X size={20} />
          </button>
        </div>

        {isMulti && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800 font-medium">
            🔒 Blind session — guests see <strong>Cup 1, Cup 2…</strong> only, not bean names.
          </div>
        )}

        {origin && (
          <div className="flex justify-center p-4 bg-cream rounded-xl border border-border">
            <QRCodeSVG value={guestUrl} size={180} bgColor="#FAF6F0" fgColor="#2C1A0E" level="M" />
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-bold text-brown/50 uppercase tracking-wide">Guest Link</p>
          <div className="flex gap-2">
            <div className="flex-1 min-w-0 px-3 py-2.5 bg-cream border border-border rounded-xl">
              <p className="text-xs text-charcoal truncate font-medium">{guestUrl}</p>
            </div>
            <button
              onClick={handleCopy}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold transition-all ${
                copied ? "bg-green-500 text-white" : "bg-charcoal text-white hover:bg-charcoal/80"
              }`}
            >
              {copied ? <><Check size={13} /> Copied!</> : <><Link2 size={13} /> Copy</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Session Card ──────────────────────────────────────────────────────────────

function SessionCard({
  session,
  isAdmin,
  onClose,
  onDelete,
}: {
  session: Session;
  isAdmin: boolean;
  onClose: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showInvite, setShowInvite] = useState(false);

  const isMulti = session.sessionBatches.length > 0;

  return (
    <>
      {showInvite && <InviteModal session={session} onClose={() => setShowInvite(false)} />}
      <div className="bg-white rounded-2xl border border-border p-5 hover:shadow-sm transition-shadow">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-extrabold text-charcoal truncate">{session.name}</h3>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold ${
                session.status === "Open" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
              }`}>
                {session.status === "Open" ? <LockOpen size={10} /> : <Lock size={10} />}
                {session.status}
              </span>
              {isMulti && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700">
                  🔒 Blind · {session.sessionBatches.length} cups
                </span>
              )}
            </div>
            <p className="text-xs text-brown/50 mt-1">
              {new Date(session.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
            </p>
            {isMulti ? (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {session.sessionBatches.map((sb, i) => (
                  <span key={sb.id} className="px-1.5 py-0.5 bg-cream border border-border rounded text-[10px] font-mono text-brown/60">
                    {sb.isExternalSample
                      ? `Cup ${i + 1}: ${sb.externalSampleName ?? "External"}`
                      : `Cup ${i + 1}: ${sb.batch?.batchNumber ?? "—"}`}
                  </span>
                ))}
              </div>
            ) : (
              <>
                {session.batch && <p className="text-xs text-brown/60 mt-0.5">Batch: <span className="font-medium text-charcoal">{session.batch.batchNumber}</span></p>}
                {session.greenBean && <p className="text-xs text-brown/60 mt-0.5">Bean: <span className="font-medium text-charcoal">{session.greenBean.beanType} #{session.greenBean.serialNumber}</span></p>}
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-brown/50 shrink-0">
            <Users size={13} />
            <span className="text-xs font-bold">{session._count.scores}</span>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <button
            onClick={() => router.push(`/dashboard/cupping/${session.id}`)}
            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-orange text-white text-sm font-bold hover:bg-orange/90 transition-colors"
          >
            {session.status === "Open" ? "Score / Manage" : "View Results"}
            <ChevronRight size={14} />
          </button>

          {session.status === "Open" && (
            <button
              onClick={() => setShowInvite(true)}
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border-2 border-border text-sm font-bold text-brown hover:border-orange/40 hover:text-orange transition-colors"
            >
              <QrCode size={15} />
              Invite
            </button>
          )}

          {isAdmin && session.status === "Open" && (
            <button
              onClick={async () => { setClosing(true); await onClose(session.id); setClosing(false); }}
              disabled={closing}
              className="px-4 py-2.5 rounded-xl bg-charcoal text-white text-sm font-bold hover:bg-charcoal/80 transition-colors disabled:opacity-50"
            >
              {closing ? "Closing…" : "Close"}
            </button>
          )}

          {isAdmin && (
            confirmDelete ? (
              <div className="flex gap-1">
                <button onClick={() => onDelete(session.id)} className="px-3 py-2 rounded-xl bg-red-500 text-white text-xs font-bold">Confirm</button>
                <button onClick={() => setConfirmDelete(false)} className="px-3 py-2 rounded-xl border border-border text-xs font-bold"><X size={12} /></button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="p-2.5 rounded-xl border border-border text-brown/40 hover:text-red-500 hover:border-red-200 transition-colors">
                <Trash2 size={15} />
              </button>
            )
          )}
        </div>
      </div>
    </>
  );
}

// ── New Session Modal ─────────────────────────────────────────────────────────

function NewSessionModal({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
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
    if (!name.trim()) { setError("Session name is required"); return; }
    setSaving(true);
    setError("");

    const items: SessionItem[] = [
      ...[...selectedIds].map((id) => {
        const b = batches.find((x) => x.id === id)!;
        return {
          type: "batch" as const,
          batchId: id,
          label: b.greenBean?.beanType || b.orderItem.beanTypeName,
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
      setError(j.error || "Failed to create session");
      setSaving(false);
      return;
    }
    onCreated();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Fixed header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-0 shrink-0">
          <h2 className="font-extrabold text-charcoal text-lg">New Cupping Session</h2>
          <button onClick={onClose} className="text-brown/40 hover:text-charcoal transition-colors"><X size={20} /></button>
        </div>

        <form onSubmit={handleCreate} className="flex flex-col flex-1 overflow-hidden min-h-0 px-6 pt-4 pb-6 gap-4">

          {/* Session name */}
          <div className="shrink-0">
            <label className="block text-xs font-bold text-brown/70 uppercase tracking-wide mb-1.5">* Session Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ethiopia Blind Trial — May 2025"
              className="w-full px-4 py-2.5 rounded-xl border-2 border-border bg-cream text-charcoal text-sm focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 transition-colors"
            />
          </div>

          {/* Cart — always visible */}
          <div className="shrink-0">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-bold text-brown/50 uppercase tracking-wide">الأكواب المحددة — Selected Cups</p>
              {totalItems > 0 && (
                <span className="text-xs font-extrabold text-orange">{totalItems} cup{totalItems !== 1 ? "s" : ""}</span>
              )}
            </div>
            <div className={`min-h-[46px] px-3 py-2 rounded-xl border-2 transition-colors ${
              totalItems > 0 ? "border-orange/30 bg-orange/5" : "border-dashed border-border bg-cream/40"
            }`}>
              {totalItems === 0 ? (
                <p className="text-xs text-brown/25 py-1.5 text-center select-none">
                  No cups selected yet — لم يتم اختيار أكواب بعد
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {[...selectedIds].map((id, i) => {
                    const b = batches.find((x) => x.id === id);
                    const label = b ? (b.greenBean?.beanType || b.orderItem.beanTypeName) : "Batch";
                    const sub = b?.batchNumber ?? "";
                    return (
                      <span key={id} className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg bg-orange/10 border border-orange/25 text-xs font-bold text-orange">
                        <span className="text-orange/40 text-[10px] font-mono tabular-nums">{i + 1}.</span>
                        <span className="truncate max-w-[72px]">{label}</span>
                        {sub && <span className="text-orange/40 font-mono text-[10px]">#{sub}</span>}
                        <button type="button" onClick={() => toggleBatch(id)} className="ml-0.5 text-orange/40 hover:text-red-500 transition-colors leading-none">
                          <X size={11} />
                        </button>
                      </span>
                    );
                  })}
                  {externalSamples.map((s, i) => (
                    <span key={`ext-${i}`} className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg bg-amber-100 border border-amber-300 text-xs font-bold text-amber-800">
                      <span className="text-amber-500 text-[10px] font-mono tabular-nums">{selectedIds.size + i + 1}.</span>
                      <span className="truncate max-w-[72px]">{s.externalSampleName}</span>
                      <button type="button" onClick={() => removeExternalSample(i)} className="ml-0.5 text-amber-400 hover:text-red-500 transition-colors leading-none">
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
              <ClipboardList size={14} />
              حمصات مسجلة
            </button>
            <button
              type="button"
              onClick={() => setInputTab("external")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-bold transition-all ${
                inputTab === "external" ? "bg-white shadow-sm text-charcoal" : "text-brown/50 hover:text-charcoal"
              }`}
            >
              <PackagePlus size={14} />
              عينة جديدة / خارجية
            </button>
          </div>

          {/* Tab content — scrollable */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {inputTab === "batches" ? (
              loadingBatches ? (
                <p className="text-xs text-brown/40 py-8 text-center">Loading batches…</p>
              ) : batches.length === 0 ? (
                <p className="text-xs text-brown/40 py-8 text-center">No eligible batches found.</p>
              ) : (
                <div className="space-y-1.5 pr-0.5">
                  {batches.map((b) => {
                    const checked = selectedIds.has(b.id);
                    const label = b.greenBean?.beanType || b.orderItem.beanTypeName;
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
                            {b.batchNumber} · {b.status}{b.roastProfile ? ` · ${b.roastProfile}` : ""}
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
                  placeholder="Sample Name — اسم العينة *"
                  className="w-full px-3 py-2.5 rounded-xl border-2 border-border bg-cream text-sm focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 transition-colors"
                />
                <input
                  type="text"
                  value={extSupplier}
                  onChange={(e) => setExtSupplier(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExternalSample(); } }}
                  placeholder="Supplier — المورد (optional)"
                  className="w-full px-3 py-2.5 rounded-xl border-2 border-border bg-cream text-sm focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 transition-colors"
                />
                <button
                  type="button"
                  onClick={addExternalSample}
                  disabled={!extName.trim()}
                  className="w-full py-2.5 rounded-xl bg-charcoal text-white text-sm font-bold hover:bg-charcoal/80 transition-colors disabled:opacity-40"
                >
                  + إضافة العينة — Add Sample
                </button>
                {externalSamples.length === 0 && (
                  <p className="text-xs text-brown/30 text-center pt-4 pb-2">
                    Enter a name above and press Add.<br />
                    Added samples appear in the cup list above.
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
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-orange text-white text-sm font-bold hover:bg-orange/90 transition-colors disabled:opacity-50"
            >
              {saving ? "Creating…" : totalItems > 0 ? `إنشاء الجلسة (${totalItems} أكواب)` : "إنشاء الجلسة"}
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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [tab, setTab] = useState<"active" | "history">("active");

  const isAdmin = user?.role === "admin";

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/cupping/sessions");
    if (res.ok) setSessions(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  async function handleClose(id: string) {
    const res = await fetch(`/api/cupping/sessions/${id}/close`, { method: "PUT" });
    if (res.ok) fetchSessions();
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/cupping/sessions/${id}`, { method: "DELETE" });
    if (res.ok) setSessions((p) => p.filter((s) => s.id !== id));
  }

  const activeSessions = sessions.filter((s) => s.status === "Open");
  const historySessions = sessions.filter((s) => s.status === "Closed");

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {showModal && (
        <NewSessionModal
          onCreated={() => { setShowModal(false); fetchSessions(); }}
          onClose={() => setShowModal(false)}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal flex items-center gap-3">
            <FlaskConical className="text-orange" size={28} />
            SCA Cupping
          </h1>
          <p className="text-brown text-sm mt-1">Specialty Coffee Association — Collaborative Sensory Evaluation</p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setShowModal(true)}
            className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-orange text-white text-sm font-bold hover:bg-orange/90 transition-colors shadow-sm"
          >
            <Plus size={16} />
            New Session
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab("active")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all ${
            tab === "active" ? "bg-charcoal text-white" : "bg-white border border-border text-brown hover:border-slate-300"
          }`}
        >
          <ClipboardList size={15} />
          قائمة التقييم النشطة
          {activeSessions.length > 0 && (
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-extrabold ${tab === "active" ? "bg-white/20 text-white" : "bg-orange/10 text-orange"}`}>
              {activeSessions.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab("history")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all ${
            tab === "history" ? "bg-charcoal text-white" : "bg-white border border-border text-brown hover:border-slate-300"
          }`}
        >
          <History size={15} />
          سجل التذوق
          {historySessions.length > 0 && (
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-extrabold ${tab === "history" ? "bg-white/20 text-white" : "bg-gray-100 text-gray-500"}`}>
              {historySessions.length}
            </span>
          )}
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-brown/40 text-sm">Loading sessions…</div>
      ) : tab === "active" ? (
        activeSessions.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-2xl border border-border">
            <Coffee size={36} className="text-orange/30 mx-auto mb-3" />
            <p className="font-bold text-charcoal">No active sessions</p>
            {isAdmin && <p className="text-sm text-brown/50 mt-1">Create a session and invite the team to score.</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {activeSessions.map((s) => (
              <SessionCard key={s.id} session={s} isAdmin={isAdmin} onClose={handleClose} onDelete={handleDelete} />
            ))}
          </div>
        )
      ) : (
        historySessions.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-2xl border border-border">
            <History size={36} className="text-brown/20 mx-auto mb-3" />
            <p className="font-bold text-charcoal">No completed sessions yet</p>
            <p className="text-sm text-brown/50 mt-1">Closed sessions with their results will appear here.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {historySessions.map((s) => (
              <SessionCard key={s.id} session={s} isAdmin={isAdmin} onClose={handleClose} onDelete={handleDelete} />
            ))}
          </div>
        )
      )}
    </div>
  );
}
