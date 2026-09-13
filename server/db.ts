import { MongoClient, type Db } from 'mongodb';

/**
 * A single shared MongoDB connection for the whole server process.
 * We connect once on startup and reuse the same client/db handle for
 * every request, rather than opening a new connection per request —
 * MongoDB's driver already pools connections internally, so a single
 * long-lived client is the correct pattern, not an optimization we're
 * adding on top.
 */

import { readFileSync } from 'fs';

function buildMongoUrl(): string {
  // If MONGO_URL is set directly (e.g. local dev without Docker), use it as-is.
  if (process.env.MONGO_URL) return process.env.MONGO_URL;

  // Otherwise, assemble from pieces + a Docker secret file (Compose path).
  const host = process.env.MONGO_HOST ?? '127.0.0.1';
  const user = process.env.MONGO_USER;
  const passwordFile = process.env.MONGO_PASSWORD_FILE;

  if (user && passwordFile) {
    const password = readFileSync(passwordFile, 'utf-8').trim();
    return `mongodb://${user}:${encodeURIComponent(password)}@${host}:27017/?authSource=admin`;
  }

  return `mongodb://${host}:27017`;
}

const MONGO_URL = buildMongoUrl();
const DB_NAME = process.env.MONGO_DB_NAME ?? 'soulside';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectToDatabase(): Promise<Db> {
  if (db) return db;

  client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db(DB_NAME);

  console.log(`Connected to MongoDB at ${MONGO_URL}, database "${DB_NAME}"`);
  return db;
}

export function getDb(): Db {
  if (!db) {
    throw new Error('Database not initialized — call connectToDatabase() first');
  }
  return db;
}

export async function closeDatabaseConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}