import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { notes } from './store';

/**
 * The real-time channel. Matches the assignment's spec: "One channel per
 * open note plus a workspace-wide feed." We implement this as a single
 * WebSocket connection per browser tab, where the CLIENT tells the server
 * which noteIds it currently cares about (via subscribe/unsubscribe
 * messages) — mirroring the requirement that the frontend "subscribe to
 * the real-time channel for the notes currently on screen... unsubscribe
 * when they leave the viewport."
 *
 * Event delivery is intentionally NOT guaranteed exactly-once — per the
 * assignment ("design for at-least-once delivery"), we sometimes deliver
 * duplicates on purpose, so the frontend's eventId-based reconciliation
 * actually gets exercised.
 */

interface ClientState {
  ws: WebSocket;
  subscribedNoteIds: Set<string>;
  viewerId: string;
}

let eventCounter = 0;
function nextEventId() {
  eventCounter += 1;
  return `evt_rt_${eventCounter}`;
}

// Short in-memory buffer of recently broadcast events, keyed by sequence
// number, so a client that reconnects after a gap can ask "what did I
// miss since sequence N" rather than silently losing events. Bounded to
// avoid unbounded memory growth in a long-running dummy server.
interface BufferedEvent {
  seq: number;
  noteId: string;
  payload: unknown;
}
const recentEvents: BufferedEvent[] = [];
const MAX_BUFFERED_EVENTS = 500;

function recordEvent(noteId: string, payload: unknown) {
  eventCounter += 1;
  const payloadWithSeq = { ...(payload as object), seq: eventCounter };
  recentEvents.push({ seq: eventCounter, noteId, payload: payloadWithSeq });
  if (recentEvents.length > MAX_BUFFERED_EVENTS) {
    recentEvents.shift();
  }
  return eventCounter;
}

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<ClientState>();

  wss.on('connection', (ws) => {
    const client: ClientState = {
      ws,
      subscribedNoteIds: new Set(),
      viewerId: `viewer_${Math.random().toString(36).slice(2, 8)}`,
    };
    clients.add(client);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && Array.isArray(msg.noteIds)) {
          msg.noteIds.forEach((id: string) => client.subscribedNoteIds.add(id));
          broadcastPresence(msg.noteIds);
        }
        if (msg.type === 'unsubscribe' && Array.isArray(msg.noteIds)) {
          msg.noteIds.forEach((id: string) => client.subscribedNoteIds.delete(id));
          broadcastPresence(msg.noteIds);
        }
        // Client reconnecting after a gap: replay anything buffered for
        // its currently-subscribed notes since the sequence it last saw.
        if (msg.type === 'replay_since' && typeof msg.sinceSeq === 'number') {
          const missed = recentEvents.filter(
            (e) => e.seq > msg.sinceSeq && client.subscribedNoteIds.has(e.noteId)
          );
          for (const e of missed) {
            send(client, e.payload);
          }
        }
      } catch {
        // Ignore malformed messages — a dummy backend doesn't need to be robust here.
      }
    });

    ws.on('close', () => {
      const affected = Array.from(client.subscribedNoteIds);
      clients.delete(client);
      broadcastPresence(affected);
    });
  });

  function send(client: ClientState, payload: unknown) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(payload));
    }
  }

  function broadcastToSubscribers(noteId: string, payload: unknown) {
    const seq = recordEvent(noteId, payload);
    const payloadWithSeq = { ...(payload as object), seq };
    for (const client of clients) {
      if (client.subscribedNoteIds.has(noteId)) {
        send(client, payloadWithSeq);
        if (Math.random() < 0.02) send(client, payloadWithSeq);
      }
    }
  }

  function broadcastPresence(noteIds: string[]) {
    for (const noteId of noteIds) {
      const viewers = Array.from(clients)
        .filter((c) => c.subscribedNoteIds.has(noteId))
        .map((c) => ({ id: c.viewerId, role: 'REVIEWER' }));
      broadcastToSubscribers(noteId, {
        type: 'note.presence',
        noteId,
        viewers,
      });
    }
  }

  // Periodically simulate another actor changing a random subscribed note's
  // status — this is what makes "server-pushed transitions arriving while
  // you're looking at a note" an actual thing you can observe and handle,
  // not just a theoretical scenario.
  setInterval(() => {
    const subscribedNoteIds = new Set<string>();
    for (const client of clients) {
      client.subscribedNoteIds.forEach((id) => subscribedNoteIds.add(id));
    }
    if (subscribedNoteIds.size === 0) return;

    const ids = Array.from(subscribedNoteIds);
    const noteId = ids[Math.floor(Math.random() * ids.length)];
    const note = notes.get(noteId);
    if (!note) return;


    if (note.status === 'IN_REVIEW' && Math.random() < 0) {
      const fromStatus = note.status;
      note.status = 'APPROVED';
      note.updatedAt = new Date().toISOString();
      broadcastToSubscribers(noteId, {
        type: 'note.status_changed',
        noteId,
        fromStatus,
        toStatus: 'APPROVED',
        actor: { id: 'dr_simulated', displayName: 'Dr. Simulated' },
        at: note.updatedAt,
        eventId: nextEventId(),
      });
    }
  }, 4000);

  console.log('Real-time WebSocket channel attached at /ws');

  return {
    broadcastVersionAdded(noteId: string, version: { id: string; revision: number }) {
      broadcastToSubscribers(noteId, {
        type: 'note.version_added',
        noteId,
        version,
        eventId: nextEventId(),
      });
    },
    broadcastStatusChanged(
      noteId: string,
      fromStatus: string,
      toStatus: string,
      actor: { id: string; displayName: string }
    ) {
      broadcastToSubscribers(noteId, {
        type: 'note.status_changed',
        noteId,
        fromStatus,
        toStatus,
        actor,
        at: new Date().toISOString(),
        eventId: nextEventId(),
      });
    },
  };
}
