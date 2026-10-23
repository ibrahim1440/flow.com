"use client";
/**
 * «طباعة الملصق» for one roasting batch (the roasting station's recorded screen, WS-R4). It is the
 * same G-20 Coffee Origin label flow as the Labels page and the packaging «Print labels» action:
 * the PrintDialog with the batch's coffee and the batch preselected for the traceability line
 * (batch number · roast date), an authorized and audited job (POST /api/print/jobs), then the
 * browser's print dialog.
 *
 * While label printing is off (PRINT_CERTIFIED not "true", or the answer is still loading), or the
 * person lacks labels.print, or the batch has no coffee, the caller's own «unavailable» text is shown
 * instead — the station keeps «الملصقات غير متاحة». The server refuses 409 PRINTING_NOT_CERTIFIED
 * whatever this shows.
 */
import { useState, type ReactNode } from "react";
import { HrRoot } from "@/components/hr/ui";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { PrintDialog } from "./PrintDialog";
import { usePrintCertified } from "./Certification";

export function BatchLabelPrint({ permissions, productId, productLabel, batch, buttonLabel, unavailable, className, testId = "batch-label-print" }: {
  permissions: Permissions;
  productId: string | null | undefined;
  productLabel: string;
  batch: { id: string; batchNumber: string };
  buttonLabel: ReactNode;
  unavailable: ReactNode;
  className?: string;
  testId?: string;
}) {
  const certified = usePrintCertified();
  const [open, setOpen] = useState(false);
  const allowed = hasSubPrivilege(permissions, "labels", "print");
  if (certified !== true || !allowed || !productId) return <>{unavailable}</>;
  return (
    <>
      <span style={{ display: "block", marginTop: 12 }}>
        <button type="button" className={className ?? "btn"} onClick={() => setOpen(true)} data-testid={testId}>{buttonLabel}</button>
      </span>
      {open ? (
        <HrRoot>
          <PrintDialog open={open} onClose={() => setOpen(false)} initialTemplate="COFFEE_ORIGIN" subtitle={productLabel}
            items={[{ kind: "product", productId, label: productLabel, batch }]} />
        </HrRoot>
      ) : null}
    </>
  );
}
