// Scenario 1: Two reviewers editing the same note in overlapping windows.
// Proves: the second writer's save correctly gets a 409, with a
// current+commonAncestor payload — never a silent overwrite.
//
// Our backend injects a real 5% random failure rate on every route (by
// design, from Step 5) — so this script retries any transient 500
// before treating a response as final, rather than assuming every call
// succeeds. This mirrors what a real client (with its own retry logic)
// would do, and avoids the test being flaky for reasons unrelated to
// what it's actually verifying.
//
// Usage: npx tsx scripts/scenario_1_concurrent_edit.ts

const BASE = process.argv[2] ?? 'http://localhost:3001';
const MAX_RETRIES = 5;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postRaw(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function getRaw(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// Retries only on our OWN simulated 500 (transient, meaningless to this
// test); a real 409/403/etc. is returned immediately since those are
// meaningful results the test needs to see, not noise to retry past.
async function withRetry<T extends { status: number }>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = await fn();
    if (result.status !== 500) return result;
    await delay(200 * (attempt + 1));
  }
  throw new Error(`Exceeded ${MAX_RETRIES} retries — backend kept returning 500`);
}

function uuid() {
  return `mut_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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
  console.log('=== Scenario 1: Concurrent edit conflict ===');

  await withRetry(() => postRaw('/api/dev/seed', { count: 20 }));
  const list = await withRetry(() => getRaw('/api/notes?status=READY_FOR_REVIEW&limit=1'));
  const note = list.body.items?.[0];
  if (!note) {
    console.error('No READY_FOR_REVIEW note available to test with.');
    process.exit(1);
  }
  console.log(`Using note ${note.id}`);

  const initialHeadRes = await withRetry(() => getRaw(`/api/notes/${note.id}`));
  const initialHead = initialHeadRes.body;
  const baseVersionId = initialHead.currentVersion.id;

  // Reviewer A saves first — this should succeed cleanly.
  const saveA = await withRetry(() =>
    postRaw(`/api/notes/${note.id}/versions`, {
      baseVersionId,
      content: { sections: { ...initialHead.currentVersion.content.sections, S: 'Edited by A' } },
      clientMutationId: uuid(),
    })
  );
  assert(saveA.status === 200, "Reviewer A's save (first) succeeds");

  // Reviewer B saves next, still based on the ORIGINAL baseVersionId —
  // must conflict (409), never silently overwrite A's work. A 500 here
  // is retried (transient noise); a 409 is the real, meaningful result.
  const saveB = await withRetry(() =>
    postRaw(`/api/notes/${note.id}/versions`, {
      baseVersionId, // deliberately stale
      content: { sections: { ...initialHead.currentVersion.content.sections, S: 'Edited by B' } },
      clientMutationId: uuid(),
    })
  );
  assert(saveB.status === 409, "Reviewer B's save (second, stale base) is rejected with 409");
  assert(saveB.body.error === 'version_conflict', 'Conflict response has error: version_conflict');
  assert(
    !!saveB.body.current && saveB.body.current.id === saveA.body.version.id,
    "Conflict response's 'current' points at A's just-saved version"
  );
  assert(
    !!saveB.body.commonAncestor && saveB.body.commonAncestor.id === baseVersionId,
    "Conflict response's 'commonAncestor' points at the original shared base"
  );

  const finalNoteRes = await withRetry(() => getRaw(`/api/notes/${note.id}`));
  const finalNote = finalNoteRes.body;
  assert(
    finalNote.currentVersion?.content?.sections?.S === 'Edited by A',
    "The note's current content is still A's edit — B's write did not overwrite it"
  );

  console.log('=== Scenario 1 complete ===');
}

main().catch((err) => {
  console.error('Scenario 1 crashed:', err);
  process.exit(1);
});