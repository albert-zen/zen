import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppShotApi } from "../../app-shot.js";

// Only unsettled/failed release receipts survive a Composer. They grant no
// recording/capture authority, observe no keys and are never stored on disk.
type Release = {
  pending: Promise<boolean> | null;
  error?: string;
  onReleased: Set<() => void>;
};
type Admission = { token: string; released: boolean };
type Releases = {
  entries: Map<string, Release>;
  listeners: Set<(releasedToken?: string) => void>;
  revision: number;
};
const releasesByApi = new WeakMap<AppShotApi, Releases>();
function releasesFor(api: AppShotApi): Releases {
  let value = releasesByApi.get(api);
  if (!value) {
    value = { entries: new Map(), listeners: new Set(), revision: 0 };
    releasesByApi.set(api, value);
  }
  return value;
}
function changed(releases: Releases, releasedToken?: string) {
  releases.revision++;
  for (const listener of releases.listeners) listener(releasedToken);
}
function releaseRecording(
  api: AppShotApi,
  token: string,
  explicit = false,
  onReleased?: () => void,
): Promise<boolean> {
  const releases = releasesFor(api);
  const previous = releases.entries.get(token);
  if (onReleased) previous?.onReleased.add(onReleased);
  if (previous?.pending) return previous.pending;
  if (previous?.error && !explicit) return Promise.resolve(false);
  const entry: Release = {
    pending: null,
    onReleased: previous?.onReleased ?? new Set(),
  };
  if (onReleased) entry.onReleased.add(onReleased);
  releases.entries.set(token, entry);
  entry.pending = Promise.resolve()
    .then(() => api.endRecording(token))
    .then(
      () => {
        for (const notify of entry.onReleased) notify();
        if (releases.entries.get(token) === entry)
          releases.entries.delete(token);
        changed(releases, token);
        return true;
      },
      (error: unknown) => {
        entry.pending = null;
        entry.error = error instanceof Error ? error.message : String(error);
        changed(releases);
        return false;
      },
    );
  changed(releases);
  return entry.pending;
}

/** No global suppression: main admits recording only while no capture owner exists. */
export function useAppShotShortcutRecorder({
  api,
  token,
  disabled,
  onError,
}: {
  api: AppShotApi;
  token: string;
  disabled: boolean;
  onError(message: string): void;
}) {
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const permit = useRef<Admission | null>(null);
  const wanted = useRef(false);
  const live = useRef(true);
  const latest = useRef({ disabled, onError });
  latest.current = { disabled, onError };
  const releases = releasesFor(api);
  useSyncExternalStore(
    (listener) => {
      const updated = (releasedToken?: string) => {
        if (releasedToken && permit.current?.token === releasedToken) {
          permit.current = null;
          setStarting(false);
        }
        listener();
      };
      releases.listeners.add(updated);
      return () => {
        releases.listeners.delete(updated);
      };
    },
    () => releases.revision,
  );
  const failedRelease = [...releases.entries].find(([, value]) => value.error);
  const release = async (admission: Admission, explicit = false) => {
    if (admission.released) return;
    await releaseRecording(api, admission.token, explicit, () => {
      // This marker lives only as long as this in-flight begin/release. A late
      // admission response must not issue another release after confirmed cleanup.
      admission.released = true;
      if (permit.current === admission) permit.current = null;
    });
    if (
      live.current &&
      (permit.current === admission || permit.current === null)
    )
      setStarting(false);
  };
  const stop = () => {
    wanted.current = false;
    setRecording(false);
    if (permit.current) void release(permit.current, true);
  };
  const stopLatest = useRef(stop);
  stopLatest.current = stop;
  useEffect(() => {
    live.current = true;
    const blur = () => {
      if (wanted.current) stopLatest.current();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") blur();
    };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      live.current = false;
      wanted.current = false;
      // Preserve a rejected cleanup for a mounted/new Composer's explicit retry.
      // Reuse a pending request, and never retry an already failed release here.
      if (permit.current) void release(permit.current);
    };
  }, [api]);
  useEffect(() => {
    if (disabled && wanted.current) stopLatest.current();
  }, [disabled]);
  const start = async () => {
    if (latest.current.disabled || permit.current || releases.entries.size)
      return;
    const value = `${token}:${crypto.randomUUID()}`;
    const admission = { token: value, released: false };
    permit.current = admission;
    wanted.current = true;
    setStarting(true);
    try {
      await api.beginRecording(value);
      if (
        !live.current ||
        !wanted.current ||
        permit.current !== admission ||
        latest.current.disabled
      ) {
        await release(admission);
        return;
      }
      setStarting(false);
      setRecording(true);
    } catch (error) {
      if (permit.current === admission) {
        wanted.current = false;
        if (live.current) {
          setRecording(false);
          latest.current.onError(
            error instanceof Error ? error.message : String(error),
          );
        }
        await release(admission);
      }
    }
  };
  return {
    recording,
    pending:
      starting || [...releases.entries.values()].some((entry) => entry.pending),
    releaseFailed: Boolean(failedRelease),
    releaseError: failedRelease?.[1].error,
    retryRelease: () => {
      if (failedRelease)
        void release(
          permit.current?.token === failedRelease[0]
            ? permit.current
            : { token: failedRelease[0], released: false },
          true,
        );
    },
    start,
    stop,
  };
}
