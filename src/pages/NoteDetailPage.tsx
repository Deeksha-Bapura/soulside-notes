import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMachine } from '@xstate/react';
import { fetchNoteDetail, postTransition, type NoteDetail } from '../api/notesApi';
import { noteMachine, type NoteMachineEvent } from '../domain/noteMachine';
import type { NoteStatus } from '../domain/types';
import { useCurrentUser } from '../auth/CurrentUserContext';
import { useState } from 'react';

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

// Maps a machine event type to the status it transitions TO. This is a
// known simplification: it's a parallel lookup table that could in
// principle drift out of sync with the machine definition. A more robust
// version would have the machine itself expose "target state for this
// event" rather than duplicating that knowledge here — worth calling out
// as a deliberate trade-off in the README rather than hiding it.
const EVENT_TO_STATUS: Record<string, string> = {
  start_review: 'IN_REVIEW',
  return: 'READY_FOR_REVIEW',
  approve: 'APPROVED',
  reject: 'REJECTED',
  resubmit: 'READY_FOR_REVIEW',
  regenerate: 'GENERATING',
};

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

    // Fires BEFORE the request goes out. This is where we make the UI
    // lie convincingly — updating the cache as if the server already
    // said yes — while keeping a snapshot so we can undo it if we're wrong.
    onMutate: async (variables) => {
      // Stop any in-flight refetch for this note from clobbering our
      // optimistic write with stale data arriving late.
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

      // Returned value becomes `context` in onError/onSettled below —
      // this is how we hand the "before" snapshot forward.
      return { previousNote };
    },

    // Server said no (or the request errored/timed out) — undo the
    // optimistic write by restoring exactly what was cached before.
    onError: (err, _variables, context) => {
      if (context?.previousNote) {
        queryClient.setQueryData(['note', note.id], context.previousNote);
      }
      alert(`Action failed: ${(err as Error).message}. Reverted.`);
    },

    // Runs after EITHER success or error. Refetching here is what
    // guarantees eventual correctness even if our optimistic guess about
    // assignedReviewer/status was subtly wrong (e.g. a real backend might
    // apply side effects our optimistic update didn't anticipate).
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['note', note.id] });
    },
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

  return (
    <div style={{ padding: 20 }}>
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
      {Object.entries(note.currentVersion.content.sections).map(([key, value]) => (
        <div key={key} style={{ marginBottom: 12 }}>
          <strong>{key}</strong>
          <p>{value}</p>
        </div>
      ))}

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
  );
}