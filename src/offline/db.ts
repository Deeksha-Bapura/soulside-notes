import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

// One queued write: a save-version request that couldn't be sent yet.
// We store enough to replay it later exactly as if it had just been typed.
export interface QueuedWrite {
  id: string; // == clientMutationId, so it doubles as the idempotency key
  noteId: string;
  baseVersionId: string;
  content: { sections: { S: string; O: string; A: string; P: string } };
  queuedAt: string;
}

interface SoulsideDB extends DBSchema {
  writeQueue: {
    key: string;
    value: QueuedWrite;
    indexes: { 'by-noteId': string };
  };
}

let dbPromise: Promise<IDBPDatabase<SoulsideDB>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<SoulsideDB>('soulside-offline', 1, {
      upgrade(db) {
        const store = db.createObjectStore('writeQueue', { keyPath: 'id' });
        store.createIndex('by-noteId', 'noteId');
      },
    });
  }
  return dbPromise;
}

export async function enqueueWrite(write: QueuedWrite): Promise<void> {
  const db = await getDb();
  await db.put('writeQueue', write);
}

export async function getQueuedWrites(): Promise<QueuedWrite[]> {
  const db = await getDb();
  // Sorted by queuedAt so replay happens in the order the user made the
  // edits, not insertion order into IndexedDB (which should match, but
  // being explicit here is cheap insurance).
  const all = await db.getAll('writeQueue');
  return all.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function getQueuedWritesForNote(noteId: string): Promise<QueuedWrite[]> {
  const db = await getDb();
  return db.getAllFromIndex('writeQueue', 'by-noteId', noteId);
}

export async function removeQueuedWrite(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('writeQueue', id);
}

export async function clearQueuedWritesForNote(noteId: string): Promise<void> {
  const db = await getDb();
  const writes = await db.getAllFromIndex('writeQueue', 'by-noteId', noteId);
  await Promise.all(writes.map((w) => db.delete('writeQueue', w.id)));
}