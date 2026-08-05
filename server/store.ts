// In-memory data store for the dummy backend. Deterministic seeding means
// every `npm run seed` (or server restart) produces the same dataset, so
// simulation runs are reproducible — required by the assignment.

import type { Note, NoteVersion, ReviewEvent, NoteStatus, Role } from '../src/domain/types';

// --- Deterministic pseudo-random generator (mulberry32) ---
// We don't use Math.random() directly because it can't be seeded — we want
// the SAME fake dataset every time the server restarts.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42); // fixed seed = reproducible dataset

// All 8 statuses from the domain model — previously this list was missing
// FAILED and AMENDED, meaning no seeded note could ever land in either
// state, which silently broke any testing of those statuses (including
// the "read-only LOCKED" and "bulk regenerate FAILED notes" features).
const STATUSES: NoteStatus[] = [
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'APPROVED',
  'LOCKED',
  'REJECTED',
  'GENERATING',
  'FAILED',
  'AMENDED',
];

const FIRST_NAMES = ['Riley', 'Jordan', 'Sam', 'Casey', 'Morgan', 'Avery', 'Quinn', 'Reese'];
const LAST_INITIALS = ['A.', 'B.', 'C.', 'D.', 'E.', 'F.', 'G.'];

// A fixed pool of patients that notes are drawn FROM, rather than every
// note getting a brand-new random patient. This is what makes the
// "filter by patient" feature actually demonstrate its value — a real
// clinical dataset has patients with multiple notes across visits, not
// one note per patient. Pool size (150) is deliberately smaller than the
// note count so repeats are common.
const PATIENT_POOL_SIZE = 150;

function buildPatientPool() {
  const pool: Array<{ id: string; displayName: string }> = [];
  for (let i = 0; i < PATIENT_POOL_SIZE; i++) {
    pool.push({
      id: `pat_${i.toString(36).padStart(4, '0')}`,
      displayName: `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}`,
    });
  }
  return pool;
}

export const notes = new Map<string, Note>();
export const versions = new Map<string, NoteVersion>();
export const events = new Map<string, ReviewEvent>();

// Tracks when a note entered APPROVED, needed by the shared state machine's
// 24h amend-grace guard. Kept server-side only (not part of the shared
// Note type) since it's transition-evaluation bookkeeping, not domain data
// the frontend needs to display directly.
export const approvedAtMap = new Map<string, number>();

// Reviewer pool used by the simulation script (dr_a, dr_b, dr_c) plus a few extra.
export const REVIEWERS = ['dr_a', 'dr_b', 'dr_c', 'dr_d'];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function makeContent(): NoteVersion['content'] {
  return {
    sections: {
      S: 'Patient reports mild discomfort, no acute distress.',
      O: 'Vitals stable. HR 72, BP 118/76.',
      A: 'Consistent with prior presentation.',
      P: 'Continue current plan, follow up in 2 weeks.',
    },
  };
}

export function seed(count: number) {
  notes.clear();
  versions.clear();
  events.clear();

  const patientPool = buildPatientPool();

  for (let i = 0; i < count; i++) {
    const noteId = `note_${i.toString(36).padStart(6, '0')}`;
    const versionId = `ver_${i.toString(36).padStart(6, '0')}_1`;
    const status = pick(STATUSES);
    const now = new Date(Date.now() - Math.floor(rand() * 1000 * 60 * 60 * 24 * 30)).toISOString();
    const patient = pick(patientPool);

    const version: NoteVersion = {
      id: versionId,
      noteId,
      revision: 1,
      parentVersionId: null,
      content: makeContent(),
      authorId: 'usr_clinician_seed',
      authorRole: 'CLINICIAN' as Role,
      createdAt: now,
    };
    versions.set(versionId, version);

    const note: Note = {
      id: noteId,
      patient,
      sessionId: `sess_${i}`,
      status,
      currentVersionId: versionId,
      assignedReviewerId: status === 'IN_REVIEW' ? pick(REVIEWERS) : null,
      createdAt: now,
      updatedAt: now,
    };
    notes.set(noteId, note);

    const event: ReviewEvent = {
      id: `evt_${i.toString(36).padStart(6, '0')}_1`,
      noteId,
      versionId,
      fromStatus: null,
      toStatus: status,
      actorId: 'usr_clinician_seed',
      actorRole: 'CLINICIAN',
      occurredAt: now,
    };
    events.set(event.id, event);
  }

  console.log(`Seeded ${count} notes.`);
}

let idCounter = 0;
export function nextId(prefix: string) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}