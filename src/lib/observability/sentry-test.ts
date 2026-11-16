// R1-d (owner, before the R1-d release): a synthetic error to prove two things in the owner's own Sentry project — that
// errors arrive, and that personal data does not (lib/observability/scrub.ts). Every value below is FAKE; each is one of
// the kinds the scrubber must remove. Pure, so the scrubbing of this exact error is unit-tested.
export const SENTRY_TEST_FAKES = {
  email: "test.user@example.com",
  iban: "SA0380000000608010167519",
  phone: "0551234567",
  longNumber: "1234567890123",
  token: "abc",
} as const;

/** The error both sides send: `side` says which one sent it (it is the only part meant to survive). */
export function sentryTestError(side: "server" | "browser"): Error {
  const f = SENTRY_TEST_FAKES;
  const err = new Error(
    `Sentry test (${side}) — synthetic, safe to ignore: customer ${f.email} IBAN ${f.iban} phone ${f.phone} id ${f.longNumber} at /api/ops/sentry-test?token=${f.token}`,
  );
  err.name = "SentryTestError";
  return err;
}
