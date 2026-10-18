"use client";

// The reason an inventory override (restocking a cancelled roast) requires — owner decision,
// inventory privileges Option A. The server refuses a restock without 8–500 characters
// (OVERRIDE_REASON_REQUIRED); this field only says so before the request.
export const RESTOCK_REASON_MIN = 8;
export const restockReasonOk = (v: string) => v.trim().length >= RESTOCK_REASON_MIN && v.trim().length <= 500;

export function RestockReason({ value, onChange, label, hint, disabled }: { value: string; onChange: (v: string) => void; label: string; hint: string; disabled?: boolean }) {
  return (
    <label className="block mb-3">
      <span className="block text-sm font-bold text-charcoal mb-1">{label}</span>
      <textarea
        data-testid="restock-reason"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        maxLength={500}
        rows={2}
        className="w-full rounded-lg border-2 border-border px-3 py-2 text-sm focus:border-orange focus:outline-none disabled:opacity-50"
      />
      <span className="block text-xs text-brown mt-1">{hint}</span>
    </label>
  );
}
