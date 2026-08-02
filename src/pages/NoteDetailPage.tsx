import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchNoteDetail } from '../api/notesApi';

export default function NoteDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['note', id],
    queryFn: () => fetchNoteDetail(id!),
    enabled: !!id,
  });

  if (isLoading) return <div style={{ padding: 20 }}>Loading note...</div>;
  if (error) return <div style={{ padding: 20 }}>Error: {(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div style={{ padding: 20 }}>
      <Link to="/">&larr; Back to notes</Link>
      <h1>{data.patient.displayName}</h1>
      <p>
        Status: <strong>{data.status}</strong>
        {data.assignedReviewer && ` — assigned to ${data.assignedReviewer.displayName}`}
      </p>

      <h2>Current version (revision {data.currentVersion.revision})</h2>
      {Object.entries(data.currentVersion.content.sections).map(([key, value]) => (
        <div key={key} style={{ marginBottom: 12 }}>
          <strong>{key}</strong>
          <p>{value}</p>
        </div>
      ))}

      <h3>Review history</h3>
      <ul>
        {data.review.events.map((event) => (
          <li key={event.id}>
            {event.fromStatus ?? '(created)'} → {event.toStatus} by {event.actorId} at{' '}
            {new Date(event.occurredAt).toLocaleString()}
            {event.reason && ` — "${event.reason}"`}
          </li>
        ))}
      </ul>
    </div>
  );
}