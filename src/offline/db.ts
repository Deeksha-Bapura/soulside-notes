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

export interface ParkedTelemetryBatch {
  id: string;
  events: unknown[];
  parkedAt: string;
}

interface SoulsideDB extends DBSchema {
  writeQueue: {
    key: string;
    value: QueuedWrite;
    indexes: { 'by-noteId': string };
  };
  telemetryQueue: {
    key: string;
    value: ParkedTelemetryBatch;
  };
}

let dbPromise: Promise<IDBPDatabase<SoulsideDB>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<SoulsideDB>('soulside-offline', 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const store = db.createObjectStore('writeQueue', { keyPath: 'id' });
          store.createIndex('by-noteId', 'noteId');
        }
        if (oldVersion < 2) {
          db.createObjectStore('telemetryQueue', { keyPath: 'id' });
        }
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

export async function parkTelemetryBatch(events: unknown[]): Promise<void> {
  const db = await getDb();
  await db.put('telemetryQueue', {
    id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    events,
    parkedAt: new Date().toISOString(),
  });
}

export async function getParkedTelemetryBatches(): Promise<ParkedTelemetryBatch[]> {
  const db = await getDb();
  return db.getAll('telemetryQueue');
}

export async function removeParkedTelemetryBatch(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('telemetryQueue', id);
}