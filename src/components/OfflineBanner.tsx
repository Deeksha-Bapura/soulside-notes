import { useOnlineStatus } from '../hooks/useOnlineStatus';

export function OfflineBanner() {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      style={{
        background: '#c00',
        color: '#fff',
        padding: '8px 20px',
        textAlign: 'center',
        fontSize: 14,
      }}
    >
      You're offline. Changes will be saved locally and synced when you're back online.
    </div>
  );
}