import { connectToDatabase } from './db';
import type { Note, NoteVersion, ReviewEvent, Role } from '../src/domain/types';
import { randomUUID } from 'crypto';

// --- Deterministic pseudo-random generator (mulberry32) ---
// We don't use Math.random() directly because it can't be seeded — we want
// the SAME fake dataset every time we reseed with the same count.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);

// All 8 statuses from the domain model.
const STATUSES = [
  'READY_FOR_REVIEW', 'IN_REVIEW', 'APPROVED', 'LOCKED',
  'REJECTED', 'GENERATING', 'FAILED', 'AMENDED',
] as const;

const FIRST_NAMES = ['Riley', 'Jordan', 'Sam', 'Casey', 'Morgan', 'Avery', 'Quinn', 'Reese'];
const LAST_INITIALS = ['A.', 'B.', 'C.', 'D.', 'E.', 'F.', 'G.'];

// A fixed pool of patients that notes are drawn FROM, rather than every
// note getting a brand-new random patient — this is what makes filtering
// by patient meaningful, since real patients have multiple notes.
const PATIENT_POOL_SIZE = 150;

export const REVIEWERS = ['dr_a', 'dr_b', 'dr_c', 'dr_d'];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

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

/**
 * Seeds the database with deterministic fake data. Unlike the earlier
 * in-memory version, this now actually writes to MongoDB collections —
 * meaning the data survives a server restart, which is the entire point
 * of adding a real database in the first place.
 */
export async function seed(count: number) {
  const db = await connectToDatabase();
  const notesCol = db.collection<Note>('notes');
  const versionsCol = db.collection<NoteVersion>('versions');
  const eventsCol = db.collection<ReviewEvent>('events');

  // Clear existing data before reseeding — this is a dev/test
  // convenience endpoint, not something a real production system
  // would expose.
  await notesCol.deleteMany({});
  await versionsCol.deleteMany({});
  await eventsCol.deleteMany({});

  const patientPool = buildPatientPool();
  const notesToInsert: Note[] = [];
  const versionsToInsert: NoteVersion[] = [];
  const eventsToInsert: ReviewEvent[] = [];

  for (let i = 0; i < count; i++) {
    const noteId = `note_${i.toString(36).padStart(6, '0')}`;
    const versionId = `ver_${i.toString(36).padStart(6, '0')}_1`;
    const status = pick(STATUSES);
    const now = new Date(Date.now() - Math.floor(rand() * 1000 * 60 * 60 * 24 * 30)).toISOString();
    const patient = pick(patientPool);

    versionsToInsert.push({
      id: versionId,
      noteId,
      revision: 1,
      parentVersionId: null,
      content: makeContent(),
      authorId: 'usr_clinician_seed',
      authorRole: 'CLINICIAN' as Role,
      createdAt: now,
    });

    notesToInsert.push({
      id: noteId,
      patient,
      sessionId: `sess_${i}`,
      status,
      currentVersionId: versionId,
      assignedReviewerId: status === 'IN_REVIEW' ? pick(REVIEWERS) : null,
      createdAt: now,
      updatedAt: now,
    });

    eventsToInsert.push({
      id: `evt_${i.toString(36).padStart(6, '0')}_1`,
      noteId,
      versionId,
      fromStatus: null,
      toStatus: status,
      actorId: 'usr_clinician_seed',
      actorRole: 'CLINICIAN',
      occurredAt: now,
    });
  }

  // Bulk insert rather than one insert per document — the difference
  // between roughly one round trip and thousands of them at 100k scale.
  if (notesToInsert.length > 0) {
    await notesCol.insertMany(notesToInsert);
    await versionsCol.insertMany(versionsToInsert);
    await eventsCol.insertMany(eventsToInsert);
  }

  console.log(`Seeded ${count} notes into MongoDB.`);
}

// --- Note operations ---

export async function getNote(id: string): Promise<Note | null> {
  const db = await connectToDatabase();
  return db.collection<Note>('notes').findOne({ id }, { projection: { _id: 0 } });
}

export async function saveNote(note: Note): Promise<void> {
  const db = await connectToDatabase();
  await db.collection<Note>('notes').replaceOne({ id: note.id }, note, { upsert: true });
}

export async function findNotes(filter: Record<string, unknown>): Promise<Note[]> {
  const db = await connectToDatabase();
  return db.collection<Note>('notes').find(filter, { projection: { _id: 0 } }).toArray();
}

// --- Version operations ---

export async function getVersion(id: string): Promise<NoteVersion | null> {
  const db = await connectToDatabase();
  return db.collection<NoteVersion>('versions').findOne({ id }, { projection: { _id: 0 } });
}

export async function saveVersion(version: NoteVersion): Promise<void> {
  const db = await connectToDatabase();
  await db.collection<NoteVersion>('versions').insertOne(version);
}

export async function getVersionsForNote(noteId: string): Promise<NoteVersion[]> {
  const db = await connectToDatabase();
  return db.collection<NoteVersion>('versions').find({ noteId }, { projection: { _id: 0 } }).toArray();
}

export async function findVersionByParent(
  noteId: string,
  parentVersionId: string | null
): Promise<NoteVersion | null> {
  const db = await connectToDatabase();
  return db.collection<NoteVersion>('versions').findOne(
    { noteId, parentVersionId },
    { projection: { _id: 0 } }
  );
}

// --- Event operations ---

export async function saveEvent(event: ReviewEvent): Promise<void> {
  const db = await connectToDatabase();
  await db.collection<ReviewEvent>('events').insertOne(event);
}

export async function getEventsForNote(noteId: string): Promise<ReviewEvent[]> {
  const db = await connectToDatabase();
  return db.collection<ReviewEvent>('events').find({ noteId }, { projection: { _id: 0 } }).toArray();
}

// --- approvedAt tracking ---
// Previously a plain in-memory Map; now a dedicated small collection,
// since it needs to survive restarts just like everything else now does.

export async function getApprovedAt(noteId: string): Promise<number | null> {
  const db = await connectToDatabase();
  const doc = await db.collection('approved_at').findOne({ noteId });
  return doc ? (doc.approvedAt as number) : null;
}

export async function setApprovedAt(noteId: string, timestamp: number): Promise<void> {
  const db = await connectToDatabase();
  await db.collection('approved_at').replaceOne(
    { noteId },
    { noteId, approvedAt: timestamp },
    { upsert: true }
  );
}

// --- Mutation idempotency tracking ---
// Previously a plain in-memory Set; now persisted, so a server restart
// mid-session doesn't forget which client mutations were already applied.

export async function hasSeenMutation(mutationId: string): Promise<boolean> {
  const db = await connectToDatabase();
  const doc = await db.collection('seen_mutations').findOne({ mutationId });
  return doc !== null;
}

export async function markMutationSeen(mutationId: string): Promise<void> {
  const db = await connectToDatabase();
  await db.collection('seen_mutations').updateOne(
    { mutationId },
    { $set: { mutationId } },
    { upsert: true }
  );
}

// --- ID generation ---
// Previously relied on a module-level counter plus Date.now(); that
// counter would reset to 0 on every server restart. With an in-memory
// STORE that also reset on restart, this coincidentally never caused a
// visible problem — but now that data persists across restarts, a naive
// counter could eventually produce a colliding id. randomUUID() (built
// into Node, no extra dependency) sidesteps this properly.
export function nextId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}