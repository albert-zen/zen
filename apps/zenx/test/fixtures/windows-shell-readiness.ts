import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";

// Native spawn/control returned in 171ms, but the untouched first PowerShell
// prompt was observed at 17,033ms (CI 38417468520/job115365619182).
// Keep creation/control strict. The absolute prompt bound includes creation and
// gives that observed cold start about 3s of margin, without resetting on output.
export const WINDOWS_SHELL_CONTROL_MS = 5000;
export const WINDOWS_SHELL_READINESS_MS = 20000;

type StartupRead = {
  inputAvailable: boolean;
  status: string;
  output: string;
};

/** Read-only fixture readiness; the caller still owns cleanup on every outcome. */
export async function waitForWindowsShellReadiness<T>(
  create: () => Promise<T>,
  read: (session: T) => Promise<StartupRead>,
  {
    now = () => performance.now(),
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ session: T; elapsedMs: number }> {
  const startedAt = now();
  const controlDeadline = startedAt + WINDOWS_SHELL_CONTROL_MS;
  const promptDeadline = startedAt + WINDOWS_SHELL_READINESS_MS;
  let controlAvailable = false;
  let last: StartupRead | undefined;
  const failure = (reason: string) =>
    new Error(
      `${reason}: ${JSON.stringify({
        phase: controlAvailable ? "PowerShell prompt" : "creation/control",
        budgetMs: controlAvailable
          ? WINDOWS_SHELL_READINESS_MS
          : WINDOWS_SHELL_CONTROL_MS,
        elapsedMs: now() - startedAt,
        status: last?.status,
        inputAvailable: last?.inputAvailable,
        output: last?.output.slice(-4096),
      })}`,
    );
  const timeout = () =>
    failure("Timed out waiting for Windows Shell readiness");
  const bounded = async <R>(operation: () => Promise<R>, deadline: number) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw timeout();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeout()), remaining);
        }),
      ]);
      // Creation or an observation completing at/after the bound is not ready.
      if (now() >= deadline) throw timeout();
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const session = await bounded(create, controlDeadline);
  for (;;) {
    last = await bounded(
      () => read(session),
      controlAvailable ? promptDeadline : controlDeadline,
    );
    if (last.status !== "queued" && last.status !== "running")
      throw failure("Windows Shell stopped before readiness");
    if (last.status === "running" && last.inputAvailable) {
      controlAvailable = true;
      if (/PS [^\r\n]*> /u.test(stripVTControlCharacters(last.output)))
        return { session, elapsedMs: now() - startedAt };
    }
    const deadline = controlAvailable ? promptDeadline : controlDeadline;
    await sleep(Math.min(10, Math.max(0, deadline - now())));
  }
}
