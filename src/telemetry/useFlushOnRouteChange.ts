import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Flushes the telemetry queue whenever the route changes, per spec:
 * "Flush on a size threshold, a time threshold, and session boundaries
 * (route change, tab hidden)." We treat a route change as enough of a
 * session boundary to flush proactively rather than waiting for the next
 * timed tick, so events from a page the user just left aren't sitting
 * around indefinitely if they close the tab shortly after navigating.
 */
export function useFlushOnRouteChange() {
  const location = useLocation();
  const previousPath = useRef(location.pathname);

  useEffect(() => {
    if (previousPath.current !== location.pathname) {
      // Import lazily to avoid a circular import concern between this
      // hook and track.ts at module-load time; dynamic import here is
      // cheap since this only runs on actual route changes, not per-render.
      import('./track').then(({ flushTelemetryQueue }) => {
        flushTelemetryQueue();
      });
      previousPath.current = location.pathname;
    }
  }, [location.pathname]);
}