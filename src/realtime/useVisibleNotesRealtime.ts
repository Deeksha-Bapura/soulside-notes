import { useEffect, useRef } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { realtimeClient } from './socket';
import type { NoteListResponse } from '../api/notesApi';

const RESORT_DELAY_MS = 3000;

/**
 * Subscribes to real-time updates for exactly the note IDs currently
 * visible in a virtualized list, unsubscribing as rows scroll out of
 * view. A live status patch updates a row's badge in place immediately
 * (satisfying "never jumps or blinks"), but does NOT immediately
 * re-sort — if it did, a row could visibly leap across the screen mid-
 * scroll, which is exactly the jarring behavior the spec says to avoid.
 * Instead, a debounced full invalidate fires a few seconds after the
 * last live patch, letting the row settle into its correct sorted
 * position once things are quiet, rather than never correcting at all.
 */
export function useVisibleNotesRealtime(
  visibleNoteIds: string[],
  queryKey: readonly unknown[]
) {
  const queryClient = useQueryClient();
  const unsubscribeFnsRef = useRef<Map<string, () => void>>(new Map());
  const resortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const current = unsubscribeFnsRef.current;
    const visibleSet = new Set(visibleNoteIds);

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

          // Debounce the resort: each new live patch pushes the timer
          // back out, so a burst of updates only triggers one eventual
          // resort, not one per event.
          if (resortTimerRef.current) clearTimeout(resortTimerRef.current);
          resortTimerRef.current = setTimeout(() => {
            queryClient.invalidateQueries({ queryKey });
          }, RESORT_DELAY_MS);
        }
      });
      current.set(noteId, unsubscribe);
    }

    for (const [noteId, unsubscribe] of current.entries()) {
      if (!visibleSet.has(noteId)) {
        unsubscribe();
        current.delete(noteId);
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNoteIds.join(','), queryClient]);

  useEffect(() => {
    const current = unsubscribeFnsRef.current;
    return () => {
      current.forEach((unsub) => unsub());
      current.clear();
      if (resortTimerRef.current) clearTimeout(resortTimerRef.current);
    };
  }, []);
}