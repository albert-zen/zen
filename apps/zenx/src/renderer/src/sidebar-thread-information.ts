import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";

/** Disposable facts read from the admitted Trigger plugin, never a scheduler. */
export interface SidebarTrigger {
  id: string;
  threadId: string;
  kind: string;
  active: boolean;
  nextRunAt?: number;
  sourceError?: string;
}
export interface SidebarTriggerState {
  triggers: readonly SidebarTrigger[];
  status: "unavailable" | "loading" | "ready" | "error";
}
export function sidebarTriggerFacts(value: unknown): SidebarTrigger[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("triggers" in value) ||
    !Array.isArray(value.triggers)
  )
    throw new Error("Automation facts are unavailable");
  return value.triggers.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new Error("Invalid automation facts");
    const t = entry as Record<string, unknown>;
    if (
      typeof t.id !== "string" ||
      typeof t.threadId !== "string" ||
      typeof t.kind !== "string" ||
      typeof t.active !== "boolean"
    )
      throw new Error("Invalid automation identity");
    const timer = t.timer as { nextRunAt?: unknown } | undefined;
    return {
      id: t.id,
      threadId: t.threadId,
      kind: t.kind,
      active: t.active,
      ...(typeof timer?.nextRunAt === "number"
        ? { nextRunAt: timer.nextRunAt }
        : {}),
      ...(typeof t.sourceError === "string"
        ? { sourceError: t.sourceError }
        : {}),
    };
  });
}
export function nextSidebarTrigger(
  triggers: readonly SidebarTrigger[],
  now: number,
) {
  const active = triggers.filter((t) => t.active);
  const timers = active.filter((t) => t.kind === "timer");
  const future = timers.filter(
    (t) =>
      !t.sourceError &&
      Number.isFinite(t.nextRunAt) &&
      Number.isFinite(new Date(t.nextRunAt!).getTime()) &&
      t.nextRunAt! > now,
  );
  const nextRunAt = future.length
    ? Math.min(...future.map((t) => t.nextRunAt!))
    : null;
  const incomplete =
    active.some(
      (t) =>
        !!t.sourceError ||
        !["timer", "thread", "roomMention", "signal"].includes(t.kind),
    ) || future.length !== timers.length;
  return {
    nextRunAt,
    incomplete,
    state:
      active.length === 0
        ? ("paused" as const)
        : nextRunAt !== null
          ? ("scheduled" as const)
          : incomplete
            ? ("unknown" as const)
            : ("event" as const),
  };
}

/** Only the current admitted command can supply these facts. Older plugins do
 * not silently fall back to the broad list of prompts and Room transcripts. */
export function sidebarTriggerAdmissionId(
  snapshot: ZenXPluginSnapshot | null,
): string | null {
  const plugin = snapshot?.plugins.find(
    (entry) => entry.id === "zenx-triggers",
  );
  return plugin?.enabled &&
    plugin.available &&
    plugin.admissionId &&
    snapshot?.commands.some(
      (command) =>
        command.pluginId === plugin.id && command.id === "sidebar-facts",
    )
    ? plugin.admissionId
    : null;
}

/** Existing event-driven refreshes share one read. Retired admissions/revisions
 * never publish receipts; their successor waits, then reads its own facts. */
export function useSidebarTriggers(
  admissionId: string | null,
  revision: string,
) {
  const [state, setState] = useState<
    SidebarTriggerState & { admissionId: string | null; revision: string }
  >({
    triggers: [],
    status: admissionId ? "loading" : "unavailable",
    admissionId,
    revision,
  });
  const inFlight = useRef<Promise<void> | null>(null);
  const refreshCurrent = useRef<((force?: boolean) => Promise<void>) | null>(
    null,
  );
  const refresh = useCallback(
    (force = false) => refreshCurrent.current?.(force) ?? Promise.resolve(),
    [],
  );
  useLayoutEffect(() => {
    let active = true;
    let lastLoadedAt = 0;
    let pending: Promise<void> | null = null;
    let trailing = false;
    setState((previous) => ({
      triggers: previous.admissionId === admissionId ? previous.triggers : [],
      status: admissionId ? "loading" : "unavailable",
      admissionId,
      revision,
    }));
    if (!admissionId) {
      refreshCurrent.current = null;
      return () => {
        active = false;
      };
    }
    const load = (force = false): Promise<void> => {
      if (!active) return Promise.resolve();
      if (pending) {
        // Repeated hover joins the read. A newer forced event needs one trailing
        // read; a replacement admission has its own retired-effect boundary.
        if (force) trailing = true;
        return pending;
      }
      if (!force && Date.now() - lastLoadedAt < 1_000) return Promise.resolve();
      const previous = inFlight.current;
      const operation = Promise.resolve()
        .then(async () => {
          if (previous) await previous;
          if (!active) return;
          do {
            trailing = false;
            try {
              const result = await window.zenx.plugins.executeCommand(
                "zenx-triggers",
                "sidebar-facts",
              );
              const triggers = sidebarTriggerFacts(result);
              if (active) {
                lastLoadedAt = Date.now();
                setState({ triggers, status: "ready", admissionId, revision });
              }
            } catch {
              if (active)
                setState((current) => ({ ...current, status: "error" }));
            }
          } while (active && trailing);
        })
        .finally(() => {
          if (inFlight.current === operation) inFlight.current = null;
          pending = null;
        });
      pending = operation;
      inFlight.current = operation;
      return operation;
    };
    refreshCurrent.current = load;
    void load();
    return () => {
      active = false;
      if (refreshCurrent.current === load) refreshCurrent.current = null;
    };
  }, [admissionId, revision]);
  useEffect(() => {
    const onFocus = () => {
      void refresh(true);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  return {
    state: !admissionId
      ? { triggers: [], status: "unavailable" as const }
      : state.admissionId !== admissionId
        ? { triggers: [], status: "loading" as const }
        : {
            triggers: state.triggers,
            status:
              state.revision === revision ? state.status : ("loading" as const),
          },
    refresh,
  };
}
