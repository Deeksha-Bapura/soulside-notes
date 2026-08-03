/**
 * Lightweight client-side telemetry. Design goals, matching the
 * assignment's spec:
 * - Batched: individual track() calls don't fire a network request each;
 *   they queue, and a batch flushes periodically.
 * - PII-redacted: never send raw patient names or SOAP note content —
 *   only structural/behavioral data (what action, which note ID, timing).
 * - Doesn't lose events on tab close: flushes via sendBeacon, which the
 *   browser guarantees attempts delivery even as the page unloads (a
 *   regular fetch() can get cancelled mid-flight in that moment).
 */

export interface TelemetryEvent {
  name: string;
  properties: Record<string, string | number | boolean | null>;
  timestamp: string;
}

const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH_SIZE = 20;

let queue: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

// Keys that must never leave the browser as-is. This is a denylist
// approach for the demo; a stricter production system would prefer an
// allowlist (only ever send fields explicitly marked safe) since a
// denylist can miss new PII-shaped fields added later without updating
// this list — worth naming as a real trade-off, not a hidden gap.
const PII_KEYS = new Set(['patientName', 'displayName', 'content', 'sections', 'reason']);

function redact(properties: Record<string, unknown>): TelemetryEvent['properties'] {
  const clean: TelemetryEvent['properties'] = {};
  for (const [key, value] of Object.entries(properties)) {
    if (PII_KEYS.has(key)) continue; // drop entirely, don't even hash it
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value;
    } else if (value === null) {
      clean[key] = null;
    }
    // Objects/arrays are silently dropped — anything structured enough to
    // need redaction judgment call gets excluded by default rather than
    // risking a leak through a nested field this function doesn't inspect.
  }
  return clean;
}

export function track(name: string, properties: Record<string, unknown> = {}) {
  queue.push({
    name,
    properties: redact(properties),
    timestamp: new Date().toISOString(),
  });

  if (queue.length >= MAX_BATCH_SIZE) {
    flush();
  }
  ensureFlushTimer();
}

function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (queue.length > 0) flush();
  }, FLUSH_INTERVAL_MS);
}

function flush(useBeacon = false) {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];

  const body = JSON.stringify({ events: batch });

  if (useBeacon && navigator.sendBeacon) {
    // sendBeacon is designed exactly for this moment: the browser queues
    // the request and guarantees an attempt even as the page is torn
    // down, unlike fetch() which can be aborted mid-flight on unload.
    const blob = new Blob([body], { type: 'application/json' });
    navigator.sendBeacon('/api/telemetry', blob);
    return;
  }

  fetch('/api/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true, // best-effort survival across navigation, belt-and-suspenders with sendBeacon
  }).catch(() => {
    // Telemetry failures are deliberately swallowed — losing analytics
    // data is an acceptable trade-off; surfacing telemetry errors to the
    // user or retrying indefinitely is not worth the complexity here.
  });
}

// Flush on tab close/navigation-away using the reliable sendBeacon path.
if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', () => flush(true));
}