import { useInfiniteQuery } from '@tanstack/react-query';
import { useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { fetchNotes } from './api/notesApi';

const ROW_HEIGHT = 40;

function App() {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['notes'],
      queryFn: ({ pageParam }) => fetchNotes({ cursor: pageParam, limit: 50 }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) =>
        lastPage.cursor.hasMore ? lastPage.cursor.next : undefined,
    });

  const allNotes = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages[0]?.meta.total ?? 0;

  const parentRef = useRef<HTMLDivElement>(null);

  // One extra virtual row at the end acts as a "loader sentinel" whenever
  // there are more pages to fetch — this is what triggers auto-loading.
  const rowCount = hasNextPage ? allNotes.length + 1 : allNotes.length;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // When the last (sentinel) row scrolls into view, load the next page.
  useEffect(() => {
    const items = virtualizer.getVirtualItems();
    const lastItem = items[items.length - 1];
    if (!lastItem) return;

    if (lastItem.index >= allNotes.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [virtualizer.getVirtualItems(), allNotes.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (isLoading) return <div>Loading notes...</div>;
  if (error) return <div>Error loading notes: {(error as Error).message}</div>;

  return (
    <div style={{ padding: 20 }}>
      <h1>Notes ({total} total, {allNotes.length} loaded)</h1>
      <div
        ref={parentRef}
        style={{
          height: '600px',
          overflow: 'auto',
          border: '1px solid #ccc',
        }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const isLoaderRow = virtualRow.index > allNotes.length - 1;
            const note = allNotes[virtualRow.index];

            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                  display: 'flex',
                  alignItems: 'center',
                  borderBottom: '1px solid #eee',
                  padding: '0 8px',
                }}
              >
                {isLoaderRow
                  ? 'Loading more...'
                  : `${note.patient.displayName} — ${note.status}`}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default App;