import { useInfiniteQuery } from '@tanstack/react-query';
import { useRef, useEffect, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSearchParams, Link } from 'react-router-dom';
import { fetchNotes } from '../api/notesApi';
import type { NoteStatus } from '../domain/types';

const ROW_HEIGHT = 44;

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

const STATUS_COLORS: Record<NoteStatus, { bg: string; text: string }> = {
  GENERATING: { bg: '#f0f0fd', text: '#4a4a8a' },
  READY_FOR_REVIEW: { bg: '#fff8e1', text: '#a87a00' },
  IN_REVIEW: { bg: '#e8f0fe', text: '#1a4a8a' },
  APPROVED: { bg: '#e3f7e3', text: '#1a6b1a' },
  REJECTED: { bg: '#fdeaea', text: '#a02020' },
  AMENDED: { bg: '#f0f0fd', text: '#4a4a8a' },
  LOCKED: { bg: '#f0f0f0', text: '#555' },
  FAILED: { bg: '#fdeaea', text: '#a02020' },
};

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status as NoteStatus] ?? { bg: '#eee', text: '#555' };
  return (
    <span
      style={{
        background: colors.bg,
        color: colors.text,
        fontSize: 12,
        fontWeight: 600,
        padding: '3px 10px',
        borderRadius: 999,
        letterSpacing: 0.3,
      }}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export default function NotesListPage() {
  const [searchParams, setSearchParams] = useSearchParams();

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

  if (error) return <div style={{ padding: 24 }}>Error loading notes: {(error as Error).message}</div>;

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <h1 style={{ fontSize: 32 }}>
        Notes <span style={{ color: 'var(--text-muted)', fontSize: 18, fontFamily: 'Poppins' }}>
          ({total} total{allNotes.length !== total ? `, ${allNotes.length} loaded` : ''})
        </span>
      </h1>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {ALL_STATUSES.map((status) => {
          const active = activeStatuses.includes(status);
          return (
            <button
              key={status}
              onClick={() => toggleStatus(status)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 14px',
                borderRadius: 999,
                border: active ? '1px solid var(--navy-900)' : '1px solid var(--border-subtle)',
                background: active ? 'var(--navy-900)' : '#fff',
                color: active ? '#fff' : 'var(--text-muted)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {status.replace(/_/g, ' ')}
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading notes...
        </div>
      ) : (
        <div
          ref={parentRef}
          style={{
            height: '600px',
            overflow: 'auto',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            background: '#fff',
          }}
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
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  {isLoaderRow ? (
                    <div
                      style={{
                        padding: '0 16px',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        color: 'var(--text-muted)',
                        fontSize: 13,
                      }}
                    >
                      Loading more...
                    </div>
                  ) : (
                    <Link
                      to={`/notes/${note.id}`}
                      style={{
                        textDecoration: 'none',
                        color: 'inherit',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0 16px',
                        height: '100%',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--lavender-50)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span style={{ fontWeight: 500 }}>{note.patient.displayName}</span>
                      <StatusBadge status={note.status} />
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}