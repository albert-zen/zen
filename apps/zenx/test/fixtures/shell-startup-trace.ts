import { stripVTControlCharacters } from "node:util";

/** Observation only: this never writes to the shell or changes readiness. */
export function createShellStartupTrace({
  enabled,
  now = Date.now,
  log = console.info,
}: {
  enabled: boolean;
  now?: () => number;
  log?: (message: string) => void;
}) {
  const started = now();
  let firstOutput = false;
  let firstPrompt = false;
  let output = "";
  const stage = (stage: string) => {
    if (!enabled) return;
    try {
      log(
        `[Shell startup] ${JSON.stringify({ stage, elapsedMs: now() - started })}`,
      );
    } catch {
      // Diagnostic sinks cannot change the acceptance or process lifecycle.
    }
  };
  return {
    stage,
    onData(data: string) {
      if (!enabled || firstPrompt || !data) return;
      if (!firstOutput) {
        firstOutput = true;
        stage("first output");
      }
      output = (output + data).slice(-4096);
      if (/PS [^\r\n]*> /u.test(stripVTControlCharacters(output))) {
        firstPrompt = true;
        stage("first PowerShell prompt");
      }
    },
  };
}
