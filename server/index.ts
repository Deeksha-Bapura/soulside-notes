import express from 'express';
import cors from 'cors';
import {
  seed,
  nextId,
  REVIEWERS,
  getNote,
  saveNote,
  findNotes,
  getVersion,
  saveVersion,
  getVersionsForNote,
  findVersionByParent,
  saveEvent,
  getEventsForNote,
  getApprovedAt,
  setApprovedAt,
  hasSeenMutation,
  markMutationSeen,
} from './store';
import { latencyAndFailureInjection } from './middleware';
import type { NoteVersion, ReviewEvent, NoteStatus } from '../src/domain/types';
import { createServer } from 'http';
import { attachRealtime } from './realtime';
import { createActor } from 'xstate';
import { noteMachine, type NoteMachineEvent } from '../src/domain/noteMachine';
import { connectToDatabase } from './db';

const app = express();
let realtimeApi: ReturnType<typeof attachRealtime> | undefined;
app.use(cors());
app.use(express.json());

// Seed a small default dataset on boot so the server is usable immediately
// without waiting for a POST /api/dev/seed call. We connect to the
// database first and wait for seeding to actually finish before the
// server starts accepting requests — starting the HTTP listener before
// the initial seed completes could let a request race ahead of data
// actually being there.
async function startServer() {
  const db = await connectToDatabase();

  // Only seed if the database is genuinely empty — this is what makes
  // persistence actually meaningful. Unconditionally reseeding on every
  // restart would silently defeat the whole point of adding a real
  // database, wiping real data every time the process restarts.
  const existingCount = await db.collection('notes').countDocuments();
  if (existingCount === 0) {
    await seed(500);
  } else {
    console.log(`Found ${existingCount} existing notes in MongoDB, skipping seed.`);
  }

  app.post('/api/dev/seed', async (req, res) => {
    const rawCount = req.body?.count;
    const count = typeof rawCount === 'number' && rawCount >= 0 ? rawCount : 500;
    await seed(count);
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
  app.get('/api/notes', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const cursorParam = req.query.cursor as string | undefined;
    const statusParam = req.query.status as string | undefined;
    const statusFilter = statusParam ? statusParam.split(',') : null;
    const reviewerParam = req.query.reviewer as string | undefined;
    const patientParam = req.query.patient as string | undefined;
    const searchParam = (req.query.search as string | undefined)?.trim().toLowerCase();
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;
    const sortBy = (req.query.sortBy as string) || 'updatedAt';
    const sortDir = (req.query.sortDir as string) === 'asc' ? 1 : -1;

    // Build a Mongo filter from the simpler, non-content filters directly,
    // rather than pulling every note into memory first — this is one of
    // the real advantages of a real database over the old in-memory Maps.
    const mongoFilter: Record<string, unknown> = {};
    if (statusFilter && statusFilter.length > 0) {
      mongoFilter.status = { $in: statusFilter };
    }
    if (reviewerParam) {
      mongoFilter.assignedReviewerId = reviewerParam;
    }
    if (patientParam) {
      mongoFilter['patient.id'] = patientParam;
    }
    if (dateFrom || dateTo) {
      mongoFilter.updatedAt = {};
      if (dateFrom) (mongoFilter.updatedAt as Record<string, string>).$gte = dateFrom;
      if (dateTo) (mongoFilter.updatedAt as Record<string, string>).$lte = dateTo;
    }

    let all = await findNotes(mongoFilter);

    // Content search still happens in memory after the Mongo-side filter,
    // since it needs to look inside each note's CURRENT VERSION content,
    // which lives in a separate collection — a more advanced version could
    // do this with a Mongo aggregation $lookup, but for a dummy backend at
    // this scale, a post-filter is simpler and clear about what it does.
    if (searchParam) {
      const filtered: typeof all = [];
      for (const note of all) {
        if (note.patient.displayName.toLowerCase().includes(searchParam)) {
          filtered.push(note);
          continue;
        }
        const version = await getVersion(note.currentVersionId);
        if (!version) continue;
        const sections = version.content.sections;
        if (Object.values(sections).some((text) => text.toLowerCase().includes(searchParam))) {
          filtered.push(note);
        }
      }
      all = filtered;
    }

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

    const items = await Promise.all(
      page.map(async (note) => {
        const version = await getVersion(note.currentVersionId);
        return {
          id: note.id,
          patient: note.patient,
          status: note.status,
          currentVersion: { id: note.currentVersionId, revision: version?.revision ?? 1 },
          assignedReviewer: note.assignedReviewerId
            ? { id: note.assignedReviewerId, displayName: note.assignedReviewerId, role: 'REVIEWER' }
            : null,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        };
      })
    );

    res.json({
      cursor: { next: nextCursor, hasMore },
      items,
      meta: { total: all.length, returned: page.length, generatedAt: new Date().toISOString() },
    });
  });

  // --- POST /api/notes/bulk-assign : bulk-assign a reviewer to multiple notes ---
  app.post('/api/notes/bulk-assign', async (req, res) => {
    const { noteIds, reviewerId } = req.body ?? {};
    if (!Array.isArray(noteIds) || !reviewerId) {
      res.status(400).json({ error: 'noteIds and reviewerId are required' });
      return;
    }

    const updated: string[] = [];
    const skipped: string[] = [];

    for (const noteId of noteIds) {
      const note = await getNote(noteId);
      if (note && note.status === 'READY_FOR_REVIEW') {
        note.assignedReviewerId = reviewerId;
        note.updatedAt = new Date().toISOString();
        await saveNote(note);
        updated.push(noteId);
      } else {
        skipped.push(noteId);
      }
    }

    res.json({ updated, skipped });
  });

  // --- POST /api/notes/bulk-regenerate : bulk-request regeneration ---
  app.post('/api/notes/bulk-regenerate', async (req, res) => {
    const { noteIds } = req.body ?? {};
    if (!Array.isArray(noteIds)) {
      res.status(400).json({ error: 'noteIds is required' });
      return;
    }

    const updated: string[] = [];
    const skipped: string[] = [];

    for (const noteId of noteIds) {
      const note = await getNote(noteId);
      if (note && note.status === 'FAILED') {
        note.status = 'GENERATING';
        note.updatedAt = new Date().toISOString();
        await saveNote(note);
        updated.push(noteId);
      } else {
        skipped.push(noteId);
      }
    }

    res.json({ updated, skipped });
  });

  // --- GET /api/notes/:id : full detail ---
  app.get('/api/notes/:id', async (req, res) => {
    const note = await getNote(req.params.id);
    if (!note) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const currentVersion = await getVersion(note.currentVersionId);
    const noteVersions = await getVersionsForNote(note.id);
    const noteEvents = await getEventsForNote(note.id);
    const approvedAt = await getApprovedAt(note.id);

    res.json({
      id: note.id,
      patient: note.patient,
      status: note.status,
      assignedReviewer: note.assignedReviewerId
        ? { id: note.assignedReviewerId, displayName: note.assignedReviewerId, role: 'REVIEWER' }
        : null,
      currentVersion,
      approvedAt,
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
  app.get('/api/versions/:versionId', async (req, res) => {
    const version = await getVersion(req.params.versionId);
    if (!version) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(version);
  });

  // --- POST /api/notes/:id/versions : autosave, with 409 conflict handling ---
  app.post('/api/notes/:id/versions', async (req, res) => {
    const note = await getNote(req.params.id);
    if (!note) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const { baseVersionId, content, clientMutationId } = req.body ?? {};

    // Idempotency: if we've already processed this exact mutation, return
    // the same success response instead of creating a duplicate version.
    if (clientMutationId && (await hasSeenMutation(clientMutationId))) {
      const existing = await findVersionByParent(note.id, baseVersionId);
      if (existing) {
        res.json({
          version: { id: existing.id, revision: existing.revision, parentVersionId: existing.parentVersionId },
        });
        return;
      }
    }

    // Conflict: the client's base version is not the current head anymore.
    if (baseVersionId !== note.currentVersionId) {
      const current = await getVersion(note.currentVersionId);
      const commonAncestor = await getVersion(baseVersionId);
      res.status(409).json({
        error: 'version_conflict',
        current: current && {
          id: current.id,
          revision: current.revision,
          authoredBy: { id: current.authorId, role: current.authorRole },
        },
        commonAncestor: commonAncestor
          ? { id: commonAncestor.id, revision: commonAncestor.revision }
          : null,
      });
      return;
    }

    const baseVersion = await getVersion(baseVersionId);
    const newVersion: NoteVersion = {
      id: nextId('ver'),
      noteId: note.id,
      revision: (baseVersion?.revision ?? 0) + 1,
      parentVersionId: baseVersionId,
      content,
      authorId: 'usr_current', // TODO: derive from auth once auth exists
      authorRole: 'CLINICIAN',
      createdAt: new Date().toISOString(),
    };
    await saveVersion(newVersion);

    note.currentVersionId = newVersion.id;
    note.updatedAt = newVersion.createdAt;
    await saveNote(note);

    if (clientMutationId) await markMutationSeen(clientMutationId);

    realtimeApi?.broadcastVersionAdded(note.id, {
      id: newVersion.id,
      revision: newVersion.revision,
    });

    res.json({
      version: { id: newVersion.id, revision: newVersion.revision, parentVersionId: newVersion.parentVersionId },
    });
  });

  // --- POST /api/notes/:id/transitions : status changes, SERVER-ENFORCED ---
  app.post('/api/notes/:id/transitions', async (req, res) => {
    const note = await getNote(req.params.id);
    if (!note) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const { event } = req.body as { event: NoteMachineEvent };
    if (!event || !event.type) {
      res.status(400).json({ error: 'invalid_request', message: 'event is required' });
      return;
    }

    const approvedAt = await getApprovedAt(note.id);

    const snapshot = noteMachine.resolveState({
      value: note.status as NoteStatus,
      context: {
        assignedReviewerId: note.assignedReviewerId,
        approvedAt,
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
    const toStatus = nextSnapshot.value as NoteStatus;
    const fromStatus = note.status;

    note.status = toStatus;
    note.updatedAt = new Date().toISOString();

    if (toStatus === 'IN_REVIEW' && 'actor' in event) {
      note.assignedReviewerId = event.actor.id;
    }
    if (toStatus === 'READY_FOR_REVIEW') {
      note.assignedReviewerId = null;
    }
    if (toStatus === 'APPROVED') {
      await setApprovedAt(note.id, Date.now());
    }

    await saveNote(note);

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
    await saveEvent(reviewEvent);

    realtimeApi?.broadcastStatusChanged(note.id, fromStatus, toStatus, {
      id: actorId,
      displayName: actorId,
    });

    res.json({ note: { id: note.id, status: note.status }, event: reviewEvent });
  });

  const PORT = 3001;
  const httpServer = createServer(app);
  realtimeApi = attachRealtime(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`Dummy backend listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});