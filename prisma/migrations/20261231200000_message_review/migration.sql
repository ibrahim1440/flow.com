-- R1-e review UX (owner-approved design «R1-e · معالجة رسائل التسويق», 17 Nov 2026): one processing experience for a message
-- that may have been delivered (deliveryDoubt, 20261231193000) — campaign messages, and the automation log's WhatsApp
-- and e-mail alike. On each of the three tables:
--   * «تسجيل نتيجة التحقق»: reviewOutcome DELIVERED | NOT_DELIVERED | UNCERTAIN, who, when and a note — whole or none,
--     and only on a doubtful message. The provider's delivery status (status / statusNote) is NEVER changed by a review:
--     two fields, two columns;
--   * a resend after review is a NEW message pointing at the original (resendOfMessageId, UNIQUE: one per original);
--     the guard trigger lets it in only when the original was reviewed «لم تصل» (NOT_DELIVERED) — «تعذّر التأكد»
--     never allows one — and, for a campaign message, only within 24 h of the original's first send attempt
--     (sendingStartedAt; older rows: scheduledAt, then createdAt — a late marketing message is not sent);
--     an account-activation link is never resent (a new link is issued from user management);
--     the link never changes, and once resent the original's review is frozen;
--   * sendingStartedAt (the claim, QUEUED → SENDING) and interruptedAt (when the doubt was recorded) for the timeline.
BEGIN;

ALTER TABLE "MktMessage"
  ADD COLUMN "reviewOutcome" TEXT,
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "resendOfMessageId" TEXT,
  ADD COLUMN "sendingStartedAt" TIMESTAMP(3),
  ADD COLUMN "interruptedAt" TIMESTAMP(3);
ALTER TABLE "MktMessage"
  ADD CONSTRAINT "MktMessage_reviewOutcome_check" CHECK ("reviewOutcome" IS NULL OR "reviewOutcome" IN ('DELIVERED', 'NOT_DELIVERED', 'UNCERTAIN')),
  ADD CONSTRAINT "MktMessage_review_whole_check" CHECK (
    ("reviewOutcome" IS NULL AND "reviewedById" IS NULL AND "reviewedAt" IS NULL AND "reviewNote" IS NULL)
    OR ("reviewOutcome" IS NOT NULL AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL AND length(btrim("reviewNote")) > 0)),
  ADD CONSTRAINT "MktMessage_review_doubt_check" CHECK ("reviewOutcome" IS NULL OR "deliveryDoubt"),
  ADD CONSTRAINT "MktMessage_resend_not_self_check" CHECK ("resendOfMessageId" IS NULL OR "resendOfMessageId" <> "id"),
  ADD CONSTRAINT "MktMessage_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MktMessage_resendOfMessageId_fkey" FOREIGN KEY ("resendOfMessageId") REFERENCES "MktMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "MktMessage_resendOfMessageId_key" ON "MktMessage"("resendOfMessageId");

ALTER TABLE "WhatsAppMessage"
  ADD COLUMN "reviewOutcome" TEXT,
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "resendOfMessageId" TEXT,
  ADD COLUMN "sendingStartedAt" TIMESTAMP(3),
  ADD COLUMN "interruptedAt" TIMESTAMP(3);
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_reviewOutcome_check" CHECK ("reviewOutcome" IS NULL OR "reviewOutcome" IN ('DELIVERED', 'NOT_DELIVERED', 'UNCERTAIN')),
  ADD CONSTRAINT "WhatsAppMessage_review_whole_check" CHECK (
    ("reviewOutcome" IS NULL AND "reviewedById" IS NULL AND "reviewedAt" IS NULL AND "reviewNote" IS NULL)
    OR ("reviewOutcome" IS NOT NULL AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL AND length(btrim("reviewNote")) > 0)),
  ADD CONSTRAINT "WhatsAppMessage_review_doubt_check" CHECK ("reviewOutcome" IS NULL OR "deliveryDoubt"),
  ADD CONSTRAINT "WhatsAppMessage_resend_not_self_check" CHECK ("resendOfMessageId" IS NULL OR "resendOfMessageId" <> "id"),
  ADD CONSTRAINT "WhatsAppMessage_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WhatsAppMessage_resendOfMessageId_fkey" FOREIGN KEY ("resendOfMessageId") REFERENCES "WhatsAppMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "WhatsAppMessage_resendOfMessageId_key" ON "WhatsAppMessage"("resendOfMessageId");

ALTER TABLE "EmailMessage"
  ADD COLUMN "reviewOutcome" TEXT,
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "resendOfMessageId" TEXT,
  ADD COLUMN "sendingStartedAt" TIMESTAMP(3),
  ADD COLUMN "interruptedAt" TIMESTAMP(3);
ALTER TABLE "EmailMessage"
  ADD CONSTRAINT "EmailMessage_reviewOutcome_check" CHECK ("reviewOutcome" IS NULL OR "reviewOutcome" IN ('DELIVERED', 'NOT_DELIVERED', 'UNCERTAIN')),
  ADD CONSTRAINT "EmailMessage_review_whole_check" CHECK (
    ("reviewOutcome" IS NULL AND "reviewedById" IS NULL AND "reviewedAt" IS NULL AND "reviewNote" IS NULL)
    OR ("reviewOutcome" IS NOT NULL AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL AND length(btrim("reviewNote")) > 0)),
  ADD CONSTRAINT "EmailMessage_review_doubt_check" CHECK ("reviewOutcome" IS NULL OR "deliveryDoubt"),
  ADD CONSTRAINT "EmailMessage_resend_not_self_check" CHECK ("resendOfMessageId" IS NULL OR "resendOfMessageId" <> "id"),
  ADD CONSTRAINT "EmailMessage_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmailMessage_resendOfMessageId_fkey" FOREIGN KEY ("resendOfMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "EmailMessage_resendOfMessageId_key" ON "EmailMessage"("resendOfMessageId");

-- Existing doubtful rows: when the doubt was recorded is the moment they failed (campaign) / were last written.
UPDATE "MktMessage" SET "interruptedAt" = coalesce("failedAt", "updatedAt") WHERE "deliveryDoubt" AND "interruptedAt" IS NULL;
UPDATE "WhatsAppMessage" SET "interruptedAt" = "updatedAt" WHERE "deliveryDoubt" AND "interruptedAt" IS NULL;
UPDATE "EmailMessage" SET "interruptedAt" = "updatedAt" WHERE "deliveryDoubt" AND "interruptedAt" IS NULL;

-- The guard, shared by the three tables (the table is TG_TABLE_NAME).
CREATE OR REPLACE FUNCTION message_review_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  o_outcome text;
  o_start timestamp(3);
  o_key text;
  o_subject text;
  resent boolean;
BEGIN
  IF TG_OP = 'INSERT' AND NEW."resendOfMessageId" IS NOT NULL THEN
    -- (subjectType through jsonb: the campaign table has no such column.)
    EXECUTE format('SELECT "reviewOutcome", coalesce("sendingStartedAt", "scheduledAt", "createdAt"), "dedupeKey", to_jsonb(x) ->> ''subjectType'' FROM %I x WHERE id = $1', TG_TABLE_NAME)
      INTO o_outcome, o_start, o_key, o_subject USING NEW."resendOfMessageId";
    -- An account-activation / password-reset link is never resent from the log: the link was revoked; a new one is
    -- issued from user management.
    IF o_key LIKE 'activation:%' OR o_subject = 'Employee' THEN
      RAISE EXCEPTION 'ACTIVATION_RESEND: رابط التفعيل لا يُعاد من السجل؛ أصدر رابطًا جديدًا من إدارة المستخدمين.' USING ERRCODE = 'P0001';
    END IF;
    IF o_outcome IS DISTINCT FROM 'NOT_DELIVERED' THEN
      RAISE EXCEPTION 'MESSAGE_RESEND_NOT_ALLOWED: لا تُعاد الرسالة إلا بعد تسجيل نتيجة التحقق «لم تصل».' USING ERRCODE = 'P0001';
    END IF;
    IF TG_TABLE_NAME = 'MktMessage' AND o_start < (now() AT TIME ZONE 'UTC') - interval '24 hours' THEN
      RAISE EXCEPTION 'RESEND_TOO_LATE: مرّت أكثر من 24 ساعة على أول محاولة إرسال، والرسالة التسويقية المتأخرة لا تُرسل.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."resendOfMessageId" IS DISTINCT FROM OLD."resendOfMessageId" THEN
      RAISE EXCEPTION 'MESSAGE_RESEND_LINK: ربط إعادة الإرسال لا يتغيّر.' USING ERRCODE = 'P0001';
    END IF;
    IF (NEW."reviewOutcome", NEW."reviewNote", NEW."reviewedById", NEW."reviewedAt") IS DISTINCT FROM (OLD."reviewOutcome", OLD."reviewNote", OLD."reviewedById", OLD."reviewedAt") THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE "resendOfMessageId" = $1)', TG_TABLE_NAME) INTO resent USING OLD.id;
      IF resent THEN
        RAISE EXCEPTION 'MESSAGE_REVIEW_FROZEN: أُعيد إرسال هذه الرسالة؛ نتيجة مراجعتها لا تتغيّر.' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER "MktMessage_review_guard" BEFORE INSERT OR UPDATE ON "MktMessage" FOR EACH ROW EXECUTE FUNCTION message_review_guard();
CREATE TRIGGER "WhatsAppMessage_review_guard" BEFORE INSERT OR UPDATE ON "WhatsAppMessage" FOR EACH ROW EXECUTE FUNCTION message_review_guard();
CREATE TRIGGER "EmailMessage_review_guard" BEFORE INSERT OR UPDATE ON "EmailMessage" FOR EACH ROW EXECUTE FUNCTION message_review_guard();

-- The runtime role writes the three tables already (the senders); restated so this migration stands on its own.
-- A trigger function needs no EXECUTE grant to fire.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "MktMessage", "WhatsAppMessage", "EmailMessage" TO flowcom_app;
  END IF;
END $$;

COMMIT;
