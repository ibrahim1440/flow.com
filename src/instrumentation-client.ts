// R1-d (owner 2-أ): browser errors reach Sentry only when NEXT_PUBLIC_SENTRY_DSN is set; the SDK is loaded on demand
// then (nothing is downloaded otherwise), and every event is scrubbed of personal data (lib/observability/scrub.ts).
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  void Promise.all([import("@sentry/nextjs"), import("./lib/observability/scrub")]).then(([Sentry, { sentryOptions }]) => {
    Sentry.init(sentryOptions(dsn, process.env.NEXT_PUBLIC_VERCEL_ENV) as Parameters<typeof Sentry.init>[0]);
  });
}
