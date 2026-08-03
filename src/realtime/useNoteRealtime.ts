import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { realtimeClient } from './socket';
import type { NoteDetail } from '../api/notesApi';

export function useNoteRealtime(noteId: string) {
  const queryClient = useQueryClient();
  const [viewers, setViewers] = useState<Array<{ id: string; role: string }>>([]);

  useEffect(() => {
    const unsubscribe = realtimeClient.subscribe(noteId, (event) => {
      if (event.type === 'note.status_changed') {
        // Patch the cache directly with what the server already told us,
        // rather than relying solely on a refetch succeeding. The server
        // push IS the source of truth for this specific field — no need
        // to wait on a network round trip (which can hit our own
        // simulated 5% failure rate) just to display it.
        queryClient.setQueryData<NoteDetail>(['note', noteId], (old) => {
          if (!old) return old;
          return { ...old, status: event.toStatus };
        });
        // Still invalidate in the background to eventually pick up
        // anything else that changed (assignedReviewer, review events,
        // etc.) that this lightweight patch doesn't cover.
        queryClient.invalidateQueries({ queryKey: ['note', noteId] });
      }
      if (event.type === 'note.presence') {
        setViewers(event.viewers);
      }
    });
    return unsubscribe;
  }, [noteId, queryClient]);

  return { viewers };
}