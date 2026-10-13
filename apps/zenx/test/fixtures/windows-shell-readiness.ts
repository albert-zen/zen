import { stripVTControlCharacters } from "node:util";

// Native evidence: an untouched PowerShell first prompt arrived after the 5s
// action threshold, observed by 6030ms (CI 38361180443/job115175488678).
// Only startup gets this budget; commands/output/Stop retain their 5s checks.
export const WINDOWS_SHELL_READINESS_MS = 10000;

export async function waitForWindowsShellReadiness(
  read: () => Promise<{
    inputAvailable: boolean;
    status: string;
    output: string;
  }>,
  createdAt: number,
  {
    now = Date.now,
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  const deadline = createdAt + WINDOWS_SHELL_READINESS_MS;
  let last: Awaited<ReturnType<typeof read>> | undefined;
  while (now() < deadline) {
    last = await read();
    // Include creation/control registration and the read itself in one bound.
    if (now() >= deadline) break;
    if (
      last.inputAvailable &&
      /PS [^\r\n]*> /u.test(stripVTControlCharacters(last.output))
    )
      return now() - createdAt;
    await sleep(Math.min(10, Math.max(0, deadline - now())));
  }
  throw new Error(
    `Timed out waiting for Windows Shell readiness: ${JSON.stringify({
      budgetMs: WINDOWS_SHELL_READINESS_MS,
      elapsedMs: now() - createdAt,
      status: last?.status,
      inputAvailable: last?.inputAvailable,
      output: last?.output.slice(-4096),
    })}`,
  );
}
