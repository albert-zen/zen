/** Windows-only worker: observes physical Shift state, never key contents. */

export function windowsShiftPairPressed(
  readKeyState: (virtualKey: number) => number,
): boolean {
  return (
    (readKeyState(0xa0) & 0x8000) !== 0 &&
    (readKeyState(0xa1) & 0x8000) !== 0
  );
}

export function createWindowsShiftPairEdgeDetector(
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

async function loadShiftPairReader(): Promise<() => boolean> {
  // Loaded only inside this Windows worker, not Electron main or the renderer.
  const { DataType, load, open } = await import("ffi-rs");
  const library = "zenx-app-shot-shift";
  open({ library, path: "user32.dll" });
  return () =>
    windowsShiftPairPressed((virtualKey) =>
      load({
        library,
        funcName: "GetAsyncKeyState",
        retType: DataType.I16,
        paramsType: [DataType.I32],
        paramsValue: [virtualKey],
      }),
    );
}

async function runWorker(sampleLimit: number): Promise<void> {
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

  const readPair = await loadShiftPairReader();
  if (stopped || !process.connected) {
    finish(0);
    return;
  }
  const risingEdge = createWindowsShiftPairEdgeDetector(readPair);
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
  const sampleLimit =
    mode === "app-shot-modifier-smoke" ? Number(process.argv[3]) : 0;
  if (
    !Number.isInteger(sampleLimit) ||
    sampleLimit < 0 ||
    sampleLimit > 20 ||
    (mode === "app-shot-modifier-smoke" && sampleLimit === 0)
  ) {
    process.exitCode = 1;
    if (process.connected) process.disconnect?.();
  } else {
    void runWorker(sampleLimit).catch(() => process.exit(1));
  }
}
