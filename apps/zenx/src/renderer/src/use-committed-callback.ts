import { useCallback, useLayoutEffect, useRef } from "react";

/** Stable UI event identity; only committed renders may replace its target. */
export function useCommittedCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const committed = useRef<((...args: Args) => Result) | null>(callback);
  useLayoutEffect(() => {
    committed.current = callback;
  });
  useLayoutEffect(() => () => {
    committed.current = null;
  }, []);
  return useCallback((...args: Args) => {
    const current = committed.current;
    if (current === null) throw new Error("UI action is no longer available");
    return current(...args);
  }, []);
}
