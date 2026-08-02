import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Role } from '../domain/types';

export interface CurrentUser {
  id: string;
  displayName: string;
  role: Role;
}

// A small fixed roster of fake users, standing in for real auth. Switching
// between them is how we manually test role/ownership guards without a
// real login system — e.g. "does the Approve button correctly disable
// itself when I'm dr_b looking at a note assigned to dr_a?"
export const FAKE_USERS: CurrentUser[] = [
  { id: 'dr_a', displayName: 'Dr. A (Reviewer)', role: 'REVIEWER' },
  { id: 'dr_b', displayName: 'Dr. B (Reviewer)', role: 'REVIEWER' },
  { id: 'usr_clinician_1', displayName: 'Clinician One', role: 'CLINICIAN' },
  { id: 'usr_admin_1', displayName: 'Admin One', role: 'ADMIN' },
  { id: 'usr_auditor_1', displayName: 'Auditor (read-only)', role: 'READONLY_AUDITOR' },
];

interface CurrentUserContextValue {
  currentUser: CurrentUser;
  setCurrentUserId: (id: string) => void;
}

const CurrentUserContext = createContext<CurrentUserContextValue | null>(null);

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState(FAKE_USERS[0].id);
  const currentUser = FAKE_USERS.find((u) => u.id === userId) ?? FAKE_USERS[0];

  return (
    <CurrentUserContext.Provider value={{ currentUser, setCurrentUserId: setUserId }}>
      {children}
    </CurrentUserContext.Provider>
  );
}

export function useCurrentUser() {
  const ctx = useContext(CurrentUserContext);
  if (!ctx) throw new Error('useCurrentUser must be used within CurrentUserProvider');
  return ctx;
}