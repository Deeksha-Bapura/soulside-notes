import { setup, assign, and, type StateFrom } from 'xstate';
import type { Role } from './types';

/**
 * The note lifecycle, modelled as a single source of truth.
 *
 * Design notes:
 * - This machine is deliberately STATELESS-FRIENDLY: for the notes list view
 *   (100k+ rows) we never spawn 100k running actors. Instead we use XState's
 *   pure transition function to ask "would this transition be legal?"
 *   without any actor overhead. A running actor is only spawned for the
 *   single note currently open in the detail view.
 * - Guards encode role/ownership/MFA checks from the assignment's transition
 *   table. They are pure functions of (context, event) — no I/O, no fetch.
 * - This machine does NOT distinguish "user clicked approve" from "server
 *   pushed an approved event via websocket". Both are the `approve` event.
 *   That's intentional: server-driven transitions must run through the
 *   same machine as user-initiated ones.
 */

export interface NoteMachineContext {
  assignedReviewerId: string | null;
  /** epoch ms when the note entered APPROVED; used for the 24h grace guard */
  approvedAt: number | null;
}

type Actor = { id: string; role: Role };

export type NoteMachineEvent =
  | { type: 'generation.complete' }
  | { type: 'generation.error' }
  | { type: 'regenerate'; actor: Actor }
  | { type: 'start_review'; actor: Actor }
  | { type: 'return'; actor: Actor }
  | { type: 'approve'; actor: Actor; mfaVerified: boolean }
  | { type: 'reject'; actor: Actor; reason: string }
  | { type: 'resubmit'; actor: Actor }
  | { type: 'amend'; actor: Actor; now?: number }
  | { type: 'grace_expired' };

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export const noteMachine = setup({
  types: {
    context: {} as NoteMachineContext,
    events: {} as NoteMachineEvent,
  },
  guards: {
    isClinicianOrAdmin: ({ event }) => {
      if (event.type !== 'regenerate') return false;
      return event.actor.role === 'CLINICIAN' || event.actor.role === 'ADMIN';
    },
    isReviewer: ({ event }) => {
      if (event.type !== 'start_review') return false;
      return event.actor.role === 'REVIEWER';
    },
    isAssignedReviewer: ({ context, event }) => {
      if (event.type !== 'return' && event.type !== 'approve' && event.type !== 'reject') {
        return false;
      }
      return context.assignedReviewerId === event.actor.id;
    },
    isClinician: ({ event }) => {
      if (event.type !== 'resubmit') return false;
      return event.actor.role === 'CLINICIAN';
    },
    hasMfa: ({ event }) => event.type === 'approve' && event.mfaVerified === true,
    hasReason: ({ event }) => event.type === 'reject' && event.reason.trim().length > 0,
    withinGraceWindow: ({ context, event }) => {
      if (event.type !== 'amend') return false;
      const now = event.now ?? Date.now();
      return context.approvedAt !== null && now - context.approvedAt < GRACE_PERIOD_MS;
    },
  },
  actions: {
    assignReviewer: assign({
      assignedReviewerId: ({ event }) =>
        event.type === 'start_review' ? event.actor.id : null,
    }),
    releaseReviewer: assign({ assignedReviewerId: () => null }),
    stampApprovedAt: assign({ approvedAt: () => Date.now() }),
  },
}).createMachine({
  id: 'note',
  context: { assignedReviewerId: null, approvedAt: null },
  initial: 'GENERATING',
  states: {
    GENERATING: {
      on: {
        'generation.complete': 'READY_FOR_REVIEW',
        'generation.error': 'FAILED',
      },
    },
    FAILED: {
      on: {
        regenerate: { target: 'GENERATING', guard: 'isClinicianOrAdmin' },
      },
    },
    READY_FOR_REVIEW: {
      entry: 'releaseReviewer',
      on: {
        start_review: {
          target: 'IN_REVIEW',
          guard: 'isReviewer',
          actions: 'assignReviewer',
        },
      },
    },
    IN_REVIEW: {
      on: {
        return: { target: 'READY_FOR_REVIEW', guard: 'isAssignedReviewer' },
        approve: {
          target: 'APPROVED',
          guard: and(['isAssignedReviewer', 'hasMfa']),
        },
        reject: {
          target: 'REJECTED',
          guard: and(['isAssignedReviewer', 'hasReason']),
        },
      },
    },
    APPROVED: {
      entry: 'stampApprovedAt',
      on: {
        amend: { target: 'AMENDED', guard: 'withinGraceWindow' },
        grace_expired: 'LOCKED',
      },
    },
    REJECTED: {
      on: {
        resubmit: { target: 'READY_FOR_REVIEW', guard: 'isClinician' },
      },
    },
    AMENDED: {
      on: {
        start_review: {
          target: 'IN_REVIEW',
          guard: 'isReviewer',
          actions: 'assignReviewer',
        },
      },
    },
    LOCKED: {
      type: 'final',
    },
  },
});

export type NoteMachineState = StateFrom<typeof noteMachine>;