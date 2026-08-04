import { parkTelemetryBatch, getParkedTelemetryBatches, removeParkedTelemetryBatch } from '../offline/db';

/**
 * Lightweight client-side telemetry. Design goals, matching the
 * assignment's spec:
 * - Batched: individual track() calls don't fire a network request each;
 *   they queue, and a batch flushes periodically — UNLESS marked
 *   `important`, which flushes immediately rather than waiting.
 * - PII-redacted: never send raw patient names or SOAP note content.
 * - Retried with backoff on failure; after MAX_RETRIES, the batch is
 *   parked in IndexedDB rather than dropped, and retried on a later
 *   flush cycle or app start.
 * - Doesn't lose events on tab close: flushes via sendBeacon.
 */

export interface TelemetryEvent {
  name: string;
  properties: Record<string, string | number | boolean | null>;
  timestamp: string;
}

const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH_SIZE = 20;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

let queue: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let recoveryAttempted = false;

const PII_KEYS = new Set(['patientName', 'displayName', 'content', 'sections', 'reason']);

function redact(properties: Record<string, unknown>): TelemetryEvent['properties'] {
  const clean: TelemetryEvent['properties'] = {};
  for (const [key, value] of Object.entries(properties)) {
    if (PII_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value;
    } else if (value === null) {
      clean[key] = null;
    }
  }
  return clean;
}

export function track(
  name: string,
  properties: Record<string, unknown> = {},
  options: { important?: boolean } = {}
) {
  queue.push({
    name,
    properties: redact(properties),
    timestamp: new Date().toISOString(),
  });

  ensureFlushTimer();
  attemptRecoveryOnce();

  if (options.important) {
    // Skip the batch-size/time thresholds entirely — flush right away.
    flushTelemetryQueue();
  } else if (queue.length >= MAX_BATCH_SIZE) {
    flushTelemetryQueue();
  }
}

function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (queue.length > 0) flushTelemetryQueue();
    // Also use the periodic tick as an opportunity to retry anything
    // parked from an earlier failure, without needing a new track() call.
    retryParkedBatches();
  }, FLUSH_INTERVAL_MS);
}

// On first use in a session, try to recover and resend anything parked
// from a previous session (e.g. the app crashed or was closed mid-retry).
function attemptRecoveryOnce() {
  if (recoveryAttempted) return;
  recoveryAttempted = true;
  retryParkedBatches();
}

async function sendBatch(events: TelemetryEvent[]): Promise<boolean> {
  try {
    const res = await fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendWithRetry(events: TelemetryEvent[]) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const ok = await sendBatch(events);
    if (ok) return;
    // Exponential backoff between retries, not a fixed delay.
    await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt));
  }
  // All retries exhausted — don't lose the data, park it for later
  // instead of silently dropping it.
  await parkTelemetryBatch(events);
}

async function retryParkedBatches() {
  const parked = await getParkedTelemetryBatches();
  for (const batch of parked) {
    const ok = await sendBatch(batch.events as TelemetryEvent[]);
    if (ok) {
      await removeParkedTelemetryBatch(batch.id);
    }
    // If it fails again, leave it parked — it'll be retried on the next
    // flush tick or the next session's recovery pass, rather than
    // re-attempting the full retry-with-backoff loop repeatedly here.
  }
}

export function flushTelemetryQueue(useBeacon = false) {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];

  if (useBeacon && navigator.sendBeacon) {
    // sendBeacon is synchronous-ish and designed exactly for page
    // teardown; it can't retry, so on unload we accept best-effort
    // delivery rather than the full retry/park pipeline.
    const blob = new Blob([JSON.stringify({ events: batch })], { type: 'application/json' });
    navigator.sendBeacon('/api/telemetry', blob);
    return;
  }

  // Fire-and-forget from track()'s perspective — sendWithRetry handles
  // its own retry/park logic internally.
  sendWithRetry(batch);
}

if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushTelemetryQueue(true);
  });
  window.addEventListener('pagehide', () => flushTelemetryQueue(true));
}