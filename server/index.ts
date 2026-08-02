import express from 'express';
import cors from 'cors';
import { notes, versions, events, seed, nextId, REVIEWERS } from './store';
import { latencyAndFailureInjection } from './middleware';
import type { NoteVersion, ReviewEvent } from '../src/domain/types';
import { createServer } from 'http';
import { attachRealtime } from './realtime';

const app = express();
app.use(cors());
app.use(express.json());

// Seed a small default dataset on boot so the server is usable immediately
// without waiting for a POST /api/dev/seed call.
seed(500);

// --- Dev/utility routes skip latency+failure injection on purpose ---
// (Flagging this now as agreed: we'll revisit whether autosave/offline
// testing needs us to be stricter about which routes are "real" vs "dev".)
app.post('/api/dev/seed', (req, res) => {
  const count = Number(req.body?.count) || 500;
  seed(count);
  res.json({ seeded: count });
});

// Everything below this line gets realistic latency + 5% failure injection.
app.use(latencyAndFailureInjection);

// --- GET /api/notes : cursor-paginated list ---
app.get('/api/notes', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const cursorParam = req.query.cursor as string | undefined;
  const statusParam = req.query.status as string | undefined;
  const statusFilter = statusParam ? statusParam.split(',') : null;

  let all = Array.from(notes.values());
  if (statusFilter && statusFilter.length > 0) {
    all = all.filter((note) => statusFilter.includes(note.status));
  }

  all = all.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    return a.id.localeCompare(b.id);
  });

  let startIndex = 0;
  if (cursorParam) {
    try {
      const decoded = JSON.parse(Buffer.from(cursorParam, 'base64').toString());
      startIndex = decoded.o ?? 0;
    } catch {
      startIndex = 0;
    }
  }

  const page = all.slice(startIndex, startIndex + limit);
  const nextIndex = startIndex + limit;
  const hasMore = nextIndex < all.length;
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify({ o: nextIndex })).toString('base64')
    : null;

  res.json({
    cursor: { next: nextCursor, hasMore },
    items: page.map((note) => ({
      id: note.id,
      patient: note.patient,
      status: note.status,
      currentVersion: { id: note.currentVersionId, revision: versions.get(note.currentVersionId)?.revision ?? 1 },
      assignedReviewer: note.assignedReviewerId
        ? { id: note.assignedReviewerId, displayName: note.assignedReviewerId, role: 'REVIEWER' }
        : null,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    })),
    meta: { total: all.length, returned: page.length, generatedAt: new Date().toISOString() },
  });
});

// --- GET /api/notes/:id : full detail ---
app.get('/api/notes/:id', (req, res) => {
  const note = notes.get(req.params.id);
  if (!note) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const currentVersion = versions.get(note.currentVersionId);
  const noteVersions = Array.from(versions.values()).filter((v) => v.noteId === note.id);
  const noteEvents = Array.from(events.values()).filter((e) => e.noteId === note.id);

  res.json({
    id: note.id,
    patient: note.patient,
    status: note.status,
    assignedReviewer: note.assignedReviewerId
      ? { id: note.assignedReviewerId, displayName: note.assignedReviewerId, role: 'REVIEWER' }
      : null,
    currentVersion,
    versions: noteVersions.map((v) => ({
      id: v.id,
      revision: v.revision,
      parentVersionId: v.parentVersionId,
      authoredBy: { id: v.authorId, role: v.authorRole },
    })),
    review: { events: noteEvents },
  });
});

// --- POST /api/notes/:id/versions : autosave, with 409 conflict handling ---
const seenMutationIds = new Set<string>();

app.post('/api/notes/:id/versions', (req, res) => {
  const note = notes.get(req.params.id);
  if (!note) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const { baseVersionId, content, clientMutationId } = req.body ?? {};

  // Idempotency: if we've already processed this exact mutation, return the
  // same success response instead of creating a duplicate version.
  if (clientMutationId && seenMutationIds.has(clientMutationId)) {
    const existing = Array.from(versions.values()).find(
      (v) => v.noteId === note.id && v.parentVersionId === baseVersionId
    );
    if (existing) {
      res.json({ version: { id: existing.id, revision: existing.revision, parentVersionId: existing.parentVersionId } });
      return;
    }
  }

  // Conflict: the client's base version is not the current head anymore.
  if (baseVersionId !== note.currentVersionId) {
    const current = versions.get(note.currentVersionId)!;
    // Walk back to find a common ancestor (simple case: base itself, if it exists).
    const commonAncestor = versions.get(baseVersionId) ?? null;
    res.status(409).json({
      error: 'version_conflict',
      current: { id: current.id, revision: current.revision, authoredBy: { id: current.authorId, role: current.authorRole } },
      commonAncestor: commonAncestor
        ? { id: commonAncestor.id, revision: commonAncestor.revision }
        : null,
    });
    return;
  }

  const newVersion: NoteVersion = {
    id: nextId('ver'),
    noteId: note.id,
    revision: (versions.get(baseVersionId)?.revision ?? 0) + 1,
    parentVersionId: baseVersionId,
    content,
    authorId: 'usr_current', // TODO: derive from auth once auth exists
    authorRole: 'CLINICIAN',
    createdAt: new Date().toISOString(),
  };
  versions.set(newVersion.id, newVersion);

  note.currentVersionId = newVersion.id;
  note.updatedAt = newVersion.createdAt;

  if (clientMutationId) seenMutationIds.add(clientMutationId);

  res.json({ version: { id: newVersion.id, revision: newVersion.revision, parentVersionId: newVersion.parentVersionId } });
});

// --- POST /api/notes/:id/transitions : status changes ---
app.post('/api/notes/:id/transitions', (req, res) => {
  const note = notes.get(req.params.id);
  if (!note) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const { to, actorId, reason } = req.body ?? {};
  const fromStatus = note.status;

  // NOTE: this endpoint intentionally does NOT re-implement the state
  // machine's guard logic. The frontend's state machine is the single
  // source of truth for what's *legal*; this dummy server just accepts
  // the transition and records it, since real guard enforcement belongs
  // server-side in a real system but is out of scope for a fake one.
  note.status = to;
  note.updatedAt = new Date().toISOString();
  if (to === 'IN_REVIEW') note.assignedReviewerId = actorId;
  if (to === 'READY_FOR_REVIEW') note.assignedReviewerId = null;

  const event: ReviewEvent = {
    id: nextId('evt'),
    noteId: note.id,
    versionId: note.currentVersionId,
    fromStatus,
    toStatus: to,
    actorId,
    actorRole: 'REVIEWER',
    reason,
    occurredAt: note.updatedAt,
  };
  events.set(event.id, event);

  res.json({ note: { id: note.id, status: note.status }, event });
});

const PORT = 3001;
const httpServer = createServer(app);
attachRealtime(httpServer);

httpServer.listen(PORT, () => {
  console.log(`Dummy backend listening on http://localhost:${PORT}`);
});