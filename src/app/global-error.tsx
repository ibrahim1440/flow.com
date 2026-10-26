"use client"; // Error boundaries must be Client Components.

import { ErrorScreen } from "@/components/errors/ErrorScreen";

/**
 * When the root layout itself fails, this replaces it (it must draw its own <html> and <body>).
 * Same screen as src/app/error.tsx (owner language decision 5); the language is unknown here, so the
 * document starts in Arabic and the screen shows English beneath it.
 */
export default function GlobalError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  return (
    <html lang="ar" dir="rtl">
      <body style={{ margin: 0 }}>
        <title>حدث خطأ · Something went wrong</title>
        <ErrorScreen digest={error.digest} onRetry={() => unstable_retry()} />
      </body>
    </html>
  );
}
