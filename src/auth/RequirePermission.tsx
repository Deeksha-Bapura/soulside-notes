import type { ReactNode } from 'react';
import { useCurrentUser } from './CurrentUserContext';
import type { Role } from '../domain/types';

interface RequirePermissionProps {
  check: (role: Role) => boolean;
  children: ReactNode;
  deniedMessage?: string;
}

/**
 * Route/section-level guard. Distinct from action-level guards (disabled
 * buttons with reasons) — this blocks access to an entire screen or
 * section, with messaging that's explicitly a PERMISSION denial, not a
 * "this data doesn't exist" state, per the spec's requirement that the
 * two must read differently to the user.
 */
export function RequirePermission({ check, children, deniedMessage }: RequirePermissionProps) {
  const { currentUser } = useCurrentUser();

  if (!check(currentUser.role)) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <h2 style={{ color: 'var(--danger-text)' }}>Access restricted</h2>
        <p style={{ color: 'var(--text-muted)' }}>
          {deniedMessage ?? `Your role (${currentUser.role}) does not have permission to view this.`}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}