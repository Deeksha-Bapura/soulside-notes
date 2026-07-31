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