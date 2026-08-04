type NoteEvent =
  | {
      type: 'note.status_changed';
      noteId: string;
      fromStatus: string;
      toStatus: string;
      actor: { id: string; displayName: string };
      at: string;
      eventId: string;
      seq?: number;
    }
  | { type: 'note.presence'; noteId: string; viewers: Array<{ id: string; role: string }> };

type Listener = (event: NoteEvent) => void;

/**
 * A single shared WebSocket connection for the whole app, with per-note
 * pub/sub layered on top. Handles:
 * - Reconnection with exponential backoff + jitter, so many simultaneously
 *   disconnected clients don't all retry at the exact same moment
 *   ("thundering herd").
 * - Re-subscribing to everything we cared about after a reconnect, AND
 *   requesting replay of anything broadcast during the disconnected gap
 *   (rather than assuming nothing happened while we were offline).
 * - Deduplicating events by eventId (the server deliberately sends ~2%
 *   duplicates, per Step 5 — this is where we handle that on purpose,
 *   rather than treating duplicate UI updates as a bug)
 */
class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private seenEventIds = new Set<string>();
  private reconnectAttempt = 0;
  private subscribedNoteIds = new Set<string>();
  private lastSeenSeq = 0;

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      if (this.subscribedNoteIds.size > 0) {
        this.send({ type: 'subscribe', noteIds: Array.from(this.subscribedNoteIds) });
      }
      // Ask the server for anything we missed while disconnected, rather
      // than silently assuming the gap was empty.
      if (this.lastSeenSeq > 0) {
        this.send({ type: 'replay_since', sinceSeq: this.lastSeenSeq });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as NoteEvent & { eventId?: string; seq?: number };
        if (typeof data.seq === 'number') {
          this.lastSeenSeq = Math.max(this.lastSeenSeq, data.seq);
        }
        if ('eventId' in data && data.eventId) {
          if (this.seenEventIds.has(data.eventId)) return; // drop duplicate
          this.seenEventIds.add(data.eventId);
          if (this.seenEventIds.size > 500) {
            const first = this.seenEventIds.values().next().value;
            if (first) this.seenEventIds.delete(first);
          }
        }
        const noteListeners = this.listeners.get(data.noteId);
        noteListeners?.forEach((cb) => cb(data));
      } catch {
        // Malformed message — ignore rather than crash the socket handler.
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      const baseDelay = Math.min(1000 * 2 ** this.reconnectAttempt, 15000);
      // Full jitter: a random delay anywhere from 0 up to baseDelay,
      // rather than a fixed exponential value — spreads out reconnection
      // attempts across many clients instead of them all retrying in
      // lockstep after the same outage.
      const jitteredDelay = Math.random() * baseDelay;
      this.reconnectAttempt++;
      setTimeout(() => this.connect(), jitteredDelay);
    };
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  subscribe(noteId: string, listener: Listener): () => void {
    this.connect();
    if (!this.listeners.has(noteId)) this.listeners.set(noteId, new Set());
    this.listeners.get(noteId)!.add(listener);

    if (!this.subscribedNoteIds.has(noteId)) {
      this.subscribedNoteIds.add(noteId);
      this.send({ type: 'subscribe', noteIds: [noteId] });
    }

    return () => {
      this.listeners.get(noteId)?.delete(listener);
      if (this.listeners.get(noteId)?.size === 0) {
        this.listeners.delete(noteId);
        this.subscribedNoteIds.delete(noteId);
        this.send({ type: 'unsubscribe', noteIds: [noteId] });
      }
    };
  }
}

export const realtimeClient = new RealtimeClient();