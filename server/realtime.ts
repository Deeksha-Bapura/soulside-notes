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
    for (const client of clients) {
      if (client.subscribedNoteIds.has(noteId)) {
        send(client, payload);
        // ~2% duplicate delivery, on purpose — exercises at-least-once handling.
        if (Math.random() < 0.02) send(client, payload);
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


    if (note.status === 'IN_REVIEW' && Math.random() < 0.3) {
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
}
