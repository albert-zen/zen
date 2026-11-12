import type { Display, Screen } from "electron";

export interface ForegroundSmokeClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

const clock: ForegroundSmokeClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

// A measured precondition, not a claim that macOS/Dock initialization is done.
// Twenty 25ms samples and all display events must remain quiet for 500ms.
// The caller supplies the EXISTING focus deadline; no new timeout is granted.
const quietMs = 500;
const sampleMs = 25;

/** Owned smoke setup only. Never retries activity or filters its display guard. */
export function waitForForegroundDisplayStability(
  screen: Pick<Screen, "getAllDisplays" | "on" | "removeListener">,
  options: { deadline: number; clock?: ForegroundSmokeClock },
): Promise<void> {
  const time = options.clock ?? clock;
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(options.deadline)) {
      reject(new Error("Invalid owned fixture setup deadline"));
      return;
    }
    let quietSince = time.now();
    let previous: string | undefined;
    let cancelTimer: (() => void) | undefined;
    let finished = false;
    const changed = () => {
      quietSince = time.now();
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cancelTimer?.();
      screen.removeListener("display-added", changed);
      screen.removeListener("display-removed", changed);
      screen.removeListener("display-metrics-changed", changed);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const sample = () => {
      try {
        let now = time.now();
        if (!Number.isFinite(now) || now >= options.deadline)
          throw new Error(
            "Timed out waiting for stable owned fixture displays",
          );
        const current = displaySnapshot(screen.getAllDisplays());
        // The synchronous native snapshot can consume the remaining budget.
        now = time.now();
        if (!Number.isFinite(now) || now >= options.deadline)
          throw new Error(
            "Timed out waiting for stable owned fixture displays",
          );
        if (current !== previous) quietSince = now;
        previous = current;
        if (now - quietSince >= quietMs) {
          finish();
          return;
        }
        cancelTimer = time.schedule(
          sample,
          Math.min(
            sampleMs,
            options.deadline - now,
            quietMs - (now - quietSince),
          ),
        );
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error("Owned fixture display observation failed", {
                cause: error,
              }),
        );
      }
    };
    screen.on("display-added", changed);
    screen.on("display-removed", changed);
    screen.on("display-metrics-changed", changed);
    sample();
  });
}

function displaySnapshot(displays: Display[]): string {
  if (displays.length === 0) throw new Error("Owned fixture has no displays");
  const ids = new Set<number>();
  const snapshot = displays.map((display) => {
    if (!Number.isSafeInteger(display.id) || ids.has(display.id))
      throw new Error("Owned fixture has invalid display identities");
    ids.add(display.id);
    const numbers = [
      display.id,
      display.bounds.x,
      display.bounds.y,
      display.bounds.width,
      display.bounds.height,
      display.workArea.x,
      display.workArea.y,
      display.workArea.width,
      display.workArea.height,
      display.scaleFactor,
      display.rotation,
    ];
    if (!numbers.every(Number.isFinite))
      throw new Error("Owned fixture has unverifiable display geometry");
    return numbers;
  });
  snapshot.sort((left, right) => left[0]! - right[0]!);
  return JSON.stringify(snapshot);
}
