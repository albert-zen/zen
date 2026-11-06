/** Windows-only worker: observes a fixed physical modifier pair, never typed keys. */
import { isAppShotModifier, type AppShotModifier } from "../app-shot.js";

const VIRTUAL_KEYS: Record<AppShotModifier, readonly [number, number]> = {
  shift: [0xa0, 0xa1],
  control: [0xa2, 0xa3],
  alt: [0xa4, 0xa5],
  meta: [0x5b, 0x5c],
};

export function windowsModifierPairPressed(
  readKeyState: (virtualKey: number) => number,
  modifier: AppShotModifier = "shift",
): boolean {
  if (!isAppShotModifier(modifier))
    throw new Error("Invalid App Shot modifier");
  const [left, right] = VIRTUAL_KEYS[modifier];
  return (
    (readKeyState(left) & 0x8000) !== 0 && (readKeyState(right) & 0x8000) !== 0
  );
}

export function createWindowsModifierPairEdgeDetector(
  readPair: () => boolean,
): () => boolean {
  let wasPressed = false;
  return () => {
    const pressed = readPair();
    const triggered = pressed && !wasPressed;
    wasPressed = pressed;
    return triggered;
  };
}

// Keep the original pure helper entry points compatible.
export const windowsShiftPairPressed = (
  readKeyState: (virtualKey: number) => number,
): boolean => windowsModifierPairPressed(readKeyState, "shift");
export const createWindowsShiftPairEdgeDetector =
  createWindowsModifierPairEdgeDetector;

async function loadModifierPairReader(
  modifier: AppShotModifier,
): Promise<() => boolean> {
  // Loaded only inside this Windows worker, not Electron main or the renderer.
  const { DataType, load, open } = await import("ffi-rs");
  const library = "zenx-app-shot-modifier";
  open({ library, path: "user32.dll" });
  return () =>
    windowsModifierPairPressed(
      (virtualKey) =>
        load({
          library,
          funcName: "GetAsyncKeyState",
          retType: DataType.I16,
          paramsType: [DataType.I32],
          paramsValue: [virtualKey],
        }),
      modifier,
    );
}

async function runWorker(
  sampleLimit: number,
  modifier: AppShotModifier,
): Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const finish = (code: number) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.exit(code);
  };
  process.once("disconnect", () => finish(0));
  process.once("SIGTERM", () => finish(0));
  process.once("SIGINT", () => finish(0));
  if (process.platform !== "win32" || !process.connected || !process.send) {
    finish(1);
    return;
  }

  const send = (message: string | { type: "smoke"; samples: number }) => {
    if (!process.connected || !process.send) {
      finish(0);
      return false;
    }
    try {
      const accepted = process.send(message, (error: Error | null) => {
        if (error) finish(1);
        else if (typeof message !== "string") finish(0);
      });
      // Never accumulate an unbounded IPC backlog if the owner stops draining it.
      if (!accepted) finish(1);
      return accepted;
    } catch {
      finish(1);
      return false;
    }
  };

  const readPair = await loadModifierPairReader(modifier);
  if (stopped || !process.connected) {
    finish(0);
    return;
  }
  const risingEdge = createWindowsModifierPairEdgeDetector(readPair);
  let samples = 0;
  if (!send("ready")) return;
  // Same Windows timing as T3: sample both physical virtual keys every 50 ms.
  timer = setInterval(() => {
    if (!process.connected) {
      finish(0);
      return;
    }
    try {
      if (risingEdge() && !send("trigger")) return;
      samples++;
      if (sampleLimit > 0 && samples >= sampleLimit) {
        clearInterval(timer);
        send({ type: "smoke", samples });
      }
    } catch {
      finish(1);
    }
  }, 50);
}

// Explicit modes avoid side effects when pure helpers are imported by unit tests.
// Production has no arbitrary key selector or arbitrary native-function input.
const mode = process.argv[2];
if (
  mode === "app-shot-modifier-monitor" ||
  mode === "app-shot-modifier-smoke"
) {
  const sampleLimit = Number(process.argv[3] ?? "0");
  const modifier = process.argv[4] ?? "shift";
  if (
    !isAppShotModifier(modifier) ||
    process.argv.length > 5 ||
    (mode === "app-shot-modifier-monitor" && sampleLimit !== 0) ||
    !Number.isInteger(sampleLimit) ||
    sampleLimit < 0 ||
    sampleLimit > 20 ||
    (mode === "app-shot-modifier-smoke" && sampleLimit === 0)
  ) {
    process.exitCode = 1;
    if (process.connected) process.disconnect?.();
  } else {
    void runWorker(sampleLimit, modifier).catch(() => process.exit(1));
  }
}
