import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMachine } from '@xstate/react';
import { useState, useRef, useEffect } from 'react';
import {
  fetchNoteDetail,
  postTransition,
  saveVersion,
  fetchVersion,
  type NoteDetail,
  type VersionConflict,
} from '../api/notesApi';
import { noteMachine, type NoteMachineEvent } from '../domain/noteMachine';
import type { NoteStatus } from '../domain/types';
import { useCurrentUser } from '../auth/CurrentUserContext';
import { useDebouncedCallback } from '../hooks/useDebouncedCallback';
import { diffWords } from '../lib/diffWords';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { enqueueWrite, getQueuedWritesForNote, clearQueuedWritesForNote } from '../offline/db';
import { useSyncStore } from '../offline/syncStore';
import { useNoteRealtime } from '../realtime/useNoteRealtime';
import { track } from '../telemetry/track';
import { replayQueuedWrites } from '../offline/replay';

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

  return <NoteDetailView key={data.id} note={data} />;
}

const EVENT_TO_STATUS: Record<string, string> = {
  start_review: 'IN_REVIEW',
  return: 'READY_FOR_REVIEW',
  approve: 'APPROVED',
  reject: 'REJECTED',
  resubmit: 'READY_FOR_REVIEW',
  regenerate: 'GENERATING',
};

type SoapSections = { S: string; O: string; A: string; P: string };
const SECTION_KEYS = ['S', 'O', 'A', 'P'] as const;

function DiffLine({ oldText, newText }: { oldText: string; newText: string }) {
  const tokens = diffWords(oldText, newText);
  return (
    <p style={{ lineHeight: 1.6, margin: '4px 0' }}>
      {tokens.map((t, idx) => {
        if (t.type === 'same') return <span key={idx}>{t.text}</span>;
        if (t.type === 'added')
          return (
            <span key={idx} style={{ background: '#d4f7d4' }}>
              {t.text}
            </span>
          );
        return (
          <span key={idx} style={{ background: '#f7d4d4', textDecoration: 'line-through' }}>
            {t.text}
          </span>
        );
      })}
    </p>
  );
}

function ConflictResolutionPanel({
  conflict,
  mySections,
  onResolve,
  onCancel,
}: {
  conflict: VersionConflict;
  mySections: SoapSections;
  onResolve: (resolved: SoapSections, newBaseVersionId: string) => void;
  onCancel: () => void;
}) {
  const { data: theirs, isLoading: loadingTheirs } = useQuery({
    queryKey: ['version', conflict.current.id],
    queryFn: () => fetchVersion(conflict.current.id),
  });

  const { data: ancestor, isLoading: loadingAncestor } = useQuery({
    queryKey: ['version', conflict.commonAncestor?.id],
    queryFn: () => fetchVersion(conflict.commonAncestor!.id),
    enabled: !!conflict.commonAncestor,
  });

  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>({
    S: 'mine',
    O: 'mine',
    A: 'mine',
    P: 'mine',
  });

  if (loadingTheirs || (conflict.commonAncestor && loadingAncestor)) {
    return <div style={{ padding: 16 }}>Loading conflicting version...</div>;
  }
  if (!theirs) return null;

  const ancestorSections = ancestor?.content.sections ?? theirs.content.sections;

  const resolvedSections: SoapSections = {
    S: choices.S === 'mine' ? mySections.S : theirs.content.sections.S,
    O: choices.O === 'mine' ? mySections.O : theirs.content.sections.O,
    A: choices.A === 'mine' ? mySections.A : theirs.content.sections.A,
    P: choices.P === 'mine' ? mySections.P : theirs.content.sections.P,
  };

  return (
    <div
      style={{
        background: '#fff8e1',
        border: '2px solid #c90',
        borderRadius: 6,
        padding: 16,
        marginBottom: 16,
      }}
    >
      <h3 style={{ marginTop: 0 }}>
        Save conflict — revision {theirs.revision} was saved by {theirs.authorId} while you
        were editing
      </h3>
      <p style={{ fontSize: 13, color: '#664' }}>
        Pick which version to keep for each section. Sections without an overlapping edit are
        usually safe to auto-merge; anything both of you touched needs a manual choice.
      </p>

      {SECTION_KEYS.map((key) => {
        const ancestorText = ancestorSections[key];
        const mineText = mySections[key];
        const theirsText = theirs.content.sections[key];
        const bothChangedSameSection = mineText !== ancestorText && theirsText !== ancestorText;

        return (
          <div
            key={key}
            style={{
              marginBottom: 16,
              padding: 10,
              background: '#fff',
              border: bothChangedSameSection ? '1px solid #c66' : '1px solid #ddd',
              borderRadius: 4,
            }}
          >
            <strong>
              {key}
              {bothChangedSameSection && (
                <span style={{ color: '#c00', fontSize: 12 }}> — both edited this section</span>
              )}
            </strong>

            <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
              Your changes (vs. common ancestor):
            </div>
            <DiffLine oldText={ancestorText} newText={mineText} />

            <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
              Their changes (vs. common ancestor):
            </div>
            <DiffLine oldText={ancestorText} newText={theirsText} />

            <div style={{ marginTop: 6 }}>
              <label style={{ marginRight: 16 }}>
                <input
                  type="radio"
                  name={`choice-${key}`}
                  checked={choices[key] === 'mine'}
                  onChange={() => setChoices((c) => ({ ...c, [key]: 'mine' }))}
                />{' '}
                Keep mine
              </label>
              <label>
                <input
                  type="radio"
                  name={`choice-${key}`}
                  checked={choices[key] === 'theirs'}
                  onChange={() => setChoices((c) => ({ ...c, [key]: 'theirs' }))}
                />{' '}
                Keep theirs
              </label>
            </div>
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => onResolve(resolvedSections, theirs.id)}>
          Save merged version
        </button>
        <button onClick={onCancel}>Cancel (discard my unsaved changes)</button>
      </div>
    </div>
  );
}

function NoteDetailView({ note }: { note: NoteDetail }) {
  const { currentUser } = useCurrentUser();
  const [rejectReason, setRejectReason] = useState('');
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  const conflictedNoteIds = useSyncStore((s) => s.conflictedNoteIds);
  const [pendingCount, setPendingCount] = useState(0);
  const { viewers } = useNoteRealtime(note.id);

  const initialSnapshot = noteMachine.resolveState({
    value: note.status as NoteStatus,
    context: {
      assignedReviewerId: note.assignedReviewer?.id ?? null,
      approvedAt: note.status === 'APPROVED' ? Date.now() : null,
    },
  });

  const [state, send] = useMachine(noteMachine, { snapshot: initialSnapshot });

  // Telemetry: fires once per note opened (not on every re-render), since
  // it's keyed on note.id in the dependency array.
  useEffect(() => {
    track('note_viewed', { noteId: note.id, status: note.status, role: currentUser.role });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  useEffect(() => {
    if (isOnline) {
      // Belt-and-suspenders: the global 'online' event (useReplayOnReconnect
      // in App.tsx) doesn't always fire reliably from DevTools' network
      // throttling toggle. Re-attempting replay here, keyed on our own
      // isOnline hook flipping true, catches that case too.
      replayQueuedWrites(queryClient).then(() => {
        getQueuedWritesForNote(note.id).then((writes) => setPendingCount(writes.length));
      });
    } else {
      getQueuedWritesForNote(note.id).then((writes) => setPendingCount(writes.length));
    }
  }, [note.id, isOnline, queryClient]);

  const transitionMutation = useMutation({
    mutationFn: postTransition,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ['note', note.id] });
      const previousNote = queryClient.getQueryData<NoteDetail>(['note', note.id]);

      queryClient.setQueryData<NoteDetail>(['note', note.id], (old) => {
        if (!old) return old;
        return {
          ...old,
          status: variables.to,
          assignedReviewer:
            variables.to === 'IN_REVIEW'
              ? { id: variables.actorId, displayName: variables.actorId, role: 'REVIEWER' }
              : variables.to === 'READY_FOR_REVIEW'
                ? null
                : old.assignedReviewer,
        };
      });

      return { previousNote };
    },
    onError: (err, _variables, context) => {
      if (context?.previousNote) {
        queryClient.setQueryData(['note', note.id], context.previousNote);
      }
      alert(`Action failed: ${(err as Error).message}. Reverted.`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['note', note.id] });
    },
  });

  const [sections, setSections] = useState<SoapSections>(note.currentVersion.content.sections);
  const [dirtySections, setDirtySections] = useState<Set<string>>(new Set());
  const baseVersionIdRef = useRef(note.currentVersion.id);
  const [conflict, setConflict] = useState<VersionConflict | null>(null);

  const saveMutation = useMutation({
    mutationFn: saveVersion,
    onSuccess: (result) => {
      baseVersionIdRef.current = result.version.id;
      setDirtySections(new Set());
      setConflict(null);
      clearQueuedWritesForNote(note.id).then(() => setPendingCount(0));
      useSyncStore.getState().clearConflict(note.id);
      queryClient.invalidateQueries({ queryKey: ['note', note.id] });
    },
    onError: async (err, variables) => {
      const maybeConflict = err as VersionConflict;
      if (maybeConflict?.error === 'version_conflict') {
        setConflict(maybeConflict);
        track('version_conflict_detected', { noteId: note.id });
        return;
      }
      await enqueueWrite({
        id: variables.clientMutationId,
        noteId: variables.noteId,
        baseVersionId: variables.baseVersionId,
        content: variables.content,
        queuedAt: new Date().toISOString(),
      });
      setPendingCount((c) => c + 1);
      track('write_queued_offline', { noteId: note.id });
    },
  });

  const debouncedSave = useDebouncedCallback((newSections: SoapSections) => {
    if (conflict) return;

    const payload = {
      noteId: note.id,
      baseVersionId: baseVersionIdRef.current,
      content: { sections: newSections },
      clientMutationId: `${note.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };

    // Known limitation of browser-based offline simulation: a stalled
    // (not rejected) fetch never reaches onError, so a save made while
    // offline can hang indefinitely instead of queueing. Checking
    // navigator.onLine up front avoids ever attempting a doomed request
    // in the first place, rather than relying solely on error handling.
    if (!navigator.onLine) {
      enqueueWrite({
        id: payload.clientMutationId,
        noteId: payload.noteId,
        baseVersionId: payload.baseVersionId,
        content: payload.content,
        queuedAt: new Date().toISOString(),
      }).then(() => setPendingCount((c) => c + 1));
      return;
    }

    saveMutation.mutate(payload);
  }, 800);

  function handleSectionChange(key: keyof SoapSections, value: string) {
    const next = { ...sections, [key]: value };
    setSections(next);
    setDirtySections((prev) => new Set(prev).add(key));
    debouncedSave(next);
  }

  function handleResolveConflict(resolved: SoapSections, newBaseVersionId: string) {
    track('conflict_resolved', { noteId: note.id });
    setSections(resolved);
    baseVersionIdRef.current = newBaseVersionId;
    saveMutation.mutate({
      noteId: note.id,
      baseVersionId: newBaseVersionId,
      content: { sections: resolved },
      clientMutationId: `${note.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  function handleCancelConflict() {
    queryClient.invalidateQueries({ queryKey: ['note', note.id] });
    setConflict(null);
  }

  useEffect(() => {
    if (!conflict) {
      setSections(note.currentVersion.content.sections);
      baseVersionIdRef.current = note.currentVersion.id;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.currentVersion.id]);

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const { data: selectedVersion, isLoading: isLoadingVersion } = useQuery({
    queryKey: ['version', selectedVersionId],
    queryFn: () => fetchVersion(selectedVersionId!),
    enabled: !!selectedVersionId,
  });

  const actor = { id: currentUser.id, role: currentUser.role };

  const actions: Array<{
    label: string;
    event: NoteMachineEvent;
    reasonIfDisabled: string;
  }> = [
    {
      label: 'Start review',
      event: { type: 'start_review', actor },
      reasonIfDisabled:
        currentUser.role !== 'REVIEWER'
          ? `Only reviewers can start a review (you are ${currentUser.role})`
          : 'Not available in the current state',
    },
    {
      label: 'Return to queue',
      event: { type: 'return', actor },
      reasonIfDisabled:
        note.assignedReviewer?.id !== currentUser.id
          ? 'Only the assigned reviewer can return this note'
          : 'Not available in the current state',
    },
    {
      label: 'Approve',
      event: { type: 'approve', actor, mfaVerified: true },
      reasonIfDisabled:
        note.assignedReviewer?.id !== currentUser.id
          ? 'Only the assigned reviewer can approve'
          : 'Not available in the current state',
    },
    {
      label: 'Reject',
      event: { type: 'reject', actor, reason: rejectReason },
      reasonIfDisabled:
        note.assignedReviewer?.id !== currentUser.id
          ? 'Only the assigned reviewer can reject'
          : rejectReason.trim().length === 0
            ? 'A reason is required to reject'
            : 'Not available in the current state',
    },
    {
      label: 'Resubmit',
      event: { type: 'resubmit', actor },
      reasonIfDisabled:
        currentUser.role !== 'CLINICIAN'
          ? `Only clinicians can resubmit (you are ${currentUser.role})`
          : 'Not available in the current state',
    },
    {
      label: 'Regenerate',
      event: { type: 'regenerate', actor },
      reasonIfDisabled:
        currentUser.role !== 'CLINICIAN' && currentUser.role !== 'ADMIN'
          ? `Only clinicians or admins can regenerate (you are ${currentUser.role})`
          : 'Not available in the current state',
    },
  ];

  const noteHasUnresolvedConflict = conflictedNoteIds.includes(note.id);

  return (
    <div style={{ padding: 20, display: 'flex', gap: 24 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link to="/">&larr; Back to notes</Link>
        <h1>{note.patient.displayName}</h1>
        <p>
          Status: <strong>{note.status}</strong>
          {note.assignedReviewer && ` — assigned to ${note.assignedReviewer.displayName}`}
        </p>

        {viewers.length > 1 && (
          <p style={{ fontSize: 12, color: '#666' }}>
            👀 Also viewing: {viewers.filter((v) => v.id).map((v) => v.id).join(', ')}
          </p>
        )}

        {pendingCount > 0 && (
          <p style={{ background: '#eef', padding: 8, fontSize: 13 }}>
            {pendingCount} change{pendingCount > 1 ? 's' : ''} waiting to sync
            {!isOnline && ' (offline)'}.
          </p>
        )}
        {noteHasUnresolvedConflict && (
          <p style={{ background: '#fee', padding: 8, fontSize: 13, color: '#a00' }}>
            A queued change to this note conflicted with a newer version. Edit the section below
            to trigger conflict resolution.
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {actions.map(({ label, event, reasonIfDisabled }) => {
            const enabled = state.can(event);
            return (
              <div key={label} title={enabled ? undefined : reasonIfDisabled}>
                <button
                  disabled={!enabled || transitionMutation.isPending}
                  onClick={() => {
                    send(event);
                    transitionMutation.mutate({
                      noteId: note.id,
                      to: EVENT_TO_STATUS[event.type],
                      actorId: currentUser.id,
                      reason: event.type === 'reject' ? rejectReason : undefined,
                    });
                    track('note_transition_attempted', {
                      noteId: note.id,
                      eventType: event.type,
                      fromStatus: note.status,
                      toStatus: EVENT_TO_STATUS[event.type],
                    });
                  }}
                  style={{ opacity: enabled ? 1 : 0.5 }}
                >
                  {label}
                </button>
                {!enabled && (
                  <div style={{ fontSize: 11, color: '#a00', maxWidth: 140 }}>
                    {reasonIfDisabled}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {transitionMutation.isPending && (
          <p style={{ fontSize: 12, color: '#888' }}>Saving...</p>
        )}

        <div style={{ marginBottom: 16 }}>
          <label>
            Reject reason:{' '}
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="required to reject"
            />
          </label>
        </div>

        {conflict && (
          <ConflictResolutionPanel
            conflict={conflict}
            mySections={sections}
            onResolve={handleResolveConflict}
            onCancel={handleCancelConflict}
          />
        )}

        <h2>Current version (revision {note.currentVersion.revision})</h2>
        {SECTION_KEYS.map((key) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <strong>
              {key}
              {dirtySections.has(key) && (
                <span style={{ color: '#a80', fontSize: 12 }}> (unsaved)</span>
              )}
            </strong>
            <textarea
              value={sections[key]}
              onChange={(e) => handleSectionChange(key, e.target.value)}
              rows={2}
              disabled={!!conflict}
              style={{ width: '100%', maxWidth: 600, display: 'block', marginTop: 4 }}
            />
          </div>
        ))}
        {saveMutation.isPending && <p style={{ fontSize: 12, color: '#888' }}>Saving version...</p>}

        <h3>Review history</h3>
        <ul>
          {note.review.events.map((event) => (
            <li key={event.id}>
              {event.fromStatus ?? '(created)'} → {event.toStatus} by {event.actorId} at{' '}
              {new Date(event.occurredAt).toLocaleString()}
              {event.reason && ` — "${event.reason}"`}
            </li>
          ))}
        </ul>
      </div>

      <div style={{ width: 320, flexShrink: 0, borderLeft: '1px solid #ddd', paddingLeft: 20 }}>
        <h3>Version history</h3>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {note.versions
            .slice()
            .sort((a, b) => b.revision - a.revision)
            .map((v) => (
              <li key={v.id} style={{ marginBottom: 6 }}>
                <button
                  onClick={() => setSelectedVersionId(v.id === selectedVersionId ? null : v.id)}
                  style={{
                    background: v.id === selectedVersionId ? '#eef' : 'transparent',
                    border: '1px solid #ccc',
                    padding: '4px 8px',
                    width: '100%',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  Revision {v.revision}
                  {v.id === note.currentVersion.id && ' (current)'}
                  <br />
                  <span style={{ fontSize: 11, color: '#666' }}>
                    by {v.authoredBy.id} ({v.authoredBy.role})
                  </span>
                </button>
              </li>
            ))}
        </ul>

        {selectedVersionId && (
          <div style={{ marginTop: 16 }}>
            <h4>
              Diff: revision {selectedVersion?.revision ?? '...'} → current (
              {note.currentVersion.revision})
            </h4>
            {isLoadingVersion && <p>Loading version...</p>}
            {selectedVersion && (
              <div style={{ fontSize: 13 }}>
                {SECTION_KEYS.map((key) => (
                  <div key={key} style={{ marginBottom: 10 }}>
                    <strong>{key}</strong>
                    <DiffLine
                      oldText={selectedVersion.content.sections[key]}
                      newText={sections[key]}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}