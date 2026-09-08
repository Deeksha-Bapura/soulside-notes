import { createClient, type RedisClientType } from 'redis';

/**
 * A single shared Redis connection, mirroring the pattern in db.ts —
 * connect once, reuse the same client for the lifetime of the process.
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

let client: RedisClientType | null = null;

export async function connectToRedis(): Promise<RedisClientType> {
  if (client) return client;

  client = createClient({ url: REDIS_URL });

  client.on('error', (err) => {
    console.error('Redis client error:', err);
  });

  await client.connect();
  console.log(`Connected to Redis at ${REDIS_URL}`);
  return client;
}

export function getRedisClient(): RedisClientType {
  if (!client) {
    throw new Error('Redis not initialized — call connectToRedis() first');
  }
  return client;
}