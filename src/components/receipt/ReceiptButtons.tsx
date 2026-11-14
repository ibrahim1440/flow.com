"use client";
// P2 UXM-24 (owner decision ب10, approved Figma 2أ / 2ب): a receipt is taken two ways, side by side —
//   «📷 صوّر»   opens the camera (capture="environment");
//   «اختر ملف»  opens the photos and files (a WhatsApp image, a PDF) — no capture, so the phone never forces the camera.
// One component for every receipt field (collection, direct sale, invoice-page sale, deal page, payment-hold top-up).
import { useRef } from "react";
import "./receipt-buttons.css";

export function ReceiptButtons({ ar, onPick, disabled, testId, invalid, fileInputTestId, accept = "image/*,application/pdf" }: {
  ar: boolean;
  onPick: (file: File | null) => void;
  disabled?: boolean;
  /** Base test id: `${testId}-camera`, `${testId}-file`, and the inputs `${testId}-camera-input` / `${testId}-input`. */
  testId: string;
  invalid?: boolean;
  /** The «اختر ملف» input's test id when a screen already has one (kept so its tests and helpers stay valid). */
  fileInputTestId?: string;
  accept?: string;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const take = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; onPick(f); };
  return (
    <div className="rcpt-btns" data-testid={testId}>
      <button type="button" className="rcpt-btn" disabled={disabled} onClick={() => camera.current?.click()} data-testid={`${testId}-camera`}>
        <span aria-hidden>📷</span> {ar ? "صوّر" : "Take a photo"}
      </button>
      <button type="button" className="rcpt-btn" disabled={disabled} onClick={() => file.current?.click()} data-testid={`${testId}-file`}>
        {ar ? "اختر ملف" : "Choose a file"}
      </button>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={take} aria-invalid={invalid || undefined} data-testid={`${testId}-camera-input`} />
      <input ref={file} type="file" accept={accept} hidden onChange={take} aria-invalid={invalid || undefined} data-testid={fileInputTestId ?? `${testId}-input`} />
    </div>
  );
}
