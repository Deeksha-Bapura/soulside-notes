import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { realtimeClient } from './socket';
import type { NoteDetail } from '../api/notesApi';

export function useNoteRealtime(noteId: string) {
  const queryClient = useQueryClient();
  const [viewers, setViewers] = useState<Array<{ id: string; role: string }>>([]);
  const [lastRemoteChange, setLastRemoteChange] = useState<{
    toStatus: string;
    actorId: string;
  } | null>(null);

  useEffect(() => {
    const unsubscribe = realtimeClient.subscribe(noteId, (event) => {
      if (event.type === 'note.status_changed') {
        queryClient.setQueryData<NoteDetail>(['note', noteId], (old) => {
          if (!old) return old;
          return { ...old, status: event.toStatus };
        });
        queryClient.invalidateQueries({ queryKey: ['note', noteId] });
        setLastRemoteChange({ toStatus: event.toStatus, actorId: event.actor.id });
      }
      if (event.type === 'note.presence') {
        setViewers(event.viewers);
      }
    });
    return unsubscribe;
  }, [noteId, queryClient]);

  return { viewers, lastRemoteChange };
}