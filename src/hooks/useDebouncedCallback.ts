import { useRef, useCallback, useEffect } from 'react';

/**
 * Returns a debounced version of `callback`: calling the returned function
 * repeatedly resets a timer, so the real callback only fires once the
 * calls stop for `delayMs`. This is what coalesces many keystrokes into
 * one save request instead of one request per character typed.
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delayMs: number
) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback; // always call the latest version

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return useCallback(
    (...args: Args) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => callbackRef.current(...args), delayMs);
    },
    [delayMs]
  );
}