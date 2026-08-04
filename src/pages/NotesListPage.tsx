import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useEffect, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSearchParams, Link } from 'react-router-dom';
import { fetchNotes, bulkAssignReviewer } from '../api/notesApi';
import type { NoteStatus } from '../domain/types';
import { useDebouncedCallback } from '../hooks/useDebouncedCallback';
import { useCurrentUser, FAKE_USERS } from '../auth/CurrentUserContext';
import { useVisibleNotesRealtime } from '../realtime/useVisibleNotesRealtime';

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

function SkeletonRow() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        height: ROW_HEIGHT,
      }}
    >
      <div style={{ width: 16, height: 16, background: '#eee', borderRadius: 3 }} />
      <div style={{ width: 140, height: 14, background: '#eee', borderRadius: 4 }} />
      <div style={{ width: 90, height: 20, background: '#eee', borderRadius: 999, marginLeft: 'auto' }} />
    </div>
  );
}

const REVIEWERS = ['dr_a', 'dr_b', 'dr_c', 'dr_d'];

export default function NotesListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentUser } = useCurrentUser();
  const queryClient = useQueryClient();

  const activeStatuses = useMemo(() => {
    const param = searchParams.get('status');
    return param ? (param.split(',') as NoteStatus[]) : [];
  }, [searchParams]);

  const activeReviewer = searchParams.get('reviewer') ?? '';
  const dateFrom = searchParams.get('dateFrom') ?? '';
  const dateTo = searchParams.get('dateTo') ?? '';
  const sortBy = searchParams.get('sortBy') ?? 'updatedAt';
  const sortDir = (searchParams.get('sortDir') as 'asc' | 'desc') ?? 'desc';

  // Search has its own local state + debounce, separate from the URL sync
  // that happens for other filters — typing shouldn't rewrite the URL on
  // every keystroke (that would spam browser history), only after the
  // debounce settles.
  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const activeSearch = searchParams.get('search') ?? '';

  const debouncedSetSearch = useDebouncedCallback((value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value.trim()) {
      params.set('search', value.trim());
    } else {
      params.delete('search');
    }
    setSearchParams(params);
  }, 400);

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    setSearchParams(params);
  }

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

  function toggleSort(field: string) {
    const params = new URLSearchParams(searchParams);
    if (sortBy === field) {
      params.set('sortDir', sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      params.set('sortBy', field);
      params.set('sortDir', 'asc');
    }
    setSearchParams(params);
  }

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: [
        'notes',
        { status: activeStatuses, reviewer: activeReviewer, search: activeSearch, dateFrom, dateTo, sortBy, sortDir },
      ],
      queryFn: ({ pageParam }) =>
        fetchNotes({
          cursor: pageParam,
          limit: 50,
          status: activeStatuses,
          reviewer: activeReviewer || undefined,
          search: activeSearch || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          sortBy,
          sortDir,
        }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) =>
        lastPage.cursor.hasMore ? lastPage.cursor.next : undefined,
    });

  const allNotes = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages[0]?.meta.total ?? 0;

  // Bulk selection — persists across scroll/pagination/filter changes for
  // the session, per spec: "selection must survive pagination and filter
  // changes for as long as the row is in view." We keep it simple: a Set
  // of ids, not cleared by refetches or filter toggles.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkReviewerId, setBulkReviewerId] = useState(REVIEWERS[0]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const bulkAssignMutation = useMutation({
    mutationFn: bulkAssignReviewer,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      setSelectedIds(new Set());
      if (result.skipped.length > 0) {
        alert(
          `Assigned ${result.updated.length} note(s). Skipped ${result.skipped.length} (not READY_FOR_REVIEW).`
        );
      }
    },
  });

  const parentRef = useRef<HTMLDivElement>(null);
  const rowCount = hasNextPage ? allNotes.length + 1 : allNotes.length;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const visibleNoteIds = virtualizer
    .getVirtualItems()
    .map((item) => allNotes[item.index]?.id)
    .filter((id): id is string => !!id);

  useVisibleNotesRealtime(visibleNoteIds, [
    'notes',
    { status: activeStatuses, reviewer: activeReviewer, search: activeSearch, dateFrom, dateTo, sortBy, sortDir },
  ]);

  useEffect(() => {
    const items = virtualizer.getVirtualItems();
    const lastItem = items[items.length - 1];
    if (!lastItem) return;
    if (lastItem.index >= allNotes.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [virtualizer.getVirtualItems(), allNotes.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (error) return <div style={{ padding: 24 }}>Error loading notes: {(error as Error).message}</div>;

  const sortHeaderStyle = (field: string): React.CSSProperties => ({
    cursor: 'pointer',
    fontWeight: sortBy === field ? 700 : 500,
    color: sortBy === field ? 'var(--navy-900)' : 'var(--text-muted)',
    userSelect: 'none',
  });

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 32 }}>
        Notes{' '}
        <span style={{ color: 'var(--text-muted)', fontSize: 18, fontFamily: 'Poppins' }}>
          ({total} total{allNotes.length !== total ? `, ${allNotes.length} loaded` : ''})
        </span>
      </h1>

      {/* Search */}
      <input
        type="text"
        placeholder="Search patient name or note content..."
        value={searchInput}
        onChange={(e) => {
          setSearchInput(e.target.value);
          debouncedSetSearch(e.target.value);
        }}
        style={{
          width: '100%',
          maxWidth: 400,
          padding: '8px 12px',
          borderRadius: 6,
          border: '1px solid var(--border-subtle)',
          fontFamily: 'Poppins, sans-serif',
          fontSize: 13,
          marginBottom: 12,
        }}
      />
      {activeSearch && allNotes.length === 0 && !isLoading && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          No results for "{activeSearch}". Try a different search term.
        </p>
      )}

      {/* Status filter pills */}
      <div style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
              }}
            >
              {status.replace(/_/g, ' ')}
            </button>
          );
        })}
      </div>

      {/* Reviewer + date range filters */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13 }}>
          Reviewer:{' '}
          <select
            value={activeReviewer}
            onChange={(e) => updateParam('reviewer', e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border-subtle)' }}
          >
            <option value="">Any</option>
            {REVIEWERS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          Updated from:{' '}
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => updateParam('dateFrom', e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border-subtle)' }}
          />
        </label>
        <label style={{ fontSize: 13 }}>
          to:{' '}
          <input
            type="date"
            value={dateTo}
            onChange={(e) => updateParam('dateTo', e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border-subtle)' }}
          />
        </label>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'var(--lavender-50)',
            padding: '10px 14px',
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          <strong style={{ fontSize: 13 }}>{selectedIds.size} selected</strong>
          <select
            value={bulkReviewerId}
            onChange={(e) => setBulkReviewerId(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 4 }}
          >
            {REVIEWERS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              bulkAssignMutation.mutate({ noteIds: Array.from(selectedIds), reviewerId: bulkReviewerId })
            }
            disabled={bulkAssignMutation.isPending}
            style={{
              background: 'var(--amber-500)',
              border: 'none',
              borderRadius: 6,
              padding: '6px 14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {bulkAssignMutation.isPending ? 'Assigning...' : 'Assign reviewer'}
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Sortable header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 16px',
          fontSize: 12,
          color: 'var(--text-muted)',
          borderBottom: '2px solid var(--border-subtle)',
        }}
      >
        <div style={{ width: 16 }} />
        <div style={sortHeaderStyle('patientName')} onClick={() => toggleSort('patientName')}>
          Patient {sortBy === 'patientName' && (sortDir === 'asc' ? '▲' : '▼')}
        </div>
        <div style={{ marginLeft: 'auto', ...sortHeaderStyle('status') }} onClick={() => toggleSort('status')}>
          Status {sortBy === 'status' && (sortDir === 'asc' ? '▲' : '▼')}
        </div>
        <div style={{ width: 90, ...sortHeaderStyle('updatedAt') }} onClick={() => toggleSort('updatedAt')}>
          Updated {sortBy === 'updatedAt' && (sortDir === 'asc' ? '▲' : '▼')}
        </div>
      </div>

      {isLoading ? (
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: '#fff' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
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
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '0 16px',
                  }}
                >
                  {isLoaderRow ? (
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading more...</span>
                  ) : (
                    <>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(note.id)}
                        onChange={() => toggleSelect(note.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <Link
                        to={`/notes/${note.id}`}
                        style={{
                          textDecoration: 'none',
                          color: 'inherit',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        <span style={{ fontWeight: 500 }}>{note.patient.displayName}</span>
                        <StatusBadge status={note.status} />
                      </Link>
                    </>
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