import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { Thread } from "../../protocol-client/index.js";
import { projectNativeThread } from "./thread-view-state.js";
import { mergeThreadHistoryPages } from "./thread-history-pages.js";

export interface ThreadHistoryController {
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadOlder(): Promise<boolean>;
  ensureItem(itemId: string): Promise<boolean>;
  ensureTurn(turnId: string): Promise<boolean>;
  loadAll(signal?: AbortSignal): Promise<void>;
}
export const ThreadHistoryContext =
  createContext<ThreadHistoryController | null>(null);

/** One disposable viewport cache. New recovery boundaries revoke outstanding reads. */
export function useThreadHistoryPages(thread: Thread | null) {
  const identity = JSON.stringify([
    thread?.id,
    thread?.recoveryEpoch,
    thread?.history?.before,
  ]);
  const [state, setState] = useState<{
    identity: string;
    pages: Thread[];
    loading: boolean;
    error: string | null;
  }>({ identity, pages: [], loading: false, error: null });
  const currentState =
    state.identity === identity
      ? state
      : { identity, pages: [], loading: false, error: null };
  const latest = useRef({ identity, thread, pages: currentState.pages });
  latest.current = { identity, thread, pages: currentState.pages };
  const inFlight = useRef<{
    identity: string;
    promise: Promise<boolean>;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const merged = useMemo(
    () =>
      thread === null
        ? null
        : mergeThreadHistoryPages(thread, currentState.pages),
    [thread, currentState.pages],
  );
  const loadOlder = useCallback((): Promise<boolean> => {
    if (!mounted.current) return Promise.resolve(false);
    const owner = latest.current;
    if (inFlight.current?.identity === owner.identity)
      return inFlight.current.promise;
    const before =
      owner.pages.at(-1)?.history?.before ??
      (owner.pages.length ? null : owner.thread?.history?.before);
    if (!owner.thread || !before) return Promise.resolve(false);
    setState({
      identity: owner.identity,
      pages: owner.pages,
      loading: true,
      error: null,
    });
    const promise = window.zenx.protocol
      .request("zen/thread/history", { threadId: owner.thread.id, before })
      .then(({ thread: snapshot }) => {
        if (!mounted.current || latest.current.identity !== owner.identity)
          return false;
        if (
          snapshot.id !== owner.thread!.id ||
          snapshot.history === undefined ||
          snapshot.history.before === before
        )
          throw new Error("History page did not advance its Thread cursor");
        const pages = [...latest.current.pages, projectNativeThread(snapshot)];
        latest.current = { ...latest.current, pages };
        // A source action can materialize its target immediately after awaiting this read.
        flushSync(() =>
          setState({
            identity: owner.identity,
            pages,
            loading: false,
            error: null,
          }),
        );
        return true;
      })
      .catch((cause: unknown) => {
        if (mounted.current && latest.current.identity === owner.identity)
          setState({
            identity: owner.identity,
            pages: latest.current.pages,
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        throw cause;
      })
      .finally(() => {
        if (inFlight.current?.promise === promise) inFlight.current = null;
      });
    inFlight.current = { identity: owner.identity, promise };
    return promise;
  }, []);
  const ensureItem = useCallback(
    async (itemId: string) => {
      const identity = latest.current.identity;
      while (mounted.current && latest.current.identity === identity) {
        const { thread, pages } = latest.current;
        const includesRow = (view: Thread | null) => {
          const item = view?.canonicalItems?.find((item) => item.id === itemId);
          return (
            item !== undefined &&
            (item.turnId === undefined ||
              view!.turns.some((turn) => turn.id === item.turnId))
          );
        };
        if (includesRow(thread) || pages.some(includesRow)) return true;
        if (!(await loadOlder())) return false;
      }
      return false;
    },
    [loadOlder],
  );
  const ensureTurn = useCallback(
    async (turnId: string) => {
      const identity = latest.current.identity;
      while (mounted.current && latest.current.identity === identity) {
        const { thread, pages } = latest.current;
        if (
          thread?.turns.some((turn) => turn.id === turnId) ||
          pages.some((page) => page.turns.some((turn) => turn.id === turnId))
        )
          return true;
        if (!(await loadOlder())) return false;
      }
      return false;
    },
    [loadOlder],
  );
  const loadAll = useCallback(
    async (signal?: AbortSignal) => {
      const identity = latest.current.identity;
      while (
        mounted.current &&
        !signal?.aborted &&
        latest.current.identity === identity &&
        (await loadOlder())
      ) {
        /* Explicit Find only. */
      }
    },
    [loadOlder],
  );
  const before = currentState.pages.length
    ? currentState.pages.at(-1)?.history?.before
    : thread?.history?.before;
  const controller = useMemo<ThreadHistoryController>(
    () => ({
      hasMore: !!before,
      loading: currentState.loading,
      error: currentState.error,
      loadOlder,
      ensureItem,
      ensureTurn,
      loadAll,
    }),
    [
      before,
      currentState.loading,
      currentState.error,
      loadOlder,
      ensureItem,
      ensureTurn,
      loadAll,
    ],
  );
  return { thread: merged, controller };
}
