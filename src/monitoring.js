// Centralized error monitoring. No-op when REACT_APP_SENTRY_DSN is absent
// (local dev / unconfigured), so nothing breaks without a DSN.
import * as Sentry from "@sentry/react";

const dsn = process.env.REACT_APP_SENTRY_DSN;
let enabled = false;

export function initMonitoring() {
  if (!dsn) return; // no DSN -> stay silent, no network calls
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "production",
    // Capture unhandled errors + promise rejections automatically.
    // Keep tracing off to stay within the free tier; flip on if needed.
    tracesSampleRate: 0,
    // Strip obvious noise.
    ignoreErrors: ["ResizeObserver loop limit exceeded"],
  });
  enabled = true;
}

// Call from catch blocks to report a swallowed error with context.
// Falls back to console.error when Sentry is not configured.
export function reportError(error, context) {
  if (enabled) {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  } else {
    // eslint-disable-next-line no-console
    console.error("[reportError]", error, context || "");
  }
}
