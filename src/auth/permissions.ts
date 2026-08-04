import type { Role } from '../domain/types';

/**
 * Centralized authorization rules — the single place that answers "can
 * this role do this category of thing." Route guards, component guards,
 * and action guards all read from here, rather than each layer
 * reimplementing its own role checks (which is exactly the kind of
 * drift that leads to a rogue button bypassing a rule enforced
 * everywhere else).
 */

export function canEditNoteContent(role: Role): boolean {
  return role !== 'READONLY_AUDITOR';
}

export function canPerformBulkActions(role: Role): boolean {
  return role === 'ADMIN' || role === 'REVIEWER' || role === 'CLINICIAN';
}

export function canAccessNoteDetail(role: Role): boolean {
  // Every role can VIEW a note (including the auditor, whose entire job
  // is read-only review) — this guard exists as a named seam for future
  // restriction, and to make the "route-level guard" layer real and
  // testable even though today every role passes it.
  return true;
}