// Scenario 2: Network drop mid-save with 3 pending mutations, then
// reconnect and replay.
//
// The offline QUEUE itself (IndexedDB, browser online/offline events) is
// frontend-only code, manually verified in the browser during
// development (see README, Offline section) — a Node script can't drive
// a real browser's IndexedDB or navigator.onLine. What THIS script
// verifies is the server-side contract the queue depends on: that
// several mutations queued while "offline" and replayed later apply in
// order, and that a duplicate replay (simulating a retry) doesn't create
// a duplicate version — the idempotency guarantee that makes offline
// replay safe in the first place.
//
// Usage: npx tsx scripts/scenario_2_offline_replay.ts

const BASE = process.argv[2] ?? 'http://localhost:3001';
const MAX_RETRIES = 5;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postRaw(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function getRaw(path: string) {
  const res = await fetch(`${BASE}${path}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function withRetry<T extends { status: number }>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = await fn();
    if (result.status !== 500) return result;
    await delay(200 * (attempt + 1));
  }
  throw new Error(`Exceeded ${MAX_RETRIES} retries`);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

async function main() {
  console.log('=== Scenario 2: Offline queue replay (server-side contract) ===');

  await withRetry(() => postRaw('/api/dev/seed', { count: 20 }));
  const list = await withRetry(() => getRaw('/api/notes?status=READY_FOR_REVIEW&limit=1'));
  const note = list.body.items?.[0];
  console.log(`Using note ${note.id}`);

  const head1 = (await withRetry(() => getRaw(`/api/notes/${note.id}`))).body;

  // Simulate: user made 3 edits while offline, each queued locally with
  // its own clientMutationId (this is exactly what our frontend's
  // enqueueWrite does — see src/offline/db.ts). "Reconnect" = replay
  // them now, in order, honoring baseVersionId as the queue does.
  const mutationId1 = 'offline_mut_1';
  const mutationId2 = 'offline_mut_2';
  const mutationId3 = 'offline_mut_3';

  const replay1 = await withRetry(() =>
    postRaw(`/api/notes/${note.id}/versions`, {
      baseVersionId: head1.currentVersion.id,
      content: { sections: { ...head1.currentVersion.content.sections, S: 'Offline edit 1' } },
      clientMutationId: mutationId1,
    })
  );
  assert(replay1.status === 200, 'Queued mutation #1 replays successfully');

  const replay2 = await withRetry(() =>
    postRaw(`/api/notes/${note.id}/versions`, {
      baseVersionId: replay1.body.version.id,
      content: { sections: { ...head1.currentVersion.content.sections, O: 'Offline edit 2' } },
      clientMutationId: mutationId2,
    })
  );
  assert(replay2.status === 200, 'Queued mutation #2 replays successfully, based on #1s result');

  const replay3 = await withRetry(() =>
    postRaw(`/api/notes/${note.id}/versions`, {
      baseVersionId: replay2.body.version.id,
      content: { sections: { ...head1.currentVersion.content.sections, A: 'Offline edit 3' } },
      clientMutationId: mutationId3,
    })
  );
  assert(replay3.status === 200, 'Queued mutation #3 replays successfully, based on #2s result');

  // Now simulate a RETRY of mutation #2 (e.g. the client's replay logic
  // re-sent it because it wasn't sure the first attempt's response made
  // it back before a further disconnect) — this must NOT create a 4th
  // version. clientMutationId idempotency should make this a no-op.
  const versionsBeforeRetry = (await withRetry(() => getRaw(`/api/notes/${note.id}`))).body.versions
    .length;

  const retryOfMutation2 = await withRetry(() =>
    postRaw(`/api/notes/${note.id}/versions`, {
      baseVersionId: replay1.body.version.id,
      content: { sections: { ...head1.currentVersion.content.sections, O: 'Offline edit 2' } },
      clientMutationId: mutationId2, // SAME id as before — simulating a retry
    })
  );
  assert(
    retryOfMutation2.status === 200,
    'Retried mutation #2 (same clientMutationId) is accepted, not treated as an error'
  );

  const versionsAfterRetry = (await withRetry(() => getRaw(`/api/notes/${note.id}`))).body.versions
    .length;
  assert(
    versionsAfterRetry === versionsBeforeRetry,
    `Retry did not create a duplicate version (before: ${versionsBeforeRetry}, after: ${versionsAfterRetry})`
  );

  console.log('=== Scenario 2 complete ===');
}

main().catch((err) => {
  console.error('Scenario 2 crashed:', err);
  process.exit(1);
});