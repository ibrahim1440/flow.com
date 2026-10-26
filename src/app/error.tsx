"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";
import { ErrorScreen } from "@/components/errors/ErrorScreen";

/**
 * The generic error page (owner language decision 5): any page that throws unexpectedly shows this
 * instead of Next.js's English default — in the page's language with the other beneath, a retry and a
 * way home. The error's message and stack are never drawn (ErrorScreen).
 */
export default function AppError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => {
    // The browser console only (the server already logged a server error under the same digest).
    console.error(error);
  }, [error]);
  return <ErrorScreen digest={error.digest} onRetry={() => unstable_retry()} />;
}
