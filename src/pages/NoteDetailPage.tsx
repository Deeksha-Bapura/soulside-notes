import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMachine } from '@xstate/react';
import { useState, useRef } from 'react';
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

function DiffLine({ oldText, newText }: { oldText: string; newText: string }) {
  const tokens = diffWords(oldText, newText);
  return (
    <p style={{ lineHeight: 1.6 }}>
      {tokens.map((t, idx) => {
        if (t.type === 'same') return <span key={idx}>{t.text}</span>;
        if (t.type === 'added')
          return (
            <span key={idx} style={{ background: '#d4f7d4', textDecoration: 'none' }}>
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

function NoteDetailView({ note }: { note: NoteDetail }) {
  const { currentUser } = useCurrentUser();
  const [rejectReason, setRejectReason] = useState('');
  const queryClient = useQueryClient();

  const initialSnapshot = noteMachine.resolveState({
    value: note.status as NoteStatus,
    context: {
      assignedReviewerId: note.assignedReviewer?.id ?? null,
      approvedAt: note.status === 'APPROVED' ? Date.now() : null,
    },
  });

  const [state, send] = useMachine(noteMachine, { snapshot: initialSnapshot });

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

  // --- SOAP editing + autosave ---
  const [sections, setSections] = useState(note.currentVersion.content.sections);
  const [dirtySections, setDirtySections] = useState<Set<string>>(new Set());
  const baseVersionIdRef = useRef(note.currentVersion.id);
  const [conflict, setConflict] = useState<VersionConflict | null>(null);

  const saveMutation = useMutation({
    mutationFn: saveVersion,
    onSuccess: (result) => {
      baseVersionIdRef.current = result.version.id;
      setDirtySections(new Set());
      queryClient.invalidateQueries({ queryKey: ['note', note.id] });
    },
    onError: (err) => {
      if ((err as VersionConflict).error === 'version_conflict') {
        setConflict(err as VersionConflict);
      } else {
        alert(`Save failed: ${(err as Error).message}`);
      }
    },
  });

  const debouncedSave = useDebouncedCallback((newSections: typeof sections) => {
    saveMutation.mutate({
      noteId: note.id,
      baseVersionId: baseVersionIdRef.current,
      content: { sections: newSections },
      clientMutationId: `${note.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
  }, 800);

  function handleSectionChange(key: keyof typeof sections, value: string) {
    const next = { ...sections, [key]: value };
    setSections(next);
    setDirtySections((prev) => new Set(prev).add(key));
    debouncedSave(next);
  }

  // --- Version history sidebar ---
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const { data: selectedVersion, isLoading: isLoadingVersion } = useQuery({
    queryKey: ['version', selectedVersionId],
    queryFn: () => fetchVersion(selectedVersionId!),
    enabled: !!selectedVersionId,
  });

  // --- Action bar setup ---
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

  return (
    <div style={{ padding: 20, display: 'flex', gap: 24 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link to="/">&larr; Back to notes</Link>
        <h1>{note.patient.displayName}</h1>
        <p>
          Status: <strong>{state.value as string}</strong>
          {note.assignedReviewer && ` — assigned to ${note.assignedReviewer.displayName}`}
        </p>

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

        <h2>Current version (revision {note.currentVersion.revision})</h2>
        {(['S', 'O', 'A', 'P'] as const).map((key) => (
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
              style={{ width: '100%', maxWidth: 600, display: 'block', marginTop: 4 }}
            />
          </div>
        ))}
        {saveMutation.isPending && <p style={{ fontSize: 12, color: '#888' }}>Saving version...</p>}
        {conflict && (
          <div style={{ background: '#fee', padding: 12, border: '1px solid #c00', marginBottom: 12 }}>
            <strong>Conflict detected:</strong> someone else (revision {conflict.current.revision},
            by {conflict.current.authoredBy.id}) saved changes after your last known version.
            <br />
            <em>(Full conflict resolution UI comes in the next step — for now, refresh to see their version.)</em>
          </div>
        )}

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

      {/* --- Version history sidebar --- */}
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
                {(['S', 'O', 'A', 'P'] as const).map((key) => (
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