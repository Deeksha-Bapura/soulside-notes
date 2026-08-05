// simulate_workflow.ts — Happy-path + light concurrency simulation
// Usage: npx tsx scripts/simulate_workflow.ts [BASE_URL]
//
// Reconstructed from the assignment's provided excerpt, adapted to our
// actual endpoint shapes (our /transitions endpoint expects a machine
// `event` object, not a flat {to, actorId} — see server-side enforcement
// work). Simulates a realistic reviewer workday:
//   1. Seed the store with 5,000 notes
//   2. Spawn 3 reviewer "actors" who each pick READY_FOR_REVIEW notes,
//      start a review, apply 1–3 edits, then approve or reject
//   3. Our backend already injects its own latency/failure rates
//      independently, so this script doesn't need to add its own —
//      it exercises OUR real failure injection rather than simulating
//      a separate one, which is arguably more honest than duplicating it.

const BASE = process.argv[2] ?? 'http://localhost:3001';

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

function rand(n: number) {
  return Math.floor(Math.random() * n);
}

function uuid() {
  return `mut_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function mutateContent(content: { sections: Record<string, string> }) {
  const keys = Object.keys(content.sections);
  const key = keys[rand(keys.length)];
  return {
    sections: {
      ...content.sections,
      [key]: content.sections[key] + ` [edit ${Date.now()}]`,
    },
  };
}

interface NoteListItem {
  id: string;
  status: string;
}

let conflictCount = 0;
let errorCount = 0;
let successfulSaves = 0;

async function pickReadyNote(): Promise<NoteListItem | null> {
  const list = await get('/api/notes?status=READY_FOR_REVIEW&limit=50');
  const items: NoteListItem[] = list.items;
  if (items.length === 0) return null;
  return items[rand(items.length)];
}

const seed = async () => {
  await post('/api/dev/seed', { count: 5000 });
  console.log('Seeded 5000 notes.');
};

const reviewerLoop = async (reviewerId: string) => {
  for (let i = 0; i < 20; i++) {
    try {
      const note = await pickReadyNote();
      if (!note) {
        console.log(`[${reviewerId}] no READY_FOR_REVIEW notes available, skipping iteration ${i}`);
        continue;
      }

      await post(`/api/notes/${note.id}/transitions`, {
        event: { type: 'start_review', actor: { id: reviewerId, role: 'REVIEWER' } },
      });

      const editCount = 1 + rand(3);
      for (let e = 0; e < editCount; e++) {
        const head = await get(`/api/notes/${note.id}`);
        try {
          await post(`/api/notes/${note.id}/versions`, {
            baseVersionId: head.currentVersion.id,
            content: mutateContent(head.currentVersion.content),
            clientMutationId: uuid(),
          });
          successfulSaves++;
        } catch (err) {
          const message = (err as Error).message;
          if (message.includes('409')) {
            conflictCount++;
          } else {
            errorCount++;
          }
        }
      }

      const outcome = Math.random() < 0.7 ? 'APPROVED' : 'REJECTED';
      await post(`/api/notes/${note.id}/transitions`, {
        event:
          outcome === 'APPROVED'
            ? { type: 'approve', actor: { id: reviewerId, role: 'REVIEWER' }, mfaVerified: true }
            : {
                type: 'reject',
                actor: { id: reviewerId, role: 'REVIEWER' },
                reason: 'missing plan',
              },
      });
    } catch (err) {
      errorCount++;
      console.error(`[${reviewerId}] iteration ${i} failed:`, (err as Error).message);
    }
  }
  console.log(`[${reviewerId}] done.`);
};

async function main() {
  console.log(`Running simulation against ${BASE}`);
  await seed();
  await Promise.all(['dr_a', 'dr_b', 'dr_c'].map(reviewerLoop));
  console.log('=== Simulation complete ===');
  console.log(`Successful saves: ${successfulSaves}`);
  console.log(`Version conflicts encountered: ${conflictCount}`);
  console.log(`Unexpected errors: ${errorCount}`);
  console.log('Verify: no unhandled conflicts, no lost writes, server logs show telemetry batches if any client was running concurrently.');
}

main().catch((err) => {
  console.error('Simulation failed:', err);
  process.exit(1);
});