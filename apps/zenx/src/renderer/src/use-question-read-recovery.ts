import { useEffect, useRef } from "react";
import { useCommittedCallback } from "./use-committed-callback.js";

/** Mounted-view recovery only: two bounded list retries, never answer submission. */
export function useQuestionReadRecovery({
  owner,
  loading,
  error,
  disabled = false,
  refresh,
}: {
  owner: string;
  loading: boolean;
  error?: string;
  disabled?: boolean;
  refresh: () => Promise<void>;
}) {
  const attempts = useRef(0);
  const read = useCommittedCallback(() => {
    if (!disabled && !loading) void refresh();
  });
  useEffect(() => {
    attempts.current = 0;
  }, [owner]);
  useEffect(() => {
    if (disabled || loading) return;
    if (!error) {
      attempts.current = 0;
      return;
    }
    const delay = [1000, 3000][attempts.current];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      attempts.current++;
      read();
    }, delay);
    return () => clearTimeout(timer);
  }, [owner, disabled, loading, error, read]);
  useEffect(() => {
    if (disabled) return;
    const resume = () => {
      if (document.visibilityState !== "hidden") read();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
    };
  }, [owner, disabled, read]);
}
