import { MongoClient, type Db } from 'mongodb';

/**
 * A single shared MongoDB connection for the whole server process.
 * We connect once on startup and reuse the same client/db handle for
 * every request, rather than opening a new connection per request —
 * MongoDB's driver already pools connections internally, so a single
 * long-lived client is the correct pattern, not an optimization we're
 * adding on top.
 */

const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB_NAME ?? 'soulside';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectToDatabase(): Promise<Db> {
  if (db) return db;

  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);

  console.log(`Connected to MongoDB at ${MONGO_URI}, database "${DB_NAME}"`);
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