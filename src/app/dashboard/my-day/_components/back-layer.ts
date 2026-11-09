"use client";

// D16 gate («أبو فهد», phone): the device / browser Back button while a sheet or the planner is open must close it (or go
// back one step), not leave the page and lose what was typed. A sheet keeps `depth` history entries of its own above the
// page's: opening (or moving a step forward) pushes one, Back pops one and calls `onBack`, and closing from the screen
// (✕, «إلغاء», saved) takes its entries back off. The entries copy the page's own history state (the router keeps its
// tree there) and carry the layer's id.
//
// Gate C1: entries are taken back off ONLY while the current entry is still this layer's own — a link followed from inside
// the sheet (the customer page) or a URL rewrite leaves history alone, so the page never bounces back. Gate C2: an entry of
// a layer that no longer exists (a reload while a sheet was open) is cleared by `useDropStaleLayer` on the page.
import { useEffect, useId, useRef, useState } from "react";

/** The ids of the layers mounted now (a stale entry is one whose id is not here). */
const LIVE = new Set<string>();
type LayerState = { kpLayer?: string; kpDepth?: number } & Record<string, unknown>;
const current = () => (typeof window === "undefined" ? null : (window.history.state as LayerState | null));

/**
 * `opts.guard` (D18, Abu Fahd 3): asked before Back closes — false keeps the sheet open (its history entry is put back).
 */
export function useBackLayer(depth: number, onBack: () => void, opts: { cleanUrl?: string; guard?: () => boolean } = {}) {
  // Unique per sheet instance and session: React's useId repeats across pages (the stale-entry guard keys on it).
  const reactId = useId();
  const [id] = useState(() => `${reactId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const pushed = useRef(0);
  const ignore = useRef(0);
  const cb = useRef(onBack);
  const guard = useRef(opts.guard);
  useEffect(() => { guard.current = opts.guard; }, [opts.guard]);
  const cleanUrl = useRef(opts.cleanUrl);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ours = () => current()?.kpLayer === id;
  useEffect(() => { cb.current = onBack; }, [onBack]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Opened by a deep link (`?add=plan`): the page's own entry loses the parameter first, so neither Back nor a reload
    // opens the sheet again (gate C1).
    if (pushed.current === 0 && depth > 0 && cleanUrl.current) {
      window.history.replaceState(window.history.state, "", cleanUrl.current);
      cleanUrl.current = undefined;
    }
    while (pushed.current < depth) {
      pushed.current += 1;
      window.history.pushState({ ...(current() ?? {}), kpLayer: id, kpDepth: pushed.current }, "");
    }
    if (pushed.current > depth) {
      // A step back from the screen («رجوع»): drop our extra entries — only if we are still on top.
      const n = pushed.current - depth;
      pushed.current = depth;
      if (ours()) { ignore.current += 1; window.history.go(-n); }
    }
  }, [depth, id]); // eslint-disable-line react-hooks/exhaustive-deps -- `ours` reads the live history state
  useEffect(() => {
    // React's development double mount runs this cleanup and set-up back to back: a pending «take the entries off» is
    // cancelled when the same sheet mounts again, so it is not closed by its own Back.
    if (pending.current) { clearTimeout(pending.current); pending.current = null; }
    LIVE.add(id);
    const onPop = () => {
      if (ignore.current > 0) { ignore.current -= 1; return; }
      if (pushed.current <= 0) return;
      pushed.current -= 1;
      if (guard.current && !guard.current()) {
        pushed.current += 1;
        window.history.pushState({ ...(current() ?? {}), kpLayer: id, kpDepth: pushed.current }, "");
        return;
      }
      cb.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      pending.current = setTimeout(() => {
        pending.current = null;
        LIVE.delete(id);
        // Closed from the screen: take our entries back off — unless the page has moved on (a link, a URL rewrite).
        if (pushed.current > 0 && current()?.kpLayer === id) { const n = pushed.current; pushed.current = 0; window.history.go(-n); }
        else pushed.current = 0;
      }, 0);
    };
  }, [id]);
}

/**
 * On the page (gate C2): after a reload with a sheet open, the browser still holds that sheet's entries on top of the
 * page's own — a Back would only "close" a sheet that is no longer there. When the current entry belongs to no live layer,
 * step back over the layer's entries once (kpDepth of them) to the page's own entry. Guarded: once per layer id (session
 * storage), so it can never loop.
 */
export function useDropStaleLayer() {
  useEffect(() => {
    const t = setTimeout(() => {
      const s = current();
      if (!s?.kpLayer || LIVE.has(s.kpLayer)) return;
      const key = `kp-stale-${s.kpLayer}`;
      let seen = false;
      try { seen = window.sessionStorage.getItem(key) === "1"; window.sessionStorage.setItem(key, "1"); } catch { /* private mode: the state check below still stops a loop */ }
      if (seen) {
        // Already stepped back once for this layer: make this entry plain instead of going back again.
        const rest: Record<string, unknown> = { ...s };
        delete rest.kpLayer; delete rest.kpDepth;
        window.history.replaceState(rest, "");
        return;
      }
      window.history.go(-Math.max(1, Number(s.kpDepth) || 1));
    }, 0);
    return () => clearTimeout(t);
  }, []);
}
