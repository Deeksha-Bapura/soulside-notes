// Domain types for the clinical notes workflow.
// These mirror the payload shapes in the assignment's "Sample API Payloads"
// section. Keep this file free of React/UI concerns — it's the shared
// vocabulary every other layer (state machine, API client, components) imports.

export type Role = 'CLINICIAN' | 'REVIEWER' | 'ADMIN' | 'READONLY_AUDITOR';

export type NoteStatus =
  | 'GENERATING'
  | 'READY_FOR_REVIEW'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'AMENDED'
  | 'LOCKED'
  | 'FAILED';

export interface UserRef {
  id: string;
  displayName: string;
  role: Role;
}

export interface PatientRef {
  id: string;
  displayName: string;
}

export interface SoapContent {
  sections: {
    S: string; // Subjective
    O: string; // Objective
    A: string; // Assessment
    P: string; // Plan
  };
}

export interface NoteVersion {
  id: string;
  noteId: string;
  revision: number;
  parentVersionId: string | null;
  content: SoapContent;
  authorId: string;
  authorRole: Role;
  createdAt: string; // ISO timestamp
}

export interface Note {
  id: string;
  patient: PatientRef;
  sessionId: string;
  status: NoteStatus;
  currentVersionId: string;
  assignedReviewerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewEvent {
  id: string;
  noteId: string;
  versionId: string | null;
  fromStatus: NoteStatus | null;
  toStatus: NoteStatus;
  actorId: string;
  actorRole: Role;
  reason?: string;
  occurredAt: string;
}