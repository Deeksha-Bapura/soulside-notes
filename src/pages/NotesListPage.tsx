import { useInfiniteQuery } from '@tanstack/react-query';
import { useRef, useEffect, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSearchParams } from 'react-router-dom';
import { fetchNotes } from '../api/notesApi';
import type { NoteStatus } from '../domain/types';

const ROW_HEIGHT = 40;

const ALL_STATUSES: NoteStatus[] = [
  'GENERATING',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'AMENDED',
  'LOCKED',
  'FAILED',
];

export default function NotesListPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // The URL is the source of truth for which statuses are active — not
  // React state. This is what makes the filtered view bookmarkable and
  // shareable, and it also means browser back/forward "just works" for
  // filter changes without any extra code.
  const activeStatuses = useMemo(() => {
    const param = searchParams.get('status');
    return param ? (param.split(',') as NoteStatus[]) : [];
  }, [searchParams]);

  function toggleStatus(status: NoteStatus) {
    const next = activeStatuses.includes(status)
      ? activeStatuses.filter((s) => s !== status)
      : [...activeStatuses, status];

    const params = new URLSearchParams(searchParams);
    if (next.length > 0) {
      params.set('status', next.join(','));
    } else {
      params.delete('status');
    }
    setSearchParams(params);
  }

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      // Filters are part of the query key: changing them means React Query
      // treats this as a DIFFERENT cached query, so switching a filter on
      // and back off instantly shows cached results instead of refetching.
      queryKey: ['notes', { status: activeStatuses }],
      queryFn: ({ pageParam }) =>
        fetchNotes({ cursor: pageParam, limit: 50, status: activeStatuses }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) =>
        lastPage.cursor.hasMore ? lastPage.cursor.next : undefined,
    });

  const allNotes = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages[0]?.meta.total ?? 0;

  const parentRef = useRef<HTMLDivElement>(null);
  const rowCount = hasNextPage ? allNotes.length + 1 : allNotes.length;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  useEffect(() => {
    const items = virtualizer.getVirtualItems();
    const lastItem = items[items.length - 1];
    if (!lastItem) return;

    if (lastItem.index >= allNotes.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [virtualizer.getVirtualItems(), allNotes.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (error) return <div>Error loading notes: {(error as Error).message}</div>;

  return (
    <div style={{ padding: 20 }}>
      <h1>Notes ({total} total, {allNotes.length} loaded)</h1>

      <div style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {ALL_STATUSES.map((status) => (
          <label key={status} style={{ fontSize: 14 }}>
            <input
              type="checkbox"
              checked={activeStatuses.includes(status)}
              onChange={() => toggleStatus(status)}
            />
            {' '}{status}
          </label>
        ))}
      </div>

      {isLoading ? (
        <div>Loading notes...</div>
      ) : (
        <div
          ref={parentRef}
          style={{ height: '600px', overflow: 'auto', border: '1px solid #ccc' }}
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
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
      )}
    </div>
  );
}