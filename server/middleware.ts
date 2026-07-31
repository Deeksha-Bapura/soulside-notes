import type { Request, Response, NextFunction } from 'express';

// Simulates real-world network conditions so the frontend can't get away
// with assuming every request succeeds instantly. Per the assignment:
// "realistic latency (100–800ms) and 5% failure injection."

const MIN_LATENCY_MS = 100;
const MAX_LATENCY_MS = 800;
const FAILURE_RATE = 0.05; // 5%

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function latencyAndFailureInjection(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const latency = MIN_LATENCY_MS + Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS);
  await delay(latency);

  if (Math.random() < FAILURE_RATE) {
    res.status(500).json({ error: 'simulated_server_error' });
    return;
  }

  next();
}