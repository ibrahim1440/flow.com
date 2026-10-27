"use client";
/**
 * Camera scanning (phones, tablets, laptops). The back camera through getUserMedia; frames are decoded by the
 * browser's own BarcodeDetector when it reads Code 128 and QR (Chrome / Edge on Android, macOS), otherwise by ZXing
 * (@zxing/browser — iOS Safari, Firefox, desktop Chrome on Linux / Windows), imported only now. Nothing leaves the
 * device: frames are decoded locally. Needs a secure origin (https, or localhost) and the camera allowed by the
 * Permissions-Policy (next.config.ts: camera=(self)).
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

type Lang = "ar" | "en";
type State = "starting" | "live" | "denied" | "nocamera" | "insecure" | "unsupported" | "error";
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type DetectorCtor = { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };

const FORMATS = ["code_128", "qr_code", "ean_13", "ean_8", "upc_a"];

export function CameraScan({ onCode, onClose, lang }: { onCode: (code: string) => void; onClose: () => void; lang: Lang }) {
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>("starting");
  const [engine, setEngine] = useState<"native" | "zxing" | null>(null);
  const [manual, setManual] = useState("");
  const done = useRef(false);
  const cbs = useRef({ onCode, onClose });
  useEffect(() => { cbs.current = { onCode, onClose }; });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopZx: (() => void) | null = null;
    let raf = 0;
    let off = false;
    const finish = (text: string) => {
      if (done.current || !text) return;
      done.current = true;
      try { navigator.vibrate?.(60); } catch { /* optional */ }
      cbs.current.onCode(text);
    };
    (async () => {
      if (typeof window === "undefined") return;
      if (!window.isSecureContext) { setState("insecure"); return; }
      if (!navigator.mediaDevices?.getUserMedia) { setState("unsupported"); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        const n = (e as { name?: string })?.name;
        setState(n === "NotAllowedError" || n === "SecurityError" ? "denied" : n === "NotFoundError" || n === "OverconstrainedError" ? "nocamera" : "error");
        return;
      }
      if (off) { stream.getTracks().forEach((t) => t.stop()); return; }
      const v = video.current!;
      v.srcObject = stream;
      v.setAttribute("playsinline", "");
      v.muted = true;
      await v.play().catch(() => undefined);
      setState("live");
      const Native = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
      let formats: string[] = [];
      try { formats = Native?.getSupportedFormats ? await Native.getSupportedFormats() : []; } catch { formats = []; }
      if (Native && formats.includes("code_128") && formats.includes("qr_code")) {
        setEngine("native");
        const det = new Native({ formats: FORMATS.filter((f) => formats.includes(f)) });
        let last = 0;
        const tick = async (t: number) => {
          if (off || done.current) return;
          if (t - last > 120 && v.readyState >= 2) {
            last = t;
            try { const r = await det.detect(v); if (r[0]?.rawValue) { finish(r[0].rawValue); return; } } catch { /* next frame */ }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return;
      }
      setEngine("zxing");
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
        if (off) return;
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A]);
        const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });
        const controls = await reader.decodeFromVideoElement(v, (res) => { if (res) finish(res.getText()); });
        stopZx = () => controls.stop();
        if (off) stopZx();
      } catch {
        if (!off) setState("unsupported");
      }
    })();
    return () => {
      off = true;
      cancelAnimationFrame(raf);
      stopZx?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") cbs.current.onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const msg: Record<Exclude<State, "live" | "starting">, string> = {
    denied: L("لم يُسمح بالكاميرا. اسمح بها من إعدادات المتصفح لهذا الموقع، أو اكتب الرمز.", "The camera was not allowed. Allow it in the browser's settings for this site, or type the code."),
    nocamera: L("لا توجد كاميرا متاحة على هذا الجهاز. اكتب الرمز أو استخدم قارئ الباركود.", "No camera on this device. Type the code or use a barcode scanner."),
    insecure: L("الكاميرا تعمل على اتصال آمن (https) فقط.", "The camera works on a secure (https) connection only."),
    unsupported: L("هذا المتصفح لا يدعم المسح بالكاميرا. اكتب الرمز أو استخدم قارئ الباركود.", "This browser cannot scan with the camera. Type the code or use a barcode scanner."),
    error: L("تعذّر تشغيل الكاميرا. أغلق التطبيقات التي تستخدمها وحاول مرة أخرى.", "The camera could not start. Close other apps using it and try again."),
  };

  return (
    <div className="scn-cam-layer" role="dialog" aria-modal="true" aria-label={L("المسح بالكاميرا", "Scan with the camera")} data-testid="scan-camera" dir={lang === "ar" ? "rtl" : "ltr"}>
      <div className="scn-cam-head">
        <strong>{L("وجّه الكاميرا إلى الباركود", "Point the camera at the barcode")}</strong>
        <button type="button" className="scn-cam-x" onClick={() => cbs.current.onClose()} aria-label={L("إغلاق", "Close")} data-testid="scan-camera-close"><X size={22} aria-hidden="true" /></button>
      </div>
      <div className="scn-cam-view">
        <video ref={video} className="scn-cam-video" playsInline muted aria-hidden="true" />
        <div className="scn-cam-frame" aria-hidden="true" />
        {state !== "live" ? <p className="scn-cam-msg" role="status" data-testid="scan-camera-state" data-state={state}>{state === "starting" ? L("جارٍ تشغيل الكاميرا…", "Starting the camera…") : msg[state]}</p> : null}
      </div>
      <p className="scn-cam-hint" data-testid="scan-camera-engine" data-engine={engine ?? ""}>
        {L("الباركود أو رمز QR على ملصق اللوت أو الرف. يُقرأ على الجهاز نفسه.", "The barcode or QR code on the lot or shelf label. Read on this device.")}
      </p>
      <form className="scn-cam-manual" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) { done.current = true; cbs.current.onCode(manual.trim()); } }}>
        <input className="hr-input" dir="ltr" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="GL-00042" aria-label={L("أو اكتب الرمز", "Or type the code")} data-testid="scan-camera-manual" />
        <button type="submit" className="hr-btn">{L("بحث", "Find")}</button>
      </form>
    </div>
  );
}
