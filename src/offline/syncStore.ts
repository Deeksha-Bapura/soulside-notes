import { create } from 'zustand';

// Tracks which notes have a queued write that failed to replay due to a
// REAL conflict (someone else's version won) — as opposed to a write
// that's just waiting for connectivity. These need the user to manually
// reopen the note and resolve, since we can't safely auto-merge.
interface SyncState {
  conflictedNoteIds: string[];
  addConflict: (noteId: string) => void;
  clearConflict: (noteId: string) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  conflictedNoteIds: [],
  addConflict: (noteId) =>
    set((s) => ({ conflictedNoteIds: Array.from(new Set([...s.conflictedNoteIds, noteId])) })),
  clearConflict: (noteId) =>
    set((s) => ({ conflictedNoteIds: s.conflictedNoteIds.filter((id) => id !== noteId) })),
}));