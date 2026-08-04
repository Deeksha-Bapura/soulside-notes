// Thin API client layer. Nothing else in the app should call `fetch` directly
// for notes-related endpoints — this is the seam that would let the team
// swap the transport (REST -> GraphQL, or a different backend) without
// touching any component.

export interface NoteListItem {
  id: string;
  patient: { id: string; displayName: string };
  status: string;
  currentVersion: { id: string; revision: number };
  assignedReviewer: { id: string; displayName: string; role: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteListResponse {
  cursor: { next: string | null; hasMore: boolean };
  items: NoteListItem[];
  meta: { total: number; returned: number; generatedAt: string };
}

export async function fetchNotes(params: {
  cursor?: string | null;
  limit?: number;
  status?: string[];
  reviewer?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}): Promise<NoteListResponse> {
  const search = new URLSearchParams();
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.status && params.status.length > 0) {
    search.set('status', params.status.join(','));
  }
  if (params.reviewer) search.set('reviewer', params.reviewer);
  if (params.search) search.set('search', params.search);
  if (params.dateFrom) search.set('dateFrom', params.dateFrom);
  if (params.dateTo) search.set('dateTo', params.dateTo);
  if (params.sortBy) search.set('sortBy', params.sortBy);
  if (params.sortDir) search.set('sortDir', params.sortDir);

  const res = await fetch(`/api/notes?${search.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch notes: ${res.status}`);
  }
  return res.json();
}

export async function bulkAssignReviewer(params: {
  noteIds: string[];
  reviewerId: string;
}): Promise<{ updated: string[]; skipped: string[] }> {
  const res = await fetch('/api/notes/bulk-assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(`Bulk assign failed: ${res.status}`);
  }
  return res.json();
}

export interface NoteDetail {
  id: string;
  patient: { id: string; displayName: string };
  status: string;
  assignedReviewer: { id: string; displayName: string; role: string } | null;
  currentVersion: {
    id: string;
    noteId: string;
    revision: number;
    parentVersionId: string | null;
    content: { sections: { S: string; O: string; A: string; P: string } };
    authorId: string;
    authorRole: string;
    createdAt: string;
  };
  versions: Array<{
    id: string;
    revision: number;
    parentVersionId: string | null;
    authoredBy: { id: string; role: string };
  }>;
  review: {
    events: Array<{
      id: string;
      fromStatus: string | null;
      toStatus: string;
      actorId: string;
      occurredAt: string;
      reason?: string;
    }>;
  };
}

export async function fetchNoteDetail(id: string): Promise<NoteDetail> {
  const res = await fetch(`/api/notes/${id}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch note ${id}: ${res.status}`);
  }
  return res.json();
}

import type { NoteMachineEvent } from '../domain/noteMachine';

export async function postTransition(params: {
  noteId: string;
  event: NoteMachineEvent;
}) {
  const res = await fetch(`/api/notes/${params.noteId}/transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: params.event }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Transition failed: ${res.status}`);
  }
  return res.json();
}

export interface SaveVersionResult {
  version: { id: string; revision: number; parentVersionId: string | null };
}

export interface VersionConflict {
  error: 'version_conflict';
  current: { id: string; revision: number; authoredBy: { id: string; role: string } };
  commonAncestor: { id: string; revision: number } | null;
}

export async function saveVersion(params: {
  noteId: string;
  baseVersionId: string;
  content: { sections: { S: string; O: string; A: string; P: string } };
  clientMutationId: string;
}): Promise<SaveVersionResult> {
  const res = await fetch(`/api/notes/${params.noteId}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseVersionId: params.baseVersionId,
      content: params.content,
      clientMutationId: params.clientMutationId,
    }),
  });

  if (res.status === 409) {
    const conflict: VersionConflict = await res.json();
    // Throwing a typed object (not just an Error) lets the caller
    // distinguish "a real conflict, show the diff UI" from "network
    // failure, just retry" — these need very different UI responses.
    throw conflict;
  }

  if (!res.ok) {
    throw new Error(`Failed to save version: ${res.status}`);
  }
  return res.json();
}

export interface FullVersion {
  id: string;
  noteId: string;
  revision: number;
  parentVersionId: string | null;
  content: { sections: { S: string; O: string; A: string; P: string } };
  authorId: string;
  authorRole: string;
  createdAt: string;
}

export async function fetchVersion(versionId: string): Promise<FullVersion> {
  const res = await fetch(`/api/versions/${versionId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch version ${versionId}: ${res.status}`);
  }
  return res.json();
}