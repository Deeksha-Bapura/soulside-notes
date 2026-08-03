import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { replayQueuedWrites } from './replay';

export function useReplayOnReconnect() {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Also try once on mount: if writes were queued in a PREVIOUS session
    // (e.g. the page was reloaded while offline), and we're actually
    // online now, don't wait for a fresh 'online' event that may never
    // fire again this session.
    if (navigator.onLine) {
      replayQueuedWrites(queryClient);
    }

    function handleOnline() {
      replayQueuedWrites(queryClient);
    }
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [queryClient]);
}