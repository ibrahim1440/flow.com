-- R1-e gate M1 (orchestrator, on be2f425a): a resend of a resend must not restart the resend window. The guard
-- message_review_guard() (20261231200000_message_review) measured the campaign 24 h from the row being resent; it now
-- follows "resendOfMessageId" back to the ROOT original and measures from that message's first attempt.
-- Only the function body changes: no table, column, grant or trigger is added (the three triggers keep calling it).
-- Rollback: docs/hr/migration-review/rollback-20261231210000_message_resend_root.sql restores the previous body.
CREATE OR REPLACE FUNCTION message_review_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  o_outcome text;
  o_start timestamp(3);
  o_root text;
  o_parent text;
  depth int := 0;
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
    -- Gate M1: the campaign window is the ROOT original's — follow resendOfMessageId back to the first message, so a
    -- resend of a resend never restarts it (FK + not-self make a cycle impossible; the depth bound is a belt).
    o_root := NEW."resendOfMessageId";
    LOOP
      EXECUTE format('SELECT "resendOfMessageId" FROM %I WHERE id = $1', TG_TABLE_NAME) INTO o_parent USING o_root;
      EXIT WHEN o_parent IS NULL;
      o_root := o_parent;
      depth := depth + 1;
      IF depth > 50 THEN
        RAISE EXCEPTION 'MESSAGE_RESEND_CHAIN: سلسلة إعادة الإرسال أطول من المسموح.' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    IF o_root IS DISTINCT FROM NEW."resendOfMessageId" THEN
      EXECUTE format('SELECT coalesce("sendingStartedAt", "scheduledAt", "createdAt") FROM %I WHERE id = $1', TG_TABLE_NAME) INTO o_start USING o_root;
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
