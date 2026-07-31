import { useQuery } from '@tanstack/react-query';
import { fetchNotes } from './api/notesApi';

function App() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['notes', { cursor: null }],
    queryFn: () => fetchNotes({ cursor: null, limit: 50 }),
  });

  if (isLoading) return <div>Loading notes...</div>;
  if (error) return <div>Error loading notes: {(error as Error).message}</div>;

  return (
    <div style={{ padding: 20 }}>
      <h1>Notes ({data?.meta.total} total)</h1>
      <ul>
        {data?.items.map((note) => (
          <li key={note.id}>
            {note.patient.displayName} — {note.status}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;