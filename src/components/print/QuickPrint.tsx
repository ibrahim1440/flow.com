"use client";
/**
 * «طباعة ملصق» from where the record is (20261114090000_green_lot_labels): a green lot row, the lot page, the purchase
 * invoice after «حفظ واستلام», a material row. Opens the one print dialog (PrintDialog) on the record's template.
 * Shown only with labels.print (and the inventory module, as the server requires); disabled with the reason while
 * label printing is not enabled (the certification gate). The server refuses either way.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Printer } from "lucide-react";
import { Btn } from "@/components/hr/ui";
import { useL } from "@/components/ops/ui";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { useUser } from "@/app/dashboard/user-context";
import type { TemplateKey } from "@/lib/print/templates";
import { PrintDialog, type DialogItem } from "./PrintDialog";

let statusOnce: Promise<boolean> | null = null;
/** The certification answer, asked once per page load for every button on it (fail-closed). */
function useCertifiedOnce(): boolean | null {
  const [v, setV] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    statusOnce ??= fetch("/api/print/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).then((b: { certified?: unknown }) => b.certified === true).catch(() => false);
    statusOnce.then((c) => { if (alive) setV(c); });
    return () => { alive = false; };
  }, []);
  return v;
}

/** Whether this viewer may print record labels at all (the button is hidden otherwise). */
export function useCanPrintLabels(): boolean {
  const user = useUser();
  return !!user && hasSubPrivilege(user.permissions, "labels", "print") && hasModuleAccess(user.permissions, "inventory");
}

export function PrintLabelButton({ items, template, subtitle, label, size = "sm", variant = "secondary", iconOnly, testId, onPrinted, open: openProp, onOpenChange, children }: {
  items: DialogItem[]; template: TemplateKey; subtitle?: string; label?: string; size?: "sm" | "md"; variant?: "primary" | "secondary" | "ghost";
  iconOnly?: boolean; testId?: string; onPrinted?: (jobId: string) => void; open?: boolean; onOpenChange?: (o: boolean) => void; children?: ReactNode;
}) {
  const L = useL();
  const can = useCanPrintLabels();
  const certified = useCertifiedOnce();
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = (o: boolean) => { if (onOpenChange) onOpenChange(o); else setOwn(o); };
  if (!can) return null;
  const text = label ?? L("طباعة ملصق", "Print label");
  const why = certified === false ? L("طباعة الملصقات غير مفعّلة بعد على هذا الخادم.", "Label printing is not enabled on this server yet.") : undefined;
  return (
    <>
      <Btn size={size === "md" ? undefined : size} variant={variant} className={iconOnly ? "hr-iconbtn" : undefined} disabled={certified !== true} title={why ?? text} aria-label={iconOnly ? text : undefined}
        onClick={() => setOpen(true)} data-testid={testId}>
        <Printer size={16} aria-hidden="true" />{iconOnly ? null : children ?? text}
      </Btn>
      {open && certified === true ? (
        <PrintDialog open onClose={() => setOpen(false)} items={items} initialTemplate={template} subtitle={subtitle}
          onPrinted={(id) => { setOpen(false); onPrinted?.(id); }} />
      ) : null}
    </>
  );
}
