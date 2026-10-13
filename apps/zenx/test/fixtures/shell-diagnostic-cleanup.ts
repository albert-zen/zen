import type { ShellPtyProcess } from "../../../../src/shell-session.js";
import { wrapDesktopPty } from "../../src/main/shell-pty.js";

/** Observe this fixture's native close, including errors the real adapter warns about. */
export function createShellDiagnosticCleanup() {
  let terminal: ShellPtyProcess | undefined;
  const subscriptions: { dispose(): void }[] = [];
  const errors: { stage: string; error: unknown }[] = [];
  const record = (stage: string, error: unknown) => {
    if (!errors.some((entry) => entry.error === error))
      errors.push({ stage, error });
  };
  return {
    wrap(raw: ShellPtyProcess, platform = process.platform) {
      terminal = wrapDesktopPty(
        {
          write: (data) => raw.write(data),
          resize: (cols, rows) => raw.resize(cols, rows),
          onData: (listener) => raw.onData(listener),
          onExit: (listener) => raw.onExit(listener),
          kill(signal) {
            try {
              raw.kill(signal);
            } catch (error) {
              record("owned native close", error);
              throw error;
            }
          },
        },
        platform,
      );
      return terminal;
    },
    register(subscription: { dispose(): void }) {
      subscriptions.push(subscription);
    },
    async finish({
      exited,
      primaryFailure,
      observe,
      removeDirectory,
      report,
    }: {
      exited: boolean;
      primaryFailure?: { error: unknown };
      observe: () => Promise<unknown>;
      removeDirectory: () => Promise<void>;
      report: (result: {
        primaryFailure: string | null;
        cleanupFailures: { stage: string; error: string }[];
        observation: unknown;
      }) => void;
    }) {
      if (terminal && !exited) {
        try {
          terminal.kill();
        } catch (error) {
          record("owned terminal close", error);
        }
      }
      for (const subscription of subscriptions) {
        try {
          subscription.dispose();
        } catch (error) {
          record("subscription disposal", error);
        }
      }
      let observation: unknown;
      try {
        observation = await observe();
      } catch (error) {
        record("final observation", error);
        observation = { unavailable: String(error) };
      }
      try {
        await removeDirectory();
      } catch (error) {
        record("temporary directory removal", error);
      }
      try {
        report({
          primaryFailure: primaryFailure ? String(primaryFailure.error) : null,
          cleanupFailures: errors.map(({ stage, error }) => ({
            stage,
            error: String(error),
          })),
          observation,
        });
      } catch (error) {
        record("final report", error);
      }
      if (primaryFailure) throw primaryFailure.error;
      if (errors.length)
        throw new AggregateError(
          errors.map(({ error }) => error),
          "Windows Shell diagnostic cleanup failed",
        );
    },
  };
}
