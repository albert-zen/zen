import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { SshFleetDevice } from "./fleet.js";
import type { ZenXTriggerAppServerPort } from "./trigger-service.js";
class SshFleetWatchError extends Error {
  constructor(
    message: string,
    readonly reconnectable: boolean,
  ) {
    super(message);
  }
}
export function subscribeSshFleetThread(
  device: SshFleetDevice,
  workspace: string | undefined,
  threadId: string,
  options: Parameters<
    NonNullable<ZenXTriggerAppServerPort["subscribeRemoteThread"]>
  >[3],
  signal: AbortSignal,
  launch?: (input: unknown) => ChildProcessWithoutNullStreams,
): () => void {
  const controller = new AbortController();
  let child: ChildProcessWithoutNullStreams | undefined;
  const observed = new Set<string>();
  let first = true;
  const stop = () => {
    controller.abort();
    child?.kill();
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
  void (async () => {
    let backoff = 1000;
    while (!controller.signal.aborted) {
      try {
        await new Promise<void>((resolve, reject) => {
          const payload = {
            watch: true,
            threadId,
            ...(workspace ? { workspace } : {}),
            includeCurrentTerminal: first && options.includeCurrentTerminal,
            observed: [...observed],
          };
          child = launch
            ? launch(payload)
            : spawn(
                "ssh",
                [
                  "-T",
                  "-oBatchMode=yes",
                  "-oStrictHostKeyChecking=yes",
                  "-oConnectTimeout=10",
                  "-oServerAliveInterval=15",
                  "-oServerAliveCountMax=3",
                  "--",
                  device.sshHost,
                  device.command.map(quote).join(" "),
                ],
                { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
              );
          const process = child;
          const decoder = new StringDecoder("utf8");
          let buffer = "";
          let settled = false;
          let securityFailure = false;
          let stderr = "";
          const deadline = setTimeout(
            () =>
              finish(
                new SshFleetWatchError(
                  "Fleet SSH watch did not become ready; reconnecting",
                  true,
                ),
              ),
            40_000,
          );
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            controller.signal.removeEventListener("abort", cancel);
            process.kill();
            error ? reject(error) : resolve();
          };
          const cancel = () => finish();
          controller.signal.addEventListener("abort", cancel, { once: true });
          process.on("error", () =>
            finish(
              new SshFleetWatchError(
                "Fleet SSH watch could not connect; reconnecting",
                true,
              ),
            ),
          );
          process.on("close", () =>
            finish(
              new SshFleetWatchError(
                securityFailure
                  ? "Fleet SSH authorization or host-key check failed; source observation stopped"
                  : "Fleet SSH watch disconnected; reconnecting",
                !securityFailure,
              ),
            ),
          );
          process.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-4096);
            if (
              /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|no matching host key/u.test(
                stderr,
              )
            )
              securityFailure = true;
          });
          process.stdin.on("error", () =>
            finish(
              new SshFleetWatchError(
                "Fleet SSH watch input closed; reconnecting",
                true,
              ),
            ),
          );
          process.stdout.on("data", (chunk: Buffer) => {
            if (settled || controller.signal.aborted) return;
            buffer += decoder.write(chunk);
            if (Buffer.byteLength(buffer) > 65536) {
              finish(
                new SshFleetWatchError(
                  "Fleet watch frame exceeds limit; source observation stopped",
                  false,
                ),
              );
              return;
            }
            for (let index; (index = buffer.indexOf("\n")) >= 0;) {
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 1);
              try {
                const event = JSON.parse(line);
                if (settled || controller.signal.aborted) return;
                if (!event || typeof event !== "object" || Array.isArray(event))
                  throw new Error("Invalid Fleet watch event");
                if (event.ok === false)
                  throw new Error(
                    "Fleet remote watcher unavailable; check Host configuration",
                  );
                if (event.threadId !== threadId)
                  throw new Error("Fleet watch target mismatch");
                if (event.type === "ready") {
                  clearTimeout(deadline);
                  first = false;
                  backoff = 1000;
                  options.onReady?.();
                } else if (
                  event.type === "active" &&
                  typeof event.turnId === "string" &&
                  event.turnId.length > 0 &&
                  event.turnId.length <= 512 &&
                  !/[\x00-\x1f\x7f]/u.test(event.turnId)
                ) {
                  observed.add(event.turnId);
                  if (observed.size > 128)
                    throw new Error("Fleet watch observation limit exceeded");
                } else if (
                  event.type === "turn" &&
                  typeof event.turnId === "string" &&
                  event.turnId.length > 0 &&
                  event.turnId.length <= 512 &&
                  !/[\x00-\x1f\x7f]/u.test(event.turnId) &&
                  ["completed", "failed", "interrupted"].includes(event.status)
                ) {
                  observed.delete(event.turnId);
                  options.onTurn({
                    threadId,
                    turnId: event.turnId,
                    status: event.status,
                  });
                } else throw new Error("Invalid Fleet watch event");
              } catch (error) {
                finish(
                  new SshFleetWatchError(
                    error instanceof Error
                      ? `${error.message}; source observation stopped`
                      : "Invalid Fleet watch response; source observation stopped",
                    false,
                  ),
                );
                return;
              }
            }
          });
          process.stdin.end(JSON.stringify(payload));
        });
      } catch (error) {
        if (!controller.signal.aborted)
          options.onError(
            error instanceof Error ? error : new Error("Fleet watch failed"),
          );
        if (error instanceof SshFleetWatchError && !error.reconnectable) {
          stop();
          break;
        }
      }
      if (controller.signal.aborted) break;
      try {
        await delay(backoff, undefined, { signal: controller.signal });
      } catch {
        break;
      }
      backoff = Math.min(backoff * 2, 30000);
    }
    signal.removeEventListener("abort", stop);
  })();
  return stop;
}
