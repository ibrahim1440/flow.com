-- 20261220090000_soon_batch — the owner's «قريبًا» list (readiness review P1-1…P1-6, round 2: customer data, rejected
-- quotations, gate Lows). One additive schema change (0: nullable Customer columns + CHECKs), the rest data; nothing
-- sent. Idempotent: every UPDATE matches only rows that still differ; every audit row has a deterministic
-- id and is ON CONFLICT DO NOTHING ("AuthAuditLog" and "HrAuditLog" are append-only). Rollback:
-- docs/hr/migration-review/rollback-20261220090000_soon_batch.sql (restores every value from these audit rows).
-- Verifier check 86.
--   1. «مندوب مبيعات» (P1-2): the template loses «لوحة التحكم» (dashboard.access = none); so do the accounts that follow it,
--      and the three named rep accounts (ibrahim, manal.hazazi, jehan.alghamdi), wherever they still hold dashboard. The
--      role editor's own audit: ROLE_UPDATED for the template, EMPLOYEE_PERMISSIONS_CHANGED per account (from → to).
--   2. «محاسب» (P1-1): the template's document becomes the live accountant account's («مسار المحاسب»: accounting edit with
--      invoices_issue and quotes_issue; sales, customers and orders none; …). Member accounts are NOT touched. ROLE_UPDATED
--      carries the whole previous document (rollback).
--   3. Deal value (P1-4): every deal with an accepted (else latest issued) quotation or live direct orders gets
--      amount = that quotation's grand total + its live direct orders (services/sales/deal-amount.ts). HrAuditLog
--      DEAL_AMOUNT_BACKFILL with before / after.
--   4. Order flags (P1-5): orders with an issued invoice, a direct deal link or approved money get vatInvoiceStatus /
--      paymentStatus from those facts (services/orders/order-flags.ts); other orders are left as they are. HrAuditLog
--      ORDER_FLAGS_BACKFILL with before / after.
--   0. Customer data (round 2, A): the buyer's unified number («الرقم الموحد», 700…) and structured national address
--      («العنوان الوطني»: building, street, district, city, postal code, additional number, short address) — nullable
--      TEXT columns, no default, with format CHECKs matching services/customers/customer-identity.ts, and the runtime
--      role's column UPDATE grant (check 81). The rollback drops them while empty.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Customer: unified number + national address (additive).
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "unifiedNumber" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "nationalBuildingNo" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "nationalStreet" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "nationalDistrict" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "nationalCity" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "nationalPostalCode" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "nationalAdditionalNo" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "nationalShortAddress" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_unifiedNumber_check') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_unifiedNumber_check" CHECK ("unifiedNumber" IS NULL OR "unifiedNumber" ~ '^7[0-9]{9}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_nationalBuildingNo_check') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_nationalBuildingNo_check" CHECK ("nationalBuildingNo" IS NULL OR "nationalBuildingNo" ~ '^[0-9]{4}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_nationalPostalCode_check') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_nationalPostalCode_check" CHECK ("nationalPostalCode" IS NULL OR "nationalPostalCode" ~ '^[0-9]{5}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_nationalAdditionalNo_check') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_nationalAdditionalNo_check" CHECK ("nationalAdditionalNo" IS NULL OR "nationalAdditionalNo" ~ '^[0-9]{4}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_nationalAddress_len_check') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_nationalAddress_len_check" CHECK (
      coalesce(length("nationalStreet"), 0) <= 120 AND coalesce(length("nationalDistrict"), 0) <= 120
      AND coalesce(length("nationalCity"), 0) <= 80 AND coalesce(length("nationalShortAddress"), 0) <= 20);
  END IF;
  -- The runtime role UPDATEs "Customer" column by column (20261208090000_email_followups, verifier check 81 F2: "a column
  -- added later must be granted"); SELECT / INSERT are table grants and cover the new columns already.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT UPDATE ("unifiedNumber", "nationalBuildingNo", "nationalStreet", "nationalDistrict", "nationalCity", "nationalPostalCode",
                  "nationalAdditionalNo", "nationalShortAddress") ON "Customer" TO flowcom_app;
  END IF;
END $$;

-- 1a. The rep template.
WITH r AS (
  UPDATE "AccessRole" a
     SET "permissions" = jsonb_set(a."permissions"::jsonb, '{dashboard,access}', '"none"'::jsonb, true)::text,
         "version" = a."version" + 1, "updatedAt" = now()
   WHERE a."name" = 'مندوب مبيعات'
     AND CASE WHEN a."permissions" IS JSON OBJECT THEN coalesce(a."permissions"::jsonb #>> '{dashboard,access}', 'none') <> 'none' ELSE false END
  RETURNING a."id", a."name", a."version"
)
INSERT INTO "AuthAuditLog" ("id", "userId", "action", "result", "sourceInterface", "ipHash", "metadata", "occurredAt")
SELECT 'soon_repdash_' || r."id" || '_v' || r."version", NULL, 'ROLE_UPDATED', 'SUCCESS', 'MIGRATION', 'migration',
       jsonb_build_object('roleId', r."id", 'roleName', r."name", 'version', r."version",
                          'changes', jsonb_build_array(jsonb_build_object('path', 'dashboard.access', 'from', 'view', 'to', 'none')),
                          'truncated', false, 'members', '[]'::jsonb,
                          'reason', 'soon batch (20261220090000_soon_batch): the rep template has no «لوحة التحكم» — «يومي» is the home (P1-2)'),
       now()
  FROM r
ON CONFLICT ("id") DO NOTHING;

-- 1b. The accounts: members of «مندوب مبيعات», and the three named reps, still holding the dashboard.
WITH e AS (
  SELECT x."id", x."name", x."permissions"::jsonb #>> '{dashboard,access}' AS was
    FROM "Employee" x LEFT JOIN "AccessRole" r ON r."id" = x."accessRoleId"
   WHERE (r."name" = 'مندوب مبيعات' OR x."username" IN ('ibrahim', 'manal.hazazi', 'jehan.alghamdi'))
     AND CASE WHEN x."permissions" IS JSON OBJECT THEN coalesce(x."permissions"::jsonb #>> '{dashboard,access}', 'none') <> 'none' ELSE false END
), u AS (
  UPDATE "Employee" x SET "permissions" = jsonb_set(x."permissions"::jsonb, '{dashboard,access}', '"none"'::jsonb, true)::text, "updatedAt" = now()
    FROM e WHERE x."id" = e."id"
  RETURNING x."id"
)
INSERT INTO "AuthAuditLog" ("id", "userId", "action", "result", "sourceInterface", "ipHash", "metadata", "occurredAt")
SELECT 'soon_repdash_emp_' || e."id", NULL, 'EMPLOYEE_PERMISSIONS_CHANGED', 'SUCCESS', 'MIGRATION', 'migration',
       jsonb_build_object('targetEmployeeId', e."id", 'targetName', e."name", 'via', 'MIGRATION',
                          'reason', 'soon batch (20261220090000_soon_batch): no «لوحة التحكم» for a rep (P1-2)',
                          'changes', jsonb_build_array(jsonb_build_object('path', 'dashboard.access', 'from', e.was, 'to', 'none'))),
       now()
  FROM e JOIN u ON u."id" = e."id"
ON CONFLICT ("id") DO NOTHING;

-- 2. The accountant template = the live accountant account («مسار المحاسب»).
WITH before AS (
  SELECT a."id", a."name", a."permissions" AS was FROM "AccessRole" a
   WHERE a."name" = 'محاسب'
     AND CASE WHEN a."permissions" IS JSON OBJECT THEN a."permissions"::jsonb <> '{"dashboard":{"access":"none","sub":{}},"inventory":{"access":"edit","sub":{"receive":true,"adjust":true,"override":true,"valuation":true,"transfer_send":true,"transfer_receive":true,"transfer_cancel":true}},"orders":{"access":"none","sub":{"create":false,"edit":false,"delete":false,"approve":false,"prepare_review":false,"manage_status":false,"unassigned_customers":false}},"production":{"access":"none","sub":{"start_batch":false,"roast_to_stock":false,"blend":false,"view_history":false,"cancel_batch":false,"edit_date":false,"manage_roasters":false,"manage_schedule":false}},"qc":{"access":"none","sub":{"create_record":false,"edit_record":false,"view_records":false,"manage":false,"finalize_override":false,"manage_profiles":false,"approve_exception":false,"dispose":false}},"packaging":{"access":"none","sub":{}},"dispatch":{"access":"none","sub":{"mark_delivered":false}},"history":{"access":"none","sub":{}},"analytics":{"access":"none","sub":{}},"labels":{"access":"none","sub":{"print":false,"profile_manage":false,"template_manage":false,"cupping_named_scorers":false}},"employees":{"access":"none","sub":{"create":false,"edit":false,"manage_access":false}},"cupping":{"access":"none","sub":{}},"settings":{"access":"none","sub":{"reset":false,"training_reset":false}},"customers":{"access":"none","sub":{"manage":false,"sales_hold":false}},"accounting":{"access":"edit","sub":{"settings_manage":true,"coa_manage":true,"tax_category_manage":true,"period_lock":true,"period_close":true,"journal_create":true,"journal_submit":true,"journal_approve":true,"journal_post":true,"journal_reverse":true,"export_view":true,"period_reopen":true,"opening_balance":true,"ar":true,"ap":true,"zatca_view":true,"zatca_onboard":false,"zatca_resubmit":false,"zatca_xml":false,"fixed_assets":true,"budgets":true,"deferrals":true,"recurring":true,"receipts_confirm":true,"quotes_issue":true,"invoices_issue":true,"supervise":false,"data_import":true}},"sales":{"access":"none","sub":{"lead_write":false,"lead_assign":false,"lead_convert":false,"lead_import":false,"lead_export":false,"deal_close":false,"deal_reopen":false,"deal_stage_move":false,"quote_write":false,"quote_approve_discount":false,"stage_manage":false,"collection_submit":false,"collection_view_team":false,"invoices_view":false,"invoices_create":false,"invoices_issue":false,"invoices_cancel":false,"invoices_credit_note":false}},"commissions":{"access":"view","sub":{"view_own":false,"view_team":false,"manage_plans":false,"manage_settings":false,"approve":false,"record_payout":false,"sandbox_collections":false,"collection_verify":true,"collection_reject":true,"collection_reverse":false}},"finance":{"access":"edit","sub":{"txn_enter":true,"reconcile":true,"budget_prepare":true,"budget_approve":false,"allocate":true,"transfer_approve":true,"spend_override_approve":false,"period_close":true,"all_branches":true,"settings_manage":false}},"automation":{"access":"none","sub":{"manage_rules":false,"manage_connection":false,"manage_messages":false}},"hr":{"access":"none","sub":{"directory":false,"people_manage":false,"private_view":false,"documents_view":false,"documents_manage":false,"contracts_manage":false,"attendance_manage":false,"attendance_approve":false,"leave_manage":false,"leave_approve":false,"payroll_prepare":false,"payroll_approve":false,"payroll_pay":false,"payroll_cancel_approved":false,"advances_manage":false,"advances_approve":false,"advances_disburse":false,"recruit":false,"assets_manage":false,"performance_manage":false,"offboard":false,"policy_manage":false,"all_branches":false}},"marketing":{"access":"none","sub":{"content_manage":false,"campaigns_manage":false,"publish":false,"approve":false,"budget_manage":false,"revenue_view":false,"customers_data":false,"messaging_manage":false,"ads_manage":false,"integrations_manage":false,"automation_manage":false,"ai_use":false}},"purchases":{"access":"edit","sub":{"invoices":true,"received_change":true}},"workspace":{"access":"none","sub":{"assign_any":false,"team_view":false}}}'::jsonb ELSE true END
), r AS (
  UPDATE "AccessRole" a SET "permissions" = '{"dashboard":{"access":"none","sub":{}},"inventory":{"access":"edit","sub":{"receive":true,"adjust":true,"override":true,"valuation":true,"transfer_send":true,"transfer_receive":true,"transfer_cancel":true}},"orders":{"access":"none","sub":{"create":false,"edit":false,"delete":false,"approve":false,"prepare_review":false,"manage_status":false,"unassigned_customers":false}},"production":{"access":"none","sub":{"start_batch":false,"roast_to_stock":false,"blend":false,"view_history":false,"cancel_batch":false,"edit_date":false,"manage_roasters":false,"manage_schedule":false}},"qc":{"access":"none","sub":{"create_record":false,"edit_record":false,"view_records":false,"manage":false,"finalize_override":false,"manage_profiles":false,"approve_exception":false,"dispose":false}},"packaging":{"access":"none","sub":{}},"dispatch":{"access":"none","sub":{"mark_delivered":false}},"history":{"access":"none","sub":{}},"analytics":{"access":"none","sub":{}},"labels":{"access":"none","sub":{"print":false,"profile_manage":false,"template_manage":false,"cupping_named_scorers":false}},"employees":{"access":"none","sub":{"create":false,"edit":false,"manage_access":false}},"cupping":{"access":"none","sub":{}},"settings":{"access":"none","sub":{"reset":false,"training_reset":false}},"customers":{"access":"none","sub":{"manage":false,"sales_hold":false}},"accounting":{"access":"edit","sub":{"settings_manage":true,"coa_manage":true,"tax_category_manage":true,"period_lock":true,"period_close":true,"journal_create":true,"journal_submit":true,"journal_approve":true,"journal_post":true,"journal_reverse":true,"export_view":true,"period_reopen":true,"opening_balance":true,"ar":true,"ap":true,"zatca_view":true,"zatca_onboard":false,"zatca_resubmit":false,"zatca_xml":false,"fixed_assets":true,"budgets":true,"deferrals":true,"recurring":true,"receipts_confirm":true,"quotes_issue":true,"invoices_issue":true,"supervise":false,"data_import":true}},"sales":{"access":"none","sub":{"lead_write":false,"lead_assign":false,"lead_convert":false,"lead_import":false,"lead_export":false,"deal_close":false,"deal_reopen":false,"deal_stage_move":false,"quote_write":false,"quote_approve_discount":false,"stage_manage":false,"collection_submit":false,"collection_view_team":false,"invoices_view":false,"invoices_create":false,"invoices_issue":false,"invoices_cancel":false,"invoices_credit_note":false}},"commissions":{"access":"view","sub":{"view_own":false,"view_team":false,"manage_plans":false,"manage_settings":false,"approve":false,"record_payout":false,"sandbox_collections":false,"collection_verify":true,"collection_reject":true,"collection_reverse":false}},"finance":{"access":"edit","sub":{"txn_enter":true,"reconcile":true,"budget_prepare":true,"budget_approve":false,"allocate":true,"transfer_approve":true,"spend_override_approve":false,"period_close":true,"all_branches":true,"settings_manage":false}},"automation":{"access":"none","sub":{"manage_rules":false,"manage_connection":false,"manage_messages":false}},"hr":{"access":"none","sub":{"directory":false,"people_manage":false,"private_view":false,"documents_view":false,"documents_manage":false,"contracts_manage":false,"attendance_manage":false,"attendance_approve":false,"leave_manage":false,"leave_approve":false,"payroll_prepare":false,"payroll_approve":false,"payroll_pay":false,"payroll_cancel_approved":false,"advances_manage":false,"advances_approve":false,"advances_disburse":false,"recruit":false,"assets_manage":false,"performance_manage":false,"offboard":false,"policy_manage":false,"all_branches":false}},"marketing":{"access":"none","sub":{"content_manage":false,"campaigns_manage":false,"publish":false,"approve":false,"budget_manage":false,"revenue_view":false,"customers_data":false,"messaging_manage":false,"ads_manage":false,"integrations_manage":false,"automation_manage":false,"ai_use":false}},"purchases":{"access":"edit","sub":{"invoices":true,"received_change":true}},"workspace":{"access":"none","sub":{"assign_any":false,"team_view":false}}}', "version" = a."version" + 1, "updatedAt" = now()
    FROM before b WHERE a."id" = b."id"
  RETURNING a."id", a."version"
)
INSERT INTO "AuthAuditLog" ("id", "userId", "action", "result", "sourceInterface", "ipHash", "metadata", "occurredAt")
SELECT 'soon_accttpl_' || r."id" || '_v' || r."version", NULL, 'ROLE_UPDATED', 'SUCCESS', 'MIGRATION', 'migration',
       jsonb_build_object('roleId', b."id", 'roleName', b."name", 'version', r."version",
                          'changes', jsonb_build_array(jsonb_build_object('path', '*', 'from', 'previous document', 'to', 'the live accountant account')),
                          'previousDocument', b.was, 'truncated', false, 'members', '[]'::jsonb,
                          'reason', 'soon batch (20261220090000_soon_batch): the «محاسب» template matches the live accountant (P1-1); member accounts unchanged'),
       now()
  FROM r JOIN before b ON b."id" = r."id"
ON CONFLICT ("id") DO NOTHING;

-- 3. Deal value from the quotation (+ live direct orders). Round 2 (B): a deal whose quotations were all REJECTED /
--    EXPIRED (none ACCEPTED or ISSUED) is worth 0.00 + its live direct orders; one with no quotation and no direct
--    order keeps its typed amount. A deal zeroed by that rule also gets the deal activity entry the live path writes
--    (deal-amount.ts noteQuoteClosed; sourceKey deal-quote-closed:<quoteId>, deterministic id).
WITH q AS (
  SELECT o."id", o."ownerId",
         coalesce((SELECT x."grandTotal" FROM "Quote" x WHERE x."opportunityId" = o."id" AND x."status" = 'ACCEPTED' ORDER BY x."revision" DESC LIMIT 1),
                  (SELECT x."grandTotal" FROM "Quote" x WHERE x."opportunityId" = o."id" AND x."status" = 'ISSUED' ORDER BY x."issuedAt" DESC NULLS LAST, x."revision" DESC LIMIT 1)) AS quote_total,
         (SELECT count(*) FROM "Quote" x WHERE x."opportunityId" = o."id" AND x."status" IN ('REJECTED', 'EXPIRED')) AS closed_n,
         (SELECT coalesce(sum(l."directGross"), 0) FROM "OpportunityOrder" l JOIN "Order" od ON od."id" = l."orderId"
           WHERE l."opportunityId" = o."id" AND l."quoteId" IS NULL AND l."directGross" IS NOT NULL AND od."status" NOT IN ('Cancelled', 'Rejected')) AS direct_total,
         (SELECT count(*) FROM "OpportunityOrder" l JOIN "Order" od ON od."id" = l."orderId"
           WHERE l."opportunityId" = o."id" AND l."quoteId" IS NULL AND l."directGross" IS NOT NULL AND od."status" NOT IN ('Cancelled', 'Rejected')) AS direct_n,
         o."amount" AS was
    FROM "Opportunity" o
), t AS (
  SELECT q."id", q."ownerId", q.was, q.quote_total, q.closed_n, round(coalesce(q.quote_total, 0) + q.direct_total, 2) AS now_amount FROM q
   WHERE (q.quote_total IS NOT NULL OR q.direct_n > 0 OR q.closed_n > 0) AND round(coalesce(q.quote_total, 0) + q.direct_total, 2) <> q.was
), u AS (
  UPDATE "Opportunity" o SET "amount" = t.now_amount FROM t WHERE o."id" = t."id" RETURNING o."id"
), a AS (
  INSERT INTO "HrAuditLog" ("id", "action", "entityType", "entityId", "before", "after", "reason", "createdAt")
  SELECT 'soon_amt_' || t."id" || '_' || replace(t.now_amount::text, '.', '_'), 'DEAL_AMOUNT_BACKFILL', 'Opportunity', t."id",
         jsonb_build_object('amount', t.was), jsonb_build_object('amount', t.now_amount),
         'soon batch (20261220090000_soon_batch): the deal value from its quotation + direct orders (P1-4; round 2: a rejected / expired quotation counts 0)', now()
    FROM t JOIN u ON u."id" = t."id"
  ON CONFLICT ("id") DO NOTHING
  RETURNING 1
)
INSERT INTO "Activity" ("id", "type", "subject", "body", "opportunityId", "ownerId", "completedAt", "sourceKey", "createdAt", "updatedAt")
SELECT 'soon_actq_' || lq."id", 'NOTE',
       CASE WHEN lq."status" = 'REJECTED' THEN 'رُفض' ELSE 'انتهت صلاحية' END || ' عرض السعر ' || lq."quoteNumber" || ' (' || lq."grandTotal"::text || ' ر.س)',
       'قيمة الصفقة صارت ' || t.now_amount::text || ' ر.س — لا عرض سعر قائم.', t."id", t."ownerId", now(), 'deal-quote-closed:' || lq."id", now(), now()
  FROM t JOIN u ON u."id" = t."id"
  CROSS JOIN LATERAL (SELECT x."id", x."status", x."quoteNumber", x."grandTotal" FROM "Quote" x
                       WHERE x."opportunityId" = t."id" AND x."status" IN ('REJECTED', 'EXPIRED')
                       ORDER BY x."rejectedAt" DESC NULLS LAST, x."issuedAt" DESC NULLS LAST, x."revision" DESC LIMIT 1) lq
 WHERE t.quote_total IS NULL AND t.closed_n > 0
   AND NOT EXISTS (SELECT 1 FROM "Activity" e WHERE e."sourceKey" = 'deal-quote-closed:' || lq."id")
ON CONFLICT ("id") DO NOTHING;

-- 4. Order flags from the real events (services/orders/order-flags.ts, the same rule in SQL). Only orders that have an
--    issued invoice, a deal link or approved money are touched. Round 2 (gate L1): an uninvoiced order on a deal is
--    worth its direct gross, or (round 3, gate L7) its share of the accepted quotation's total — spread over the
--    quotation's live orders oldest first, each capped by its kg × the quotation's price per kg (an order with a SKU
--    the quotation does not price is not capped; an order left with nothing reads the quotation's state); the deal's approved
--    collections not applied to an invoice are allocated OLDEST ORDER FIRST across its live uninvoiced orders, on top
--    of the receipts recorded for the order alone (no deal).
WITH inv AS (
  SELECT i."orderId", count(*) AS n, sum(i."grandTotal") AS total, array_agg(i."id") AS ids
    FROM "SalesInvoice" i WHERE i."orderId" IS NOT NULL AND i."kind" = 'INVOICE' AND i."status" = 'ISSUED' GROUP BY i."orderId"
), links AS (
  SELECT DISTINCT ON (l."orderId") l."orderId", l."opportunityId", l."quoteId", l."directGross", od."status", od."createdAt"
    FROM "OpportunityOrder" l JOIN "Order" od ON od."id" = l."orderId"
   ORDER BY l."orderId", l."createdAt", l."id"
), own AS (
  SELECT s."orderId", sum(s."amountGross") AS amt FROM "SalesCollection" s
   WHERE s."status" = 'APPROVED' AND s."opportunityId" IS NULL AND s."orderId" IS NOT NULL GROUP BY s."orderId"
), pool AS (
  SELECT s."opportunityId",
         sum(s."amountGross") - coalesce((SELECT sum(ap."amount") FROM "ArApplication" ap JOIN "SalesCollection" s2 ON s2."id" = ap."collectionId"
                                           WHERE s2."opportunityId" = s."opportunityId" AND s2."status" = 'APPROVED' AND ap."status" = 'APPLIED'), 0) AS amt
    FROM "SalesCollection" s WHERE s."status" = 'APPROVED' AND s."opportunityId" IS NOT NULL GROUP BY s."opportunityId"
), ppk AS (
  -- Gate L7: the accepted quotation's gross price per kg of each SKU (its lines' total / their kg).
  SELECT ql."quoteId", ql."productSkuId",
         sum(ql."lineTotal") / nullif(sum(ql."quantity" * ps."weightGrams"::numeric / 1000.0), 0) AS per_kg
    FROM "QuoteLine" ql JOIN "ProductSKU" ps ON ps."id" = ql."productSkuId" JOIN "Quote" qx ON qx."id" = ql."quoteId"
   WHERE qx."status" = 'ACCEPTED' AND ps."weightGrams" > 0
   GROUP BY ql."quoteId", ql."productSkuId"
), qorders AS (
  -- Each live order of an accepted quotation, with its value at the quotation's prices (NULL = a SKU not priced).
  SELECT k."orderId", k."quoteId", k."createdAt", qq."grandTotal" AS q_total,
         CASE WHEN EXISTS (SELECT 1 FROM "OrderItem" oi LEFT JOIN ppk p ON p."quoteId" = k."quoteId" AND p."productSkuId" = oi."productSkuId"
                            WHERE oi."orderId" = k."orderId" AND p.per_kg IS NULL)
                OR NOT EXISTS (SELECT 1 FROM "OrderItem" oi WHERE oi."orderId" = k."orderId") THEN NULL
              ELSE (SELECT round(sum(oi."quantityKg"::numeric * p.per_kg), 2) FROM "OrderItem" oi JOIN ppk p ON p."quoteId" = k."quoteId" AND p."productSkuId" = oi."productSkuId"
                     WHERE oi."orderId" = k."orderId") END AS cap
    FROM links k JOIN "Quote" qq ON qq."id" = k."quoteId"
   WHERE qq."status" = 'ACCEPTED' AND k."directGross" IS NULL AND k."status" NOT IN ('Cancelled', 'Rejected')
), qshare AS (
  -- The quotation total spread oldest first, each order capped (an uncapped order takes what is left).
  SELECT x."orderId", x."quoteId",
         greatest(least(x.q_total, x.cum) - least(x.q_total, x.cum - coalesce(x.cap, 1e15)), 0) AS share
    FROM (SELECT o.*, sum(coalesce(o.cap, 1e15)) OVER (PARTITION BY o."quoteId" ORDER BY o."createdAt", o."orderId") AS cum FROM qorders o) x
), base AS (
  SELECT k."orderId", k."opportunityId", k."createdAt", k."quoteId", coalesce(own.amt, 0) AS own_amt,
         CASE WHEN k."directGross" IS NOT NULL THEN k."directGross" ELSE coalesce(qs.share, 0) END AS due,
         (qs."orderId" IS NOT NULL) AS quote_born
    FROM links k LEFT JOIN qshare qs ON qs."orderId" = k."orderId" LEFT JOIN own ON own."orderId" = k."orderId"
   WHERE k."status" NOT IN ('Cancelled', 'Rejected') AND NOT EXISTS (SELECT 1 FROM inv WHERE inv."orderId" = k."orderId")
), alloc0 AS (
  SELECT b."orderId", b."quoteId", b.quote_born, b.due, b.own_amt, greatest(b.due - b.own_amt, 0) AS need,
         coalesce(sum(greatest(b.due - b.own_amt, 0)) OVER (PARTITION BY b."opportunityId" ORDER BY b."createdAt", b."orderId"
                                                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS need_before,
         coalesce(p.amt, 0) AS pool_amt
    FROM base b LEFT JOIN pool p ON p."opportunityId" = b."opportunityId"
), alloc1 AS (
  SELECT a.*, a.own_amt + least(a.need, greatest(a.pool_amt - a.need_before, 0)) AS paid_alloc FROM alloc0 a
), alloc AS (
  -- An order of a quotation left with nothing to carry reads the quotation's own state (its orders' paid vs due).
  SELECT a."orderId", a.need_before, a.pool_amt, a.need, a.own_amt,
         CASE WHEN a.quote_born AND a.due = 0 AND qs.q_due > 0 THEN qs.q_due ELSE a.due END AS due,
         CASE WHEN a.quote_born AND a.due = 0 AND qs.q_due > 0 THEN qs.q_paid ELSE a.paid_alloc END AS paid_final
    FROM alloc1 a
    LEFT JOIN (SELECT "quoteId", sum(due) AS q_due, sum(paid_alloc) AS q_paid FROM alloc1 WHERE quote_born GROUP BY "quoteId") qs ON qs."quoteId" = a."quoteId"
), f AS (
  SELECT o."id", o."paymentStatus" AS was_pay, o."vatInvoiceStatus" AS was_vat,
         coalesce(inv.n, 0) AS n,
         coalesce(inv.total, 0) - coalesce((SELECT sum(c."grandTotal") FROM "SalesInvoice" c WHERE c."kind" = 'CREDIT_NOTE' AND c."status" = 'ISSUED' AND c."originalInvoiceId" = ANY (inv.ids)), 0) AS invoiced,
         CASE WHEN inv.n IS NOT NULL
              THEN coalesce((SELECT sum(ap."amount") FROM "ArApplication" ap WHERE ap."invoiceId" = ANY (inv.ids) AND ap."status" = 'APPLIED' AND ap."collectionId" IS NOT NULL), 0)
              WHEN al."orderId" IS NOT NULL THEN al.paid_final
              ELSE coalesce(own.amt, 0) END AS paid,
         CASE WHEN inv.n IS NOT NULL THEN NULL WHEN al."orderId" IS NOT NULL THEN al.due ELSE 0 END AS due_uninvoiced,
         (lk."orderId" IS NOT NULL) AS linked
    FROM "Order" o LEFT JOIN inv ON inv."orderId" = o."id" LEFT JOIN alloc al ON al."orderId" = o."id"
    LEFT JOIN own ON own."orderId" = o."id" LEFT JOIN links lk ON lk."orderId" = o."id"
), c AS (
  SELECT f."id", f.was_pay, f.was_vat,
         CASE WHEN f.n > 0 AND f.invoiced > 0 THEN 'Sent' ELSE 'Not Yet' END AS vat,
         CASE WHEN (CASE WHEN f.n > 0 THEN greatest(f.invoiced, 0) ELSE f.due_uninvoiced END) > 0
                   AND f.paid >= (CASE WHEN f.n > 0 THEN greatest(f.invoiced, 0) ELSE f.due_uninvoiced END) THEN 'Paid'
              WHEN f.paid > 0 THEN 'Partial Paid' ELSE 'Not Paid' END AS pay
    FROM f WHERE f.n > 0 OR f.linked OR f.paid > 0
), d AS (
  SELECT * FROM c WHERE c.vat IS DISTINCT FROM c.was_vat OR c.pay IS DISTINCT FROM c.was_pay
), u AS (
  UPDATE "Order" o SET "vatInvoiceStatus" = d.vat, "paymentStatus" = d.pay FROM d WHERE o."id" = d."id" RETURNING o."id"
)
INSERT INTO "HrAuditLog" ("id", "action", "entityType", "entityId", "before", "after", "reason", "createdAt")
SELECT 'soon_flags_' || d."id" || '_' || d.vat || '_' || replace(d.pay, ' ', '_'), 'ORDER_FLAGS_BACKFILL', 'Order', d."id",
       jsonb_build_object('vatInvoiceStatus', d.was_vat, 'paymentStatus', d.was_pay), jsonb_build_object('vatInvoiceStatus', d.vat, 'paymentStatus', d.pay),
       'soon batch (20261220090000_soon_batch): the order flags from its invoices and money (P1-5; round 2: deal money allocated oldest order first)', now()
  FROM d JOIN u ON u."id" = d."id"
ON CONFLICT ("id") DO NOTHING;

COMMIT;
