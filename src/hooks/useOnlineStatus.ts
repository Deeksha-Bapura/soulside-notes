import { useState, useEffect } from 'react';

/**
 * Tracks browser connectivity via the native online/offline events.
 * Note: `navigator.onLine` is a heuristic (it reflects "connected to a
 * network," not "can actually reach our server") — good enough for a
 * dummy backend, but worth naming as a known limitation: a real production
 * app would pair this with actual failed-request detection, since you can
 * be "online" per the browser while the specific API you need is down.
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}