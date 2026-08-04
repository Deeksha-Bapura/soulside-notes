import { useEffect, useRef } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { realtimeClient } from './socket';
import type { NoteListResponse } from '../api/notesApi';

/**
 * Subscribes to real-time updates for exactly the note IDs currently
 * visible in a virtualized list, unsubscribing as rows scroll out of
 * view. Mirrors the detail page's subscription pattern, but for many
 * notes at once rather than one.
 */
export function useVisibleNotesRealtime(
  visibleNoteIds: string[],
  queryKey: readonly unknown[]
) {
  const queryClient = useQueryClient();
  const unsubscribeFnsRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const current = unsubscribeFnsRef.current;
    const visibleSet = new Set(visibleNoteIds);

    // Subscribe to any newly-visible note not already subscribed.
    for (const noteId of visibleNoteIds) {
      if (current.has(noteId)) continue;
      const unsubscribe = realtimeClient.subscribe(noteId, (event) => {
        if (event.type === 'note.status_changed') {
          queryClient.setQueryData<InfiniteData<NoteListResponse>>(queryKey, (old) => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === noteId ? { ...item, status: event.toStatus } : item
                ),
              })),
            };
          });
        }
      });
      current.set(noteId, unsubscribe);
    }

    // Unsubscribe from anything no longer visible.
    for (const [noteId, unsubscribe] of current.entries()) {
      if (!visibleSet.has(noteId)) {
        unsubscribe();
        current.delete(noteId);
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNoteIds.join(','), queryClient]);

  // Clean up everything on full unmount (e.g. navigating away from the list).
  useEffect(() => {
    const current = unsubscribeFnsRef.current;
    return () => {
      current.forEach((unsub) => unsub());
      current.clear();
    };
  }, []);
}