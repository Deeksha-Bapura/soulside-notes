import type { QueryClient } from '@tanstack/react-query';
import { getQueuedWrites, removeQueuedWrite } from './db';
import { saveVersion, type VersionConflict } from '../api/notesApi';
import { useSyncStore } from './syncStore';

/**
 * Replays every queued write, in the order they were originally made.
 * Stops at the first write that still can't be sent due to connectivity
 * (rather than skipping ahead) — this preserves ordering: we never want
 * write #3 to land before write #2 for the same note.
 *
 * A write that fails due to a REAL version conflict (not connectivity) is
 * left in the queue and flagged in the sync store, since resolving it
 * safely requires the user's judgment — we already built that UI in
 * Step 8, and reuse it rather than trying to auto-resolve here.
 */
export async function replayQueuedWrites(queryClient: QueryClient) {
  const writes = await getQueuedWrites();

  for (const write of writes) {
    try {
      await saveVersion({
        noteId: write.noteId,
        baseVersionId: write.baseVersionId,
        content: write.content,
        clientMutationId: write.id,
      });
      await removeQueuedWrite(write.id);
      useSyncStore.getState().clearConflict(write.noteId);
      queryClient.invalidateQueries({ queryKey: ['note', write.noteId] });
    } catch (err) {
      const maybeConflict = err as VersionConflict;
      if (maybeConflict?.error === 'version_conflict') {
        useSyncStore.getState().addConflict(write.noteId);
        // Move on to the next queued write rather than stopping — a
        // conflict on one note shouldn't block syncing edits to others.
        continue;
      }
      // Still failing for a non-conflict reason (offline again, simulated
      // 500, etc.) — stop here. We'll retry the whole remaining queue,
      // in order, next time 'online' fires.
      break;
    }
  }
}