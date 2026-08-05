// Scenario 4: A REJECTED note gets resubmitted by its clinician, but in
// the meantime an admin has already edited (superseded) the version the
// clinician's resubmission was based on. Proves: resubmit still goes
// through baseVersionId/409 checking like any other save — a clinician
// can't silently resubmit stale content just because they have the
// resubmit permission.
//
// Usage: npx tsx scripts/scenario_4_resubmit_after_supersede.ts

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
  console.log('=== Scenario 4: Resubmit after supersede ===');

  await withRetry(() => postRaw('/api/dev/seed', { count: 20 }));
  const list = await withRetry(() => getRaw('/api/notes?status=READY_FOR_REVIEW&limit=1'));
  const note = list.body.items?.[0];
  console.log(`Using note ${note.id}`);

  // Get it into REJECTED: start_review, then reject.
  const reviewerId = 'dr_a';
  await withRetry(() =>
    postRaw(`/api/notes/${note.id}/transitions`, {
      event: { type: 'start_review', actor: { id: reviewerId, role: 'REVIEWER' } },
    })
  );
  await withRetry(() =>
    postRaw(`/api/notes/${note.id}/transitions`, {
      event: {
        type: 'reject',
        actor: { id: reviewerId, role: 'REVIEWER' },
        reason: 'missing plan',
      },
    })
  );

  const afterReject = (await withRetry(() => getRaw(`/api/notes/${note.id}`))).body;
  assert(afterReject.status === 'REJECTED', 'Note reached REJECTED status');
  const versionClinicianThinksIsCurrent = afterReject.currentVersion.id;

  // Admin edits the note WHILE it's rejected (e.g. correcting something
  // before the clinician gets to it) — this becomes the new head.
  const adminSave = await withRetry(() =>
    postRaw(`/api/notes/${note.id}/versions`, {
      baseVersionId: versionClinicianThinksIsCurrent,
      content: {
        sections: { ...afterReject.currentVersion.content.sections, A: 'Admin correction' },
      },
      clientMutationId: 'admin_supersede_edit',
    })
  );
  assert(adminSave.status === 200, "Admin's superseding edit succeeds");

  // Now the CLINICIAN tries to resubmit, still holding the version from
  // BEFORE the admin's edit (they haven't refreshed). This must conflict
  // — resubmit is not exempt from baseVersionId checking just because
  // it's also a role-permitted status transition.
  const clinicianResubmitSave = await withRetry(() =>
    postRaw(`/api/notes/${note.id}/versions`, {
      baseVersionId: versionClinicianThinksIsCurrent, // stale — admin already moved the head
      content: {
        sections: { ...afterReject.currentVersion.content.sections, P: 'Clinician resubmit edit' },
      },
      clientMutationId: 'clinician_resubmit_edit',
    })
  );
  assert(
    clinicianResubmitSave.status === 409,
    "Clinician's resubmit save (based on pre-admin-edit version) is rejected with 409"
  );
  assert(
    clinicianResubmitSave.body.current?.id === adminSave.body.version.id,
    "Conflict correctly points at the admin's version as the real current head"
  );

  // The status-transition side of resubmit is a SEPARATE call in our
  // API (transitions vs. versions) — confirm that's still guarded
  // correctly too: a CLINICIAN role can call resubmit, a non-clinician
  // cannot.
  const wrongRoleResubmit = await withRetry(() =>
    postRaw(`/api/notes/${note.id}/transitions`, {
      event: { type: 'resubmit', actor: { id: 'dr_b', role: 'REVIEWER' } },
    })
  );
  assert(
    wrongRoleResubmit.status === 403,
    'A REVIEWER (wrong role) attempting resubmit is rejected with 403'
  );

  console.log('=== Scenario 4 complete ===');
}

main().catch((err) => {
  console.error('Scenario 4 crashed:', err);
  process.exit(1);
});