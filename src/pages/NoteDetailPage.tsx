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
import type { NoteStatus, ReviewEvent } from '../domain/types';
import { useCurrentUser } from '../auth/CurrentUserContext';
import { useDebouncedCallback } from '../hooks/useDebouncedCallback';
import { diffWords } from '../lib/diffWords';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { enqueueWrite, getQueuedWritesForNote, clearQueuedWritesForNote } from '../offline/db';
import { replayQueuedWrites } from '../offline/replay';
import { useSyncStore } from '../offline/syncStore';
import { useNoteRealtime } from '../realtime/useNoteRealtime';
import { track } from '../telemetry/track';
import { canEditNoteContent } from '../auth/permissions';

export default function NoteDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['note', id],
    queryFn: () => fetchNoteDetail(id!),
    enabled: !!id,
  });

  if (isLoading) return <div style={{ padding: 24 }}>Loading note...</div>;
  if (error) return <div style={{ padding: 24 }}>Error: {(error as Error).message}</div>;
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
  amend: 'AMENDED',
};

// Reverse lookup: given a (fromStatus -> toStatus) pair pushed over the
// real-time channel, figure out which machine event type would produce
// that same transition, so a server-pushed change can be replayed through
// the SAME machine a user click would use, not just applied as a raw
// cache patch. This is a best-effort reconstruction — for transitions
// reachable via more than one event type it picks the first match, which
// is fine here since we only need a legal event that lands in the right
// state, not to recover which literal button someone else clicked.
function reconstructEventForTransition(
  fromStatus: string,
  toStatus: string,
  actorId: string
): NoteMachineEvent | null {
  const actor = { id: actorId, role: 'REVIEWER' as const };
  const candidates: Array<[string, NoteMachineEvent]> = [
    ['GENERATING->READY_FOR_REVIEW', { type: 'generation.complete' }],
    ['GENERATING->FAILED', { type: 'generation.error' }],
    ['FAILED->GENERATING', { type: 'regenerate', actor }],
    ['READY_FOR_REVIEW->IN_REVIEW', { type: 'start_review', actor }],
    ['IN_REVIEW->READY_FOR_REVIEW', { type: 'return', actor }],
    ['IN_REVIEW->APPROVED', { type: 'approve', actor, mfaVerified: true }],
    ['IN_REVIEW->REJECTED', { type: 'reject', actor, reason: '(reason not transmitted)' }],
    ['REJECTED->READY_FOR_REVIEW', { type: 'resubmit', actor }],
    ['APPROVED->AMENDED', { type: 'amend', actor, now: Date.now() }],
    ['APPROVED->LOCKED', { type: 'grace_expired' }],
    ['AMENDED->IN_REVIEW', { type: 'start_review', actor }],
  ];
  const key = `${fromStatus}->${toStatus}`;
  const match = candidates.find(([k]) => k === key);
  return match ? match[1] : null;
}

type SoapSections = { S: string; O: string; A: string; P: string };
const SECTION_KEYS = ['S', 'O', 'A', 'P'] as const;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
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
  const colors = STATUS_COLORS[status] ?? { bg: '#eee', text: '#555' };
  return (
    <span
      style={{
        background: colors.bg,
        color: colors.text,
        fontSize: 13,
        fontWeight: 600,
        padding: '4px 12px',
        borderRadius: 999,
        letterSpacing: 0.3,
      }}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

const visuallyHiddenStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
};

function DiffLine({ oldText, newText }: { oldText: string; newText: string }) {
  const tokens = diffWords(oldText, newText);
  return (
    <p style={{ lineHeight: 1.6, margin: '4px 0' }}>
      {tokens.map((t, idx) => {
        if (t.type === 'same') return <span key={idx}>{t.text}</span>;
        if (t.type === 'added')
          return (
            <span key={idx} style={{ background: '#d4f7d4' }}>
              <span aria-hidden="true">+</span>
              {t.text}
            </span>
          );
        return (
          <span key={idx} style={{ background: '#f7d4d4', textDecoration: 'line-through' }}>
            <span aria-hidden="true">−</span>
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

  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (theirs) {
      headingRef.current?.focus();
    }
  }, [theirs]);

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
      role="dialog"
      aria-labelledby="conflict-panel-heading"
      style={{
        background: 'var(--warning-bg)',
        border: '2px solid var(--warning-border)',
        borderRadius: 8,
        padding: 20,
        marginBottom: 20,
      }}
    >
      <h3 id="conflict-panel-heading" ref={headingRef} tabIndex={-1} style={{ marginTop: 0 }}>
        Save conflict — revision {theirs.revision} was saved by {theirs.authorId} while you
        were editing
      </h3>
      <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
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
              padding: 12,
              background: '#fff',
              border: bothChangedSameSection ? '1px solid #c66' : '1px solid var(--border-subtle)',
              borderRadius: 6,
            }}
          >
            <strong>
              {key}
              {bothChangedSameSection && (
                <span style={{ color: 'var(--danger-text)', fontSize: 12 }}>
                  {' '}
                  — both edited this section
                </span>
              )}
            </strong>

            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
              Your changes (vs. common ancestor):
            </div>
            <DiffLine oldText={ancestorText} newText={mineText} />

            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
              Their changes (vs. common ancestor):
            </div>
            <DiffLine oldText={ancestorText} newText={theirsText} />

            <div style={{ marginTop: 8 }}>
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

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={() => onResolve(resolvedSections, theirs.id)}
          style={{
            background: 'var(--navy-900)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '8px 16px',
            fontWeight: 600,
          }}
        >
          Save merged version
        </button>
        <button
          onClick={onCancel}
          style={{
            background: '#fff',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 6,
            padding: '8px 16px',
          }}
        >
          Cancel (discard my unsaved changes)
        </button>
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
  const { viewers, lastRemoteChange, remoteVersionAdded } = useNoteRealtime(note.id);
  const [announcement, setAnnouncement] = useState('');
  const canEdit = canEditNoteContent(currentUser.role);

  const initialSnapshot = noteMachine.resolveState({
    value: note.status as NoteStatus,
    context: {
      assignedReviewerId: note.assignedReviewer?.id ?? null,
      approvedAt: note.status === 'APPROVED' ? Date.now() : null,
    },
  });

  const [state, send] = useMachine(noteMachine, { snapshot: initialSnapshot });

  useEffect(() => {
    track('note_viewed', { noteId: note.id, status: note.status, role: currentUser.role });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  useEffect(() => {
    if (isOnline) {
      replayQueuedWrites(queryClient).then(() => {
        getQueuedWritesForNote(note.id).then((writes) => setPendingCount(writes.length));
      });
    } else {
      getQueuedWritesForNote(note.id).then((writes) => setPendingCount(writes.length));
    }
  }, [note.id, isOnline, queryClient]);

  // --- Local optimistic ReviewEvent, reconciled with the server on ack ---
  // Per spec: "Emit a local ReviewEvent immediately on optimistic
  // transition; reconcile with the server-assigned eventId on ack." We
  // keep a small list of events not yet confirmed by the server; they
  // render in the review history immediately, then get replaced once the
  // real refetch brings back the server's actual event (with its real id).
  const [optimisticEvents, setOptimisticEvents] = useState<ReviewEvent[]>([]);

  // --- Machine-mediated real-time transitions (satisfies "server-pushed
  // transitions must run through the same machine") ---
  const [remoteBanner, setRemoteBanner] = useState<string | null>(null);

  useEffect(() => {
    console.log('[debug] lastRemoteChange fired:', lastRemoteChange); // TEMP DEBUG
    if (!lastRemoteChange) return;
    try {
      const machineEvent = reconstructEventForTransition(
        lastRemoteChange.fromStatus,
        lastRemoteChange.toStatus,
        lastRemoteChange.actorId
      );
      console.log('[debug] reconstructed machineEvent:', machineEvent); // TEMP DEBUG
      if (machineEvent && state.can(machineEvent)) {
        send(machineEvent);
        console.log('[debug] sent machineEvent to state machine'); // TEMP DEBUG
      } else {
        console.log('[debug] machineEvent was null or state.can() returned false'); // TEMP DEBUG
      }
      setAnnouncement(
        `Note status changed to ${lastRemoteChange.toStatus} by ${lastRemoteChange.actorId}`
      );
      setRemoteBanner(
        `${lastRemoteChange.actorId} changed this note's status to ${lastRemoteChange.toStatus}`
      );
      console.log('[debug] setRemoteBanner called'); // TEMP DEBUG
    } catch (err) {
      console.error('[debug] ERROR in real-time transition effect:', err); // TEMP DEBUG
    }
    const timer = setTimeout(() => setRemoteBanner(null), 6000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastRemoteChange]);

  // --- Proactive conflict detection from version_added pushes ---
  // Per spec: "If the server-pushed version supersedes an in-flight
  // optimistic edit, the resolution UI is the same three-way merge." We
  // don't wait for our OWN save to fail with a 409 — if we have unsaved
  // local edits when someone else's version_added arrives, we surface
  // the conflict panel proactively.
  useEffect(() => {
    if (!remoteVersionAdded) return;
    if (remoteVersionAdded.versionId === baseVersionIdRefCurrentForEffect()) return; // our own save's echo
    if (dirtySectionsRefCurrentForEffect().size === 0) return; // no local edits to protect

    setConflict({
      error: 'version_conflict',
      current: {
        id: remoteVersionAdded.versionId,
        revision: remoteVersionAdded.revision,
        authoredBy: { id: 'unknown', role: 'CLINICIAN' },
      },
      commonAncestor: {
        id: baseVersionIdRefCurrentForEffect(),
        revision: note.currentVersion.revision,
      },
    });
    track('proactive_conflict_detected', { noteId: note.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteVersionAdded]);

  // Small helper functions so the effect above can read the LATEST ref
  // values without needing them in its dependency array (they're refs,
  // not state, so they don't trigger re-renders on their own anyway).
  function baseVersionIdRefCurrentForEffect() {
    return baseVersionIdRef.current;
  }
  function dirtySectionsRefCurrentForEffect() {
    return dirtySections;
  }

  const transitionMutation = useMutation({
    mutationFn: postTransition,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ['note', note.id] });
      const previousNote = queryClient.getQueryData<NoteDetail>(['note', note.id]);
      const optimisticToStatus = EVENT_TO_STATUS[variables.event.type];
      const actorId = 'actor' in variables.event ? variables.event.actor.id : currentUser.id;
      const actorRole = 'actor' in variables.event ? variables.event.actor.role : currentUser.role;
      const reason = 'reason' in variables.event ? variables.event.reason : undefined;

      queryClient.setQueryData<NoteDetail>(['note', note.id], (old) => {
        if (!old) return old;
        return {
          ...old,
          status: optimisticToStatus,
          assignedReviewer:
            optimisticToStatus === 'IN_REVIEW'
              ? { id: actorId, displayName: actorId, role: 'REVIEWER' }
              : optimisticToStatus === 'READY_FOR_REVIEW'
                ? null
                : old.assignedReviewer,
        };
      });

      // Emit the local optimistic ReviewEvent immediately.
      const tempEvent: ReviewEvent = {
        id: `optimistic_${Date.now()}`,
        noteId: note.id,
        versionId: note.currentVersion.id,
        fromStatus: note.status as NoteStatus,
        toStatus: optimisticToStatus as NoteStatus,
        actorId,
        actorRole,
        reason,
        occurredAt: new Date().toISOString(),
      };
      setOptimisticEvents((prev) => [...prev, tempEvent]);

      return { previousNote, tempEventId: tempEvent.id };
    },
    onSuccess: (_result, variables, context) => {
      setAnnouncement(`Note transitioned to ${EVENT_TO_STATUS[variables.event.type]}`);
      // Reconcile: the real refetch (triggered in onSettled) will bring
      // back the server's actual event with its real id — drop our
      // temporary placeholder now that the real one is on its way in.
      setOptimisticEvents((prev) => prev.filter((e) => e.id !== context?.tempEventId));
    },
    onError: (err, _variables, context) => {
      if (context?.previousNote) {
        queryClient.setQueryData(['note', note.id], context.previousNote);
      }
      setOptimisticEvents((prev) => prev.filter((e) => e.id !== context?.tempEventId));
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

      if (navigator.onLine) {
        try {
          const result = await saveVersion(variables);
          baseVersionIdRef.current = result.version.id;
          setDirtySections(new Set());
          queryClient.invalidateQueries({ queryKey: ['note', note.id] });
          return;
        } catch {
          // Retry also failed — fall through and queue it below.
        }
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

  const pendingSaveContentRef = useRef<SoapSections | null>(null);

  function flushPendingSaveIfAny() {
    if (pendingSaveContentRef.current) {
      const content = pendingSaveContentRef.current;
      pendingSaveContentRef.current = null;
      saveMutation.mutate({
        noteId: note.id,
        baseVersionId: baseVersionIdRef.current,
        content: { sections: content },
        clientMutationId: `${note.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      });
    }
  }

  const debouncedSave = useDebouncedCallback((newSections: SoapSections) => {
    if (conflict) return;

    if (saveMutation.isPending) {
      pendingSaveContentRef.current = newSections;
      return;
    }

    const payload = {
      noteId: note.id,
      baseVersionId: baseVersionIdRef.current,
      content: { sections: newSections },
      clientMutationId: `${note.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };

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

  const [compareVersionIds, setCompareVersionIds] = useState<string[]>([]);

  function toggleCompareVersion(versionId: string) {
    setCompareVersionIds((prev) => {
      if (prev.includes(versionId)) return prev.filter((id) => id !== versionId);
      if (prev.length >= 2) return prev;
      return [...prev, versionId];
    });
  }

  const sortedCompareIds = [...compareVersionIds].sort((a, b) => {
    const va = note.versions.find((v) => v.id === a)?.revision ?? 0;
    const vb = note.versions.find((v) => v.id === b)?.revision ?? 0;
    return va - vb;
  });

  const { data: compareA, isLoading: isLoadingCompareA } = useQuery({
    queryKey: ['version', sortedCompareIds[0]],
    queryFn: () => fetchVersion(sortedCompareIds[0]),
    enabled: !!sortedCompareIds[0],
  });

  const { data: compareB, isLoading: isLoadingCompareB } = useQuery({
    queryKey: ['version', sortedCompareIds[1]],
    queryFn: () => fetchVersion(sortedCompareIds[1]!),
    enabled: !!sortedCompareIds[1],
  });

  const actor = { id: currentUser.id, role: currentUser.role };

  const actions: Array<{
    label: string;
    event: NoteMachineEvent;
    reasonIfDisabled: string;
    primary?: boolean;
  }> = [
    {
      label: 'Start review',
      event: { type: 'start_review', actor },
      reasonIfDisabled:
        currentUser.role !== 'REVIEWER'
          ? `Only reviewers can start a review (you are ${currentUser.role})`
          : 'Not available in the current state',
      primary: true,
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
      primary: true,
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
      label: 'Start amendment',
      event: { type: 'amend', actor, now: Date.now() },
      reasonIfDisabled:
        note.status === 'LOCKED'
          ? 'Grace period has expired; this note is locked'
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
  const isLocked = note.status === 'LOCKED';

  // Merge server-confirmed events with any still-pending optimistic ones
  // for display, newest last (matches the existing review history order).
  const displayedEvents = [...note.review.events, ...optimisticEvents];

  return (
    <div style={{ padding: 24, display: 'flex', gap: 28, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div role="status" aria-live="polite" style={visuallyHiddenStyle}>
          {announcement}
        </div>

        <Link to="/" style={{ fontSize: 13 }}>&larr; Back to notes</Link>
        <h1 style={{ fontSize: 30, marginTop: 8 }}>{note.patient.displayName}</h1>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <StatusBadge status={note.status} />
          {note.assignedReviewer && (
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              assigned to {note.assignedReviewer.displayName}
            </span>
          )}
        </div>

        {remoteBanner && (
          <p
            style={{
              background: 'var(--lavender-50)',
              color: 'var(--navy-700)',
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            🔄 {remoteBanner}
          </p>
        )}

        {viewers.length > 1 && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            👀 Also viewing: {viewers.filter((v) => v.id).map((v) => v.id).join(', ')}
          </p>
        )}

        {pendingCount > 0 && (
          <p
            style={{
              background: 'var(--lavender-50)',
              color: 'var(--navy-700)',
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {pendingCount} change{pendingCount > 1 ? 's' : ''} waiting to sync
            {!isOnline && ' (offline)'}.
          </p>
        )}
        {noteHasUnresolvedConflict && (
          <p
            style={{
              background: 'var(--danger-bg)',
              color: 'var(--danger-text)',
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            A queued change to this note conflicted with a newer version. Edit the section below
            to trigger conflict resolution.
          </p>
        )}
        {isLocked && (
          <p
            style={{
              background: '#f0f0f0',
              color: '#555',
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            🔒 This note is locked and read-only. The 24-hour amendment grace period has
            expired.
          </p>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '16px 0' }}>
          {actions.map(({ label, event, reasonIfDisabled, primary }) => {
            const enabled = state.can(event);
            const reasonId = `reason-${label.replace(/\s+/g, '-').toLowerCase()}`;
            return (
              <div key={label}>
                <button
                  disabled={!enabled || transitionMutation.isPending}
                  aria-describedby={!enabled ? reasonId : undefined}
                  onClick={() => {
                    send(event);
                    transitionMutation.mutate({
                      noteId: note.id,
                      event,
                    });
                    track('note_transition_attempted', {
                      noteId: note.id,
                      eventType: event.type,
                      fromStatus: note.status,
                      toStatus: EVENT_TO_STATUS[event.type],
                    });
                  }}
                  style={{
                    padding: '9px 18px',
                    borderRadius: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    border: enabled
                      ? primary
                        ? 'none'
                        : '1px solid var(--navy-900)'
                      : '1px solid var(--border-subtle)',
                    background: enabled ? (primary ? 'var(--amber-500)' : '#fff') : '#f5f5f5',
                    color: enabled ? 'var(--navy-900)' : '#aaa',
                    cursor: enabled ? 'pointer' : 'not-allowed',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {label}
                </button>
                {!enabled && (
                  <div
                    id={reasonId}
                    style={{ fontSize: 11, color: 'var(--danger-text)', maxWidth: 150, marginTop: 4 }}
                  >
                    {reasonIfDisabled}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {transitionMutation.isPending && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Saving...</p>
        )}

        <div style={{ marginBottom: 20 }}>
          <label htmlFor="reject-reason-input" style={{ fontSize: 13 }}>
            Reject reason:{' '}
            <input
              id="reject-reason-input"
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="required to reject"
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-subtle)',
                fontFamily: 'Poppins, sans-serif',
                fontSize: 13,
                width: 260,
              }}
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

        <h2 style={{ fontSize: 22 }}>Current version (revision {note.currentVersion.revision})</h2>
        {!canEdit && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            You have read-only access to this note (role: {currentUser.role}).
          </p>
        )}
        {SECTION_KEYS.map((key) => (
          <div key={key} style={{ marginBottom: 16 }}>
            <label htmlFor={`section-${key}`} style={{ display: 'block', marginBottom: 4 }}>
              <span
                style={{
                  fontFamily: "'Cormorant Garamond', serif",
                  fontWeight: 600,
                  fontSize: 16,
                  color: 'var(--navy-900)',
                }}
              >
                {key}
              </span>
              {dirtySections.has(key) && (
                <span style={{ color: 'var(--amber-700)', fontSize: 12, marginLeft: 6 }}>
                  ● unsaved
                </span>
              )}
            </label>
            <textarea
              id={`section-${key}`}
              value={sections[key]}
              onChange={(e) => handleSectionChange(key, e.target.value)}
              rows={2}
              disabled={!!conflict || isLocked || !canEdit}
              style={{
                width: '100%',
                maxWidth: 640,
                display: 'block',
                padding: '10px 12px',
                borderRadius: 6,
                border: dirtySections.has(key)
                  ? '1px solid var(--amber-700)'
                  : '1px solid var(--border-subtle)',
                fontFamily: "'Poppins', sans-serif",
                fontSize: 14,
                resize: 'vertical',
                outline: 'none',
                background: conflict || isLocked || !canEdit ? '#f5f5f5' : '#fff',
              }}
            />
          </div>
        ))}
        {saveMutation.isPending && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Saving version...</p>}

        <h3 style={{ fontSize: 18 }}>Review history</h3>
        <ul style={{ listStyle: 'none', padding: 0, fontSize: 13 }}>
          {displayedEvents.map((event) => (
            <li
              key={event.id}
              style={{
                padding: '8px 0',
                borderBottom: '1px solid var(--border-subtle)',
                color: event.id.startsWith('optimistic_') ? 'var(--amber-700)' : 'var(--text-muted)',
              }}
            >
              <span style={{ color: 'var(--navy-900)', fontWeight: 500 }}>
                {event.fromStatus ?? '(created)'} → {event.toStatus}
              </span>{' '}
              by {event.actorId} at {new Date(event.occurredAt).toLocaleString()}
              {event.reason && ` — "${event.reason}"`}
              {event.id.startsWith('optimistic_') && (
                <span style={{ fontSize: 11 }}> (saving...)</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid var(--border-subtle)', paddingLeft: 24 }}>
        <h3 style={{ fontSize: 18 }}>Version history</h3>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -8 }}>
          Check one version to diff against your current edits, or check two to diff them
          directly against each other.
        </p>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {note.versions
            .slice()
            .sort((a, b) => b.revision - a.revision)
            .map((v) => {
              const checked = compareVersionIds.includes(v.id);
              return (
                <li key={v.id} style={{ marginBottom: 6 }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      background: checked ? 'var(--lavender-50)' : 'transparent',
                      border: checked ? '1px solid var(--navy-700)' : '1px solid var(--border-subtle)',
                      borderRadius: 6,
                      padding: '8px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCompareVersion(v.id)}
                      disabled={!checked && compareVersionIds.length >= 2}
                    />
                    <span>
                      Revision {v.revision}
                      {v.id === note.currentVersion.id && ' (current)'}
                      <br />
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        by {v.authoredBy.id} ({v.authoredBy.role})
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
        </ul>

        {compareVersionIds.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h4 style={{ fontSize: 15 }}>
              {compareVersionIds.length === 2
                ? `Diff: revision ${compareA?.revision ?? '...'} → revision ${compareB?.revision ?? '...'}`
                : `Diff: revision ${compareA?.revision ?? '...'} → your current edits`}
            </h4>
            {isLoadingCompareA || (compareVersionIds.length === 2 && isLoadingCompareB) ? (
              <p>Loading version...</p>
            ) : (
              <div style={{ fontSize: 13 }}>
                {SECTION_KEYS.map((key) => (
                  <div key={key} style={{ marginBottom: 10 }}>
                    <strong>{key}</strong>
                    <DiffLine
                      oldText={compareA?.content.sections[key] ?? ''}
                      newText={
                        compareVersionIds.length === 2
                          ? compareB?.content.sections[key] ?? ''
                          : sections[key]
                      }
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