import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { noteMachine } from './noteMachine';

// Helper: spin up a fresh machine instance for each test.
function start() {
  const actor = createActor(noteMachine);
  actor.start();
  return actor;
}

const reviewer = { id: 'usr_reviewer_1', role: 'REVIEWER' as const };
const otherReviewer = { id: 'usr_reviewer_2', role: 'REVIEWER' as const };
const clinician = { id: 'usr_clinician_1', role: 'CLINICIAN' as const };

describe('note lifecycle: happy path', () => {
  it('moves GENERATING -> READY_FOR_REVIEW -> IN_REVIEW -> APPROVED', () => {
    const actor = start();
    expect(actor.getSnapshot().value).toBe('GENERATING');

    actor.send({ type: 'generation.complete' });
    expect(actor.getSnapshot().value).toBe('READY_FOR_REVIEW');

    actor.send({ type: 'start_review', actor: reviewer });
    expect(actor.getSnapshot().value).toBe('IN_REVIEW');
    expect(actor.getSnapshot().context.assignedReviewerId).toBe(reviewer.id);

    actor.send({ type: 'approve', actor: reviewer, mfaVerified: true });
    expect(actor.getSnapshot().value).toBe('APPROVED');
  });
});

describe('note lifecycle: guards reject illegal transitions', () => {
  it('rejects start_review from a non-REVIEWER role', () => {
    const actor = start();
    actor.send({ type: 'generation.complete' });
    actor.send({ type: 'start_review', actor: clinician });
    // Should NOT have moved — clinician can't start a review.
    expect(actor.getSnapshot().value).toBe('READY_FOR_REVIEW');
  });

  it('rejects approve without MFA verification', () => {
    const actor = start();
    actor.send({ type: 'generation.complete' });
    actor.send({ type: 'start_review', actor: reviewer });
    actor.send({ type: 'approve', actor: reviewer, mfaVerified: false });
    expect(actor.getSnapshot().value).toBe('IN_REVIEW'); // unchanged
  });

  it('rejects approve from someone other than the assigned reviewer', () => {
    const actor = start();
    actor.send({ type: 'generation.complete' });
    actor.send({ type: 'start_review', actor: reviewer });
    actor.send({ type: 'approve', actor: otherReviewer, mfaVerified: true });
    expect(actor.getSnapshot().value).toBe('IN_REVIEW'); // unchanged
  });

  it('rejects reject without a reason', () => {
    const actor = start();
    actor.send({ type: 'generation.complete' });
    actor.send({ type: 'start_review', actor: reviewer });
    actor.send({ type: 'reject', actor: reviewer, reason: '' });
    expect(actor.getSnapshot().value).toBe('IN_REVIEW'); // unchanged
  });

  it('rejects resubmit from a non-CLINICIAN role', () => {
    const actor = start();
    actor.send({ type: 'generation.complete' });
    actor.send({ type: 'start_review', actor: reviewer });
    actor.send({ type: 'reject', actor: reviewer, reason: 'missing plan' });
    expect(actor.getSnapshot().value).toBe('REJECTED');

    actor.send({ type: 'resubmit', actor: reviewer }); // wrong role
    expect(actor.getSnapshot().value).toBe('REJECTED'); // unchanged
  });
});

describe('note lifecycle: amend grace window', () => {
  it('allows amend within 24h of approval', () => {
    const actor = start();
    actor.send({ type: 'generation.complete' });
    actor.send({ type: 'start_review', actor: reviewer });
    actor.send({ type: 'approve', actor: reviewer, mfaVerified: true });

    const approvedAt = actor.getSnapshot().context.approvedAt!;
    actor.send({
      type: 'amend',
      actor: clinician,
      now: approvedAt + 1000 * 60 * 60, // 1 hour later
    });
    expect(actor.getSnapshot().value).toBe('AMENDED');
  });

  it('rejects amend after the 24h grace window and allows grace_expired -> LOCKED', () => {
    const actor = start();
    actor.send({ type: 'generation.complete' });
    actor.send({ type: 'start_review', actor: reviewer });
    actor.send({ type: 'approve', actor: reviewer, mfaVerified: true });

    const approvedAt = actor.getSnapshot().context.approvedAt!;
    actor.send({
      type: 'amend',
      actor: clinician,
      now: approvedAt + 1000 * 60 * 60 * 25, // 25 hours later
    });
    expect(actor.getSnapshot().value).toBe('APPROVED'); // unchanged, guard rejected it

    actor.send({ type: 'grace_expired' });
    expect(actor.getSnapshot().value).toBe('LOCKED');
  });
});

describe('note lifecycle: failure and regeneration', () => {
  it('moves GENERATING -> FAILED -> GENERATING on regenerate by CLINICIAN', () => {
    const actor = start();
    actor.send({ type: 'generation.error' });
    expect(actor.getSnapshot().value).toBe('FAILED');

    actor.send({ type: 'regenerate', actor: clinician });
    expect(actor.getSnapshot().value).toBe('GENERATING');
  });

  it('rejects regenerate from a REVIEWER', () => {
    const actor = start();
    actor.send({ type: 'generation.error' });
    actor.send({ type: 'regenerate', actor: reviewer });
    expect(actor.getSnapshot().value).toBe('FAILED'); // unchanged
  });
});