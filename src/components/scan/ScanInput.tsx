"use client";
/**
 * ONE scan input for the whole application (20261114090000_green_lot_labels): counts, receiving, the roast sheet, the
 * roasting station and the inventory search all use it.
 *
 *   · A keyboard-wedge scanner (USB / Bluetooth: fast keystrokes, then Enter) — typed into the field, or anywhere on
 *     the page with `listen` (while focus is not in a text field: a burst of keys is caught before it lands in a
 *     quantity box). The Arabic keyboard layout is mapped back (src/lib/scan/codes.ts).
 *   · The phone / tablet camera — «الكاميرا»: the browser's BarcodeDetector where it exists (Chrome on Android), the
 *     ZXing decoder otherwise (iOS Safari, desktop), loaded only when the camera opens.
 *   · A person typing the code and pressing Enter.
 * The parent resolves the code (usually through /api/scan: lookupScanCode below) and returns the line to show.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ScanLine } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { normalizeScan } from "@/lib/scan/codes";
import { WedgeDetector } from "@/lib/scan/wedge";
import { CameraScan } from "./CameraScan";
import "./scan.css";

export type ScanFeedback = { tone: "success" | "danger" | "info" | "warning"; text: string };
type Lang = "ar" | "en";

const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", ""]);
/** A field a person types words into: a scan never takes it over. Number inputs are not (a code has letters). */
function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  // A quantity box (a weight field with inputMode decimal / numeric) is not: a code's letters never belong in it.
  if (el.tagName === "INPUT" && ["decimal", "numeric"].includes((el as HTMLInputElement).inputMode)) return false;
  return el.tagName === "INPUT" && TEXT_TYPES.has(((el as HTMLInputElement).type ?? "").toLowerCase());
}

/**
 * Page-wide keyboard-wedge capture: a burst of keys ended by Enter, while focus is not in a text field. Keys of a burst
 * — and any letter, which no quantity box takes anyway — are kept out of the focused control.
 */
export function useWedgeScanner(onScan: (code: string) => void, enabled = true) {
  const cb = useRef(onScan);
  useEffect(() => { cb.current = onScan; });
  useEffect(() => {
    if (!enabled) return;
    const d = new WedgeDetector();
    // A burst that starts with a letter is a label code (GL-… / MT-…, or its Arabic-layout letters): its keys never reach
    // the focused control. A burst of digits typed into a quantity box is the person's quantity — left alone, and only
    // a scan when focus is on no field at all.
    let letterLed = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-scan-own]") || isTextField(target)) { d.reset(); letterLed = false; return; }
      const inField = !!target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
      const t = e.timeStamp || performance.now();
      if (e.key === "Enter" || e.key === "Tab") {
        const code = d.push(e.key, t);
        if (code && (letterLed || !inField)) { e.preventDefault(); e.stopPropagation(); cb.current(code); }
        letterLed = false;
        return;
      }
      if (e.key.length !== 1) { d.push(e.key, t); return; }
      const letter = !/[0-9.,]/.test(e.key);
      // A letter right after typed digits starts a scan of its own (a quantity, then at once the next label).
      if (!d.active(t) || (letter && !letterLed)) { d.reset(); letterLed = letter; }
      d.push(e.key, t);
      if (letterLed) e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}

export function ScanInput({ onCode, listen = false, placeholder, label, testId = "scan", lang: langProp, compact, autoFocus, disabled, camera = true }: {
  /** The code as scanned (normalized); return the line to show under the field. */
  onCode: (code: string) => Promise<ScanFeedback | void> | ScanFeedback | void;
  /** Also catch a wedge scanner anywhere on the page (counts, the roast draw). */
  listen?: boolean;
  placeholder?: string;
  label?: string;
  testId?: string;
  lang?: Lang;
  compact?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  camera?: boolean;
}) {
  const { lang: ctxLang } = useI18n();
  const lang: Lang = langProp ?? (ctxLang === "en" ? "en" : "ar");
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [fb, setFb] = useState<ScanFeedback | null>(null);
  const [cam, setCam] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(async (raw: string) => {
    const code = normalizeScan(raw);
    if (!code) return;
    setBusy(true);
    try {
      const r = await onCode(code);
      setFb(r ?? null);
    } catch {
      setFb({ tone: "danger", text: lang === "ar" ? "تعذّر قراءة الرمز. حاول مرة أخرى." : "Could not read the code. Try again." });
    } finally {
      setBusy(false);
      setValue("");
    }
  }, [onCode, lang]);

  useWedgeScanner((code) => { if (!disabled) void submit(code); }, listen && !disabled);

  return (
    <div className={`scn${compact ? " is-compact" : ""}`} data-scan-own="" data-testid={testId}>
      <div className="scn-row">
        <label className="scn-field">
          <ScanLine size={18} aria-hidden="true" className="scn-ico" />
          <span className="hr-sr">{label ?? L("امسح الباركود أو اكتب الرمز", "Scan a barcode or type the code")}</span>
          <input ref={inputRef} className="hr-input scn-input" dir="ltr" inputMode="text" autoComplete="off" autoCapitalize="characters" spellCheck={false}
            enterKeyHint="go" value={value} disabled={disabled || busy} autoFocus={autoFocus}
            placeholder={placeholder ?? L("امسح الباركود أو اكتب الرمز", "Scan or type the code")}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(value); } }}
            data-testid={`${testId}-input`} />
        </label>
        {camera ? (
          <button type="button" className="hr-btn scn-cam" onClick={() => setCam(true)} disabled={disabled} data-testid={`${testId}-camera`}
            aria-label={L("المسح بالكاميرا", "Scan with the camera")} title={L("المسح بالكاميرا", "Scan with the camera")}>
            <Camera size={18} aria-hidden="true" /><span className="scn-cam-t">{L("الكاميرا", "Camera")}</span>
          </button>
        ) : null}
      </div>
      <p className={`scn-fb${fb ? ` is-${fb.tone}` : ""}`} role="status" aria-live="polite" data-testid={`${testId}-feedback`}>
        {busy ? L("جارٍ البحث…", "Looking it up…") : fb?.text ?? (listen ? L("جاهز للمسح: امسح الملصق بالقارئ أو الكاميرا.", "Ready: scan the label with the scanner or the camera.") : "")}
      </p>
      {cam ? <CameraScan lang={lang} onClose={() => { setCam(false); inputRef.current?.focus(); }} onCode={(c) => { setCam(false); void submit(c); }} /> : null}
    </div>
  );
}

/** What /api/scan answers, with the message for a refusal in the viewer's language. */
export type ScanLookup<H = Record<string, unknown>> = { ok: true; hit: H & { kind: string }; draw?: { ok: boolean; sameCoffee?: boolean | null; ar?: string; en?: string; code?: string } } | { ok: false; message: string; status: number };

export async function lookupScanCode<H = Record<string, unknown>>(code: string, lang: Lang, params: Record<string, string | number | undefined> = {}, url = "/api/scan"): Promise<ScanLookup<H>> {
  const q = new URLSearchParams({ code });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  try {
    const r = await fetch(`${url}?${q}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, hit: (j.hit ?? j.lot) as H & { kind: string }, draw: j.draw };
    const msg = lang === "en" ? j.errorEn ?? j.error : j.error ?? j.errorEn;
    return { ok: false, message: typeof msg === "string" ? msg : lang === "ar" ? "تعذّر البحث عن الرمز." : "The code could not be looked up.", status: r.status };
  } catch {
    return { ok: false, message: lang === "ar" ? "لا اتصال. حاول مرة أخرى." : "No connection. Try again.", status: 0 };
  }
}
