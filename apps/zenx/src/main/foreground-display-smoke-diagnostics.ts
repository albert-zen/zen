import type { Display, Screen } from "electron";

export type ForegroundDisplaySmokePhase =
  | "start"
  | "fixture-create"
  | "fixture-created"
  | "fixture-loaded"
  | "fixture-shown"
  | "fixture-focus-requested"
  | "fixture-focus-confirmed"
  | "display-stability-start"
  | "display-stability-confirmed"
  | "activity-requested"
  | "overlay-create"
  | "overlay-created"
  | "activity-admitted"
  | "stop-requested"
  | "stop-confirmed"
  | "cleanup-start"
  | "cleanup-finished"
  | "cdp-complete"
  | "os-input-start"
  | "verification-finished";

const events = [
  "display-added",
  "display-removed",
  "display-metrics-changed",
] as const;
const knownMetrics = new Set(["bounds", "workArea", "scaleFactor", "rotation"]);
const finite = (value: number) => (Number.isFinite(value) ? value : null);
const rectangle = (value: Display["bounds"]) => ({
  x: finite(value.x),
  y: finite(value.y),
  width: finite(value.width),
  height: finite(value.height),
});
const descriptor = (display: Display) => ({
  id: finite(display.id),
  bounds: rectangle(display.bounds),
  workArea: rectangle(display.workArea),
  scaleFactor: finite(display.scaleFactor),
  rotation: finite(display.rotation),
});

/** Passive, bounded diagnostics for owned smoke windows only, never admission. */
export function observeForegroundDisplaySmoke(
  screen: Pick<Screen, "getAllDisplays" | "on" | "removeListener">,
  now: () => number = () => performance.now(),
) {
  const started = now();
  let phase: ForegroundDisplaySmokePhase = "start";
  let closed = false;
  let droppedRecords = 0;
  let diagnosticErrors = 0;
  const records: Record<string, unknown>[] = [];
  const record = (fields: () => Record<string, unknown>) => {
    if (closed) return;
    try {
      const item = {
        phase,
        elapsedMs: Math.max(0, Math.round(now() - started)),
        ...fields(),
      };
      if (records.length === 32) {
        records.splice(16, 1); // Retain the first and most recent 16 records.
        droppedRecords += 1;
      }
      records.push(item);
    } catch {
      diagnosticErrors += 1;
    }
  };
  const listeners = events.map((event) => {
    const listener = (_event: unknown, display: Display, metrics?: string[]) =>
      record(() => ({
        kind: event,
        display: descriptor(display),
        changedMetrics:
          event === "display-metrics-changed"
            ? [
                ...new Set(metrics?.filter((name) => knownMetrics.has(name))),
              ].slice(0, 4)
            : [],
        unknownMetricsCount:
          event === "display-metrics-changed"
            ? (metrics?.filter((name) => !knownMetrics.has(name)).length ?? 0)
            : 0,
      }));
    if (event === "display-added") screen.on(event, listener);
    else if (event === "display-removed") screen.on(event, listener);
    else screen.on(event, listener);
    return { event, listener };
  });
  const mark = (next: ForegroundDisplaySmokePhase) => {
    phase = next;
    record(() => {
      const displays = screen.getAllDisplays();
      return {
        kind: "phase",
        displays: displays.slice(0, 4).map(descriptor),
        omittedDisplays: Math.max(0, displays.length - 4),
      };
    });
  };
  mark("start");
  return {
    mark,
    close() {
      if (!closed) {
        closed = true;
        for (const { event, listener } of listeners) {
          if (event === "display-added") screen.removeListener(event, listener);
          else if (event === "display-removed")
            screen.removeListener(event, listener);
          else screen.removeListener(event, listener);
        }
      }
      return { records, droppedRecords, diagnosticErrors };
    },
  };
}
