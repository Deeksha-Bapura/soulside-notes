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
}): Promise<NoteListResponse> {
  const search = new URLSearchParams();
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.status && params.status.length > 0) {
    search.set('status', params.status.join(','));
  }

  const res = await fetch(`/api/notes?${search.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch notes: ${res.status}`);
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

export async function postTransition(params: {
  noteId: string;
  to: string;
  actorId: string;
  reason?: string;
}) {
  const res = await fetch(`/api/notes/${params.noteId}/transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: params.to, actorId: params.actorId, reason: params.reason }),
  });
  if (!res.ok) {
    throw new Error(`Transition failed: ${res.status}`);
  }
  return res.json();
}