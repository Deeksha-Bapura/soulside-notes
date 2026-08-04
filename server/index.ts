import express from 'express';
import cors from 'cors';
import { notes, versions, events, seed, nextId, REVIEWERS } from './store';
import { latencyAndFailureInjection } from './middleware';
import type { NoteVersion, ReviewEvent, NoteStatus } from '../src/domain/types';
import { createServer } from 'http';
import { attachRealtime } from './realtime';
import { createActor } from 'xstate';
import { noteMachine, type NoteMachineEvent } from '../src/domain/noteMachine';
import { approvedAtMap } from './store';


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

// --- POST /api/telemetry : accepts batched client events ---
app.post('/api/telemetry', (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  console.log(`[telemetry] received batch of ${events.length} event(s)`);
  res.status(204).end();
});

// Everything below this line gets realistic latency + 5% failure injection.
app.use(latencyAndFailureInjection);

// --- GET /api/notes : cursor-paginated list ---
app.get('/api/notes', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const cursorParam = req.query.cursor as string | undefined;
  const statusParam = req.query.status as string | undefined;
  const statusFilter = statusParam ? statusParam.split(',') : null;
  const reviewerParam = req.query.reviewer as string | undefined;
  const searchParam = (req.query.search as string | undefined)?.trim().toLowerCase();
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;
  const sortBy = (req.query.sortBy as string) || 'updatedAt';
  const sortDir = (req.query.sortDir as string) === 'asc' ? 1 : -1;

  let all = Array.from(notes.values());

  if (statusFilter && statusFilter.length > 0) {
    all = all.filter((note) => statusFilter.includes(note.status));
  }
  if (reviewerParam) {
    all = all.filter((note) => note.assignedReviewerId === reviewerParam);
  }
  if (dateFrom) {
    all = all.filter((note) => note.updatedAt >= dateFrom);
  }
  if (dateTo) {
    all = all.filter((note) => note.updatedAt <= dateTo);
  }
  if (searchParam) {
    // Search across patient display name AND current version content —
    // matches the spec's "search across patient name and note content."
    all = all.filter((note) => {
      if (note.patient.displayName.toLowerCase().includes(searchParam)) return true;
      const version = versions.get(note.currentVersionId);
      if (!version) return false;
      const sections = version.content.sections;
      return Object.values(sections).some((text) => text.toLowerCase().includes(searchParam));
    });
  }

  // Stable secondary sort: whatever the primary sort field, ties always
  // break on `id` so pagination never reorders rows between requests.
  const sortFieldGetters: Record<string, (n: (typeof all)[number]) => string> = {
    updatedAt: (n) => n.updatedAt,
    createdAt: (n) => n.createdAt,
    patientName: (n) => n.patient.displayName,
    status: (n) => n.status,
  };
  const getSortField = sortFieldGetters[sortBy] ?? sortFieldGetters.updatedAt;

  all = all.sort((a, b) => {
    const fa = getSortField(a);
    const fb = getSortField(b);
    if (fa !== fb) return fa < fb ? -sortDir : sortDir;
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

// --- POST /api/notes/bulk-assign : bulk-assign a reviewer to multiple notes ---
app.post('/api/notes/bulk-assign', (req, res) => {
  const { noteIds, reviewerId } = req.body ?? {};
  if (!Array.isArray(noteIds) || !reviewerId) {
    res.status(400).json({ error: 'noteIds and reviewerId are required' });
    return;
  }

  const updated: string[] = [];
  const skipped: string[] = [];

  for (const noteId of noteIds) {
    const note = notes.get(noteId);
    // Only meaningful for notes actually awaiting review — bulk-assigning
    // a LOCKED or GENERATING note doesn't make sense, so we skip those
    // rather than silently corrupting state.
    if (note && note.status === 'READY_FOR_REVIEW') {
      note.assignedReviewerId = reviewerId;
      note.updatedAt = new Date().toISOString();
      updated.push(noteId);
    } else {
      skipped.push(noteId);
    }
  }

  res.json({ updated, skipped });
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

// --- GET /api/versions/:versionId : full content of one specific version ---
app.get('/api/versions/:versionId', (req, res) => {
  const version = versions.get(req.params.versionId);
  if (!version) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(version);
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

// --- POST /api/notes/:id/transitions : status changes, SERVER-ENFORCED ---
// The client sends the same event shape the frontend's XState machine
// uses. We reconstruct a snapshot from the note's REAL current status and
// context, and ask the SAME machine "would this be legal?" — a rogue
// client calling this endpoint directly, bypassing the UI entirely,
// cannot get further than a legitimate client would.
app.post('/api/notes/:id/transitions', (req, res) => {
  const note = notes.get(req.params.id);
  if (!note) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const { event } = req.body as { event: NoteMachineEvent };
  if (!event || !event.type) {
    res.status(400).json({ error: 'invalid_request', message: 'event is required' });
    return;
  }

  const snapshot = noteMachine.resolveState({
    value: note.status as NoteStatus,
    context: {
      assignedReviewerId: note.assignedReviewerId,
      approvedAt: approvedAtMap.get(note.id) ?? null,
    },
  });

  if (!snapshot.can(event)) {
    res.status(403).json({
      error: 'forbidden',
      message: 'This transition is not permitted given the current status, role, or ownership.',
    });
    return;
  }

  const actor = createActor(noteMachine, { snapshot });
  actor.start();
  actor.send(event);
  const nextSnapshot = actor.getSnapshot();
  actor.stop();
  const toStatus = nextSnapshot.value as string;
  const fromStatus = note.status;

  note.status = toStatus;
  note.updatedAt = new Date().toISOString();

  // Mirror the same side effects the machine's own entry actions imply,
  // since we're applying the resulting state to our plain data store
  // rather than keeping a live running actor server-side per note.
  if (toStatus === 'IN_REVIEW' && 'actor' in event) {
    note.assignedReviewerId = event.actor.id;
  }
  if (toStatus === 'READY_FOR_REVIEW') {
    note.assignedReviewerId = null;
  }
  if (toStatus === 'APPROVED') {
    approvedAtMap.set(note.id, Date.now());
  }

  const actorId = 'actor' in event ? event.actor.id : 'system';
  const actorRole = 'actor' in event ? event.actor.role : 'CLINICIAN';
  const reason = 'reason' in event ? event.reason : undefined;

  const reviewEvent: ReviewEvent = {
    id: nextId('evt'),
    noteId: note.id,
    versionId: note.currentVersionId,
    fromStatus,
    toStatus,
    actorId,
    actorRole,
    reason,
    occurredAt: note.updatedAt,
  };
  events.set(reviewEvent.id, reviewEvent);

  res.json({ note: { id: note.id, status: note.status }, event: reviewEvent });
});

const PORT = 3001;
const httpServer = createServer(app);
attachRealtime(httpServer);

httpServer.listen(PORT, () => {
  console.log(`Dummy backend listening on http://localhost:${PORT}`);
});