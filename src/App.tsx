import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchNotes } from './api/notesApi';

function App() {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['notes'],
      queryFn: ({ pageParam }) => fetchNotes({ cursor: pageParam, limit: 50 }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) =>
        lastPage.cursor.hasMore ? lastPage.cursor.next : undefined,
    });

  if (isLoading) return <div>Loading notes...</div>;
  if (error) return <div>Error loading notes: {(error as Error).message}</div>;

  const allNotes = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages[0]?.meta.total ?? 0;

  return (
    <div style={{ padding: 20 }}>
      <h1>Notes ({total} total, {allNotes.length} loaded)</h1>
      <ul>
        {allNotes.map((note) => (
          <li key={note.id}>
            {note.patient.displayName} — {note.status}
          </li>
        ))}
      </ul>
      {hasNextPage && (
        <button onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? 'Loading more...' : 'Load more'}
        </button>
      )}
    </div>
  );
}

export default App;