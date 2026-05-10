"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, Plus, Users, Lock, LockOpen, ChevronRight, Trash2, X, Link2, Check, QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useUser } from "@/app/dashboard/layout";

type Session = {
  id: string;
  name: string;
  date: string;
  status: "Open" | "Closed";
  batchId: string | null;
  greenBeanId: string | null;
  batch: { batchNumber: string } | null;
  greenBean: { serialNumber: string; beanType: string } | null;
  _count: { scores: number };
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold ${
        status === "Open"
          ? "bg-green-100 text-green-700"
          : "bg-gray-100 text-gray-500"
      }`}
    >
      {status === "Open" ? <LockOpen size={10} /> : <Lock size={10} />}
      {status}
    </span>
  );
}

function InviteModal({ sessionId, sessionName, onClose }: { sessionId: string; sessionName: string; onClose: () => void }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => { setOrigin(window.location.origin); }, []);

  const guestUrl = `${origin}/guest-cupping/${sessionId}`;

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
            <p className="text-xs text-brown/50 mt-0.5 truncate max-w-[200px]">{sessionName}</p>
          </div>
          <button onClick={onClose} className="text-brown/40 hover:text-charcoal transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* QR Code */}
        {origin && (
          <div className="flex justify-center p-4 bg-cream rounded-xl border border-border">
            <QRCodeSVG
              value={guestUrl}
              size={180}
              bgColor="#FAF6F0"
              fgColor="#2C1A0E"
              level="M"
            />
          </div>
        )}

        {/* URL + Copy */}
        <div className="space-y-2">
          <p className="text-xs font-bold text-brown/50 uppercase tracking-wide">Guest Link</p>
          <div className="flex gap-2">
            <div className="flex-1 min-w-0 px-3 py-2.5 bg-cream border border-border rounded-xl">
              <p className="text-xs text-charcoal truncate font-medium">{guestUrl}</p>
            </div>
            <button
              onClick={handleCopy}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold transition-all ${
                copied
                  ? "bg-green-500 text-white"
                  : "bg-charcoal text-white hover:bg-charcoal/80"
              }`}
            >
              {copied ? <><Check size={13} /> Copied!</> : <><Link2 size={13} /> Copy</>}
            </button>
          </div>
          <p className="text-[10px] text-brown/40">
            Guests can scan the QR code or open this link on their phone to score without an account.
          </p>
        </div>
      </div>
    </div>
  );
}

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

  async function handleClose() {
    setClosing(true);
    await onClose(session.id);
    setClosing(false);
  }

  return (
    <>
      {showInvite && (
        <InviteModal
          sessionId={session.id}
          sessionName={session.name}
          onClose={() => setShowInvite(false)}
        />
      )}

      <div className="bg-white rounded-2xl border border-border p-5 hover:shadow-sm transition-shadow">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-extrabold text-charcoal truncate">{session.name}</h3>
              <StatusBadge status={session.status} />
            </div>
            <div className="mt-1 space-y-0.5 text-xs text-brown/60">
              <p>{new Date(session.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</p>
              {session.batch && <p>Batch: <span className="font-medium text-charcoal">{session.batch.batchNumber}</span></p>}
              {session.greenBean && <p>Bean: <span className="font-medium text-charcoal">{session.greenBean.beanType} #{session.greenBean.serialNumber}</span></p>}
            </div>
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
            {session.status === "Open" ? "Score This Session" : "View Results"}
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
              onClick={handleClose}
              disabled={closing}
              className="px-4 py-2.5 rounded-xl bg-charcoal text-white text-sm font-bold hover:bg-charcoal/80 transition-colors disabled:opacity-50"
            >
              {closing ? "Closing…" : "Close"}
            </button>
          )}

          {isAdmin && (
            confirmDelete ? (
              <div className="flex gap-1">
                <button
                  onClick={() => onDelete(session.id)}
                  className="px-3 py-2 rounded-xl bg-red-500 text-white text-xs font-bold"
                >Confirm</button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-2 rounded-xl border border-border text-xs font-bold"
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="p-2.5 rounded-xl border border-border text-brown/40 hover:text-red-500 hover:border-red-200 transition-colors"
              >
                <Trash2 size={15} />
              </button>
            )
          )}
        </div>
      </div>
    </>
  );
}

function NewSessionModal({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    setError("");
    const res = await fetch("/api/cupping/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
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
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-extrabold text-charcoal text-lg">New Cupping Session</h2>
          <button onClick={onClose} className="text-brown/40 hover:text-charcoal transition-colors">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1.5">
              Session Name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ethiopia Yirgacheffe — Blind Trial"
              className="w-full px-4 py-2.5 rounded-xl border-2 border-border bg-cream text-charcoal text-sm focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 transition-colors"
            />
          </div>
          {error && <p className="text-xs text-red-500 font-medium">{error}</p>}
          <div className="flex gap-2">
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
              {saving ? "Creating…" : "Create Session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function CuppingPage() {
  const user = useUser();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

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

  const open = sessions.filter((s) => s.status === "Open");
  const closed = sessions.filter((s) => s.status === "Closed");

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {showModal && (
        <NewSessionModal
          onCreated={() => { setShowModal(false); fetchSessions(); }}
          onClose={() => setShowModal(false)}
        />
      )}

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

      {loading ? (
        <div className="text-center py-16 text-brown/40 text-sm">Loading sessions…</div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl border border-border">
          <FlaskConical size={36} className="text-orange/30 mx-auto mb-3" />
          <p className="font-bold text-charcoal">No sessions yet</p>
          {isAdmin && (
            <p className="text-sm text-brown/50 mt-1">Create a session and invite the team to score.</p>
          )}
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-extrabold text-brown/50 uppercase tracking-widest">Open Sessions</h2>
              {open.map((s) => (
                <SessionCard key={s.id} session={s} isAdmin={isAdmin} onClose={handleClose} onDelete={handleDelete} />
              ))}
            </section>
          )}

          {closed.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-extrabold text-brown/50 uppercase tracking-widest">Closed Sessions</h2>
              {closed.map((s) => (
                <SessionCard key={s.id} session={s} isAdmin={isAdmin} onClose={handleClose} onDelete={handleDelete} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
