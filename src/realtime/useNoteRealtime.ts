import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { realtimeClient } from './socket';
import type { NoteDetail } from '../api/notesApi';

export interface RemoteStatusChange {
  fromStatus: string;
  toStatus: string;
  actorId: string;
}

export interface RemoteVersionAdded {
  versionId: string;
  revision: number;
}

export function useNoteRealtime(noteId: string) {
  const queryClient = useQueryClient();
  const [viewers, setViewers] = useState<Array<{ id: string; role: string }>>([]);
  const [lastRemoteChange, setLastRemoteChange] = useState<RemoteStatusChange | null>(null);
  const [remoteVersionAdded, setRemoteVersionAdded] = useState<RemoteVersionAdded | null>(null);

  useEffect(() => {
    const unsubscribe = realtimeClient.subscribe(noteId, (event) => {
      if (event.type === 'note.status_changed') {
        // Patch the cache directly with what the server already told us —
        // this remains the fast path for the visible status text. The
        // MACHINE itself is now kept in sync separately, by the consuming
        // component calling send() with a reconstructed event — see
        // NoteDetailPage, which is what satisfies "server-pushed
        // transitions must run through the same machine."
        queryClient.setQueryData<NoteDetail>(['note', noteId], (old) => {
          if (!old) return old;
          return { ...old, status: event.toStatus };
        });
        queryClient.invalidateQueries({ queryKey: ['note', noteId] });
        setLastRemoteChange({
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          actorId: event.actor.id,
        });
      }
      if (event.type === 'note.presence') {
        setViewers(event.viewers);
      }
      if (event.type === 'note.version_added') {
        setRemoteVersionAdded({ versionId: event.version.id, revision: event.version.revision });
      }
    });
    return unsubscribe;
  }, [noteId, queryClient]);

  return { viewers, lastRemoteChange, remoteVersionAdded };
}