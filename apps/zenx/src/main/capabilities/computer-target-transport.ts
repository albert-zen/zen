import {
  nativeComputerRequestDiagnostics,
  type NativeRequestDiagnostics,
} from "./computer-native-trace.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  isPostedComputerInputReceipt,
  type TargetTransport,
} from "./computer-target-session.js";

/** Single native session, serialized JSONL; death invalidates all AX object references. */
export class NativeComputerTargetTransport implements TargetTransport {
  #child?: ChildProcessWithoutNullStreams;
  #closed = false;
  #terminating = false;
  #queue: Promise<unknown> = Promise.resolve();
  #pending?: {
    diagnostic?: NativeRequestDiagnostics;
    resolve(value: unknown): void;
    reject(error: unknown): void;
    onStopping?: () => void;
    expectsInputReceipt: boolean;
    background: boolean;
    backgroundSettled: boolean;
    pairStarted: boolean;
  };
  #buffer = "";
  #stderr = "";
  #failure?: Error;
  #grace?: NodeJS.Timeout;
  #backgroundUnsafe = false;
  #exit: Promise<void> = Promise.resolve();
  constructor(
    readonly executable: () => Promise<string>,
    readonly spawnProcess: typeof spawn = spawn,
  ) {}

  request(
    request: Record<string, unknown>,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<unknown> {
    const diagnostic = nativeComputerRequestDiagnostics(request.operation);
    diagnostic?.event("queued");
    const operation = this.#queue.then(() =>
      this.#request(request, signal, onStopping, diagnostic),
    );
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #request(
    request: Record<string, unknown>,
    signal: AbortSignal,
    onStopping?: () => void,
    diagnostic?: NativeRequestDiagnostics,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (isBackgroundOperation(request.operation) && this.#backgroundUnsafe)
      throw new Error(
        "Background input release is unknown; replace this provider before further background input; no input dispatched",
      );
    if (this.#closed) throw new Error("Computer target session is closed");
    if (this.#terminating) {
      if (request.operation !== "select")
        throw new Error(
          "Native target session is stopping; reselect after it ends; no input dispatched",
        );
      await this.#exit;
      signal.throwIfAborted();
      if (this.#closed) throw new Error("Computer target session is closed");
    }
    if (!this.#child) {
      if (request.operation !== "select")
        throw new Error(
          "Native target session ended; select the window again; no input dispatched",
        );
      diagnostic?.event("helper-prepare");
      const executable = await this.executable();
      signal.throwIfAborted();
      if (this.#closed) throw new Error("Computer target session is closed");
      this.#start(executable);
      diagnostic?.event("helper-started");
    }
    const child = this.#child!;
    const output = new Promise<unknown>((resolve, reject) => {
      this.#pending = {
        diagnostic,
        resolve,
        reject,
        onStopping,
        background: isBackgroundOperation(request.operation),
        backgroundSettled: false,
        pairStarted: false,
        expectsInputReceipt: !["select", "verify", "capture"].includes(
          String(request.operation),
        ),
      };
    });
    const stop = (message: string) =>
      this.#terminate(child, new Error(message));
    const abort = () => stop("Computer target operation cancelled");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop("Computer target operation timed out"),
      10_000,
    );
    try {
      if (signal.aborted) abort();
      else {
        try {
          diagnostic?.event("dispatch");
          const payload = diagnostic?.correlationId
            ? { ...request, diagnosticRequestId: diagnostic.correlationId }
            : request;
          child.stdin.write(JSON.stringify(payload) + "\n");
        } catch {
          stop("Computer target dispatch failed");
        }
      }
      return await output;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  #start(executable: string): void {
    this.#buffer = "";
    this.#stderr = "";
    this.#failure = undefined;
    this.#terminating = false;
    const child = this.spawnProcess(executable, [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    this.#exit = new Promise<void>((resolve) => {
      child.once("close", () => {
        this.#pending?.diagnostic?.event("child-close", {
          terminating: this.#terminating,
        });
        clearTimeout(this.#grace);
        this.#grace = undefined;
        if (this.#pending?.background && !this.#pending.backgroundSettled)
          this.#backgroundUnsafe = true;
        this.#child = undefined;
        this.#pending?.reject(
          this.#failure ??
            this.#operationFailure(
              `Native target session ended. ${this.#stderr}`,
            ),
        );
        this.#pending = undefined;
        resolve();
      });
    });
    const fail = (error: Error) => {
      this.#terminate(child, error);
    };
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stderr.on("data", (chunk) => {
      this.#stderr = (this.#stderr + String(chunk)).slice(-2048);
      this.#pending?.diagnostic?.stderr(chunk);
    });
    child.stdout.on("data", (chunk) => {
      // A late receipt cannot settle cancellation before the owned child closes.
      if (this.#terminating && !this.#pending?.background) return;
      this.#buffer += String(chunk);
      if (this.#buffer.length > 65536)
        return fail(new Error("Native target response exceeded bound"));
      while (this.#buffer.includes("\n")) {
        const newline = this.#buffer.indexOf("\n");
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const pending = this.#pending;
        try {
          const response = JSON.parse(line) as {
            error?: string;
            result?: unknown;
            phase?: string;
            release?: string;
            diagnostic?: unknown;
          };
          if (response?.phase === "diagnostic") {
            pending?.diagnostic?.marker(response.diagnostic);
            continue;
          }
          if (!pending)
            return fail(new Error("Unexpected native target response"));
          if (
            pending.background &&
            response?.phase === "backgroundPairStarted" &&
            !pending.pairStarted &&
            !pending.backgroundSettled
          ) {
            pending.diagnostic?.event("background-pair-started");
            pending.pairStarted = true;
            continue;
          }
          if (
            pending.background &&
            response?.phase === "backgroundSettled" &&
            !pending.backgroundSettled &&
            ((response.release === "posted" && pending.pairStarted) ||
              (response.release === "not_needed" && !pending.pairStarted))
          ) {
            pending.diagnostic?.event("background-settled", {
              release: response.release,
            });
            pending.backgroundSettled = true;
            continue;
          }
          if (response?.phase !== undefined)
            throw new Error("Invalid native target phase");
          if (
            !response ||
            typeof response !== "object" ||
            Array.isArray(response) ||
            ("error" in response
              ? typeof response.error !== "string" ||
                !response.error ||
                "result" in response
              : !("result" in response))
          )
            throw new Error("Invalid native target response");
          if (pending.background && !pending.backgroundSettled)
            throw new Error(
              "Native background response lacks release settlement",
            );
          if (
            !response.error &&
            pending.expectsInputReceipt &&
            (!isPostedComputerInputReceipt(response.result) ||
              (pending.background &&
                (!pending.backgroundSettled ||
                  (response.result as { release?: unknown })?.release !==
                    "posted")))
          )
            throw new Error("Invalid native input receipt");
          // Cancellation retains the actual process owner until release/restore and close.
          pending.diagnostic?.terminal();
          pending.diagnostic?.event("terminal", {
            status: response.error ? "error" : "result",
            terminating: this.#terminating,
          });
          if (this.#terminating) continue;
          this.#pending = undefined;
          if (response.error) pending.reject(new Error(response.error));
          else pending.resolve(response.result);
        } catch {
          fail(new Error("Invalid native target response"));
          return;
        }
      }
    });
  }

  #operationFailure(message: string): Error {
    return new Error(
      `${message}; ${
        this.#pending?.expectsInputReceipt
          ? "native input outcome unknown; do not retry automatically"
          : "read-only target request outcome unknown; no input requested by this operation"
      }`,
    );
  }

  #terminate(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.#child || this.#terminating) return;
    this.#failure = this.#operationFailure(error.message);
    this.#terminating = true;
    this.#pending?.diagnostic?.event("cancel-requested", {
      reason:
        error.message === "Computer target operation timed out"
          ? "timeout"
          : error.message === "Computer target operation cancelled"
            ? "abort"
            : error.message === "Computer target session closed"
              ? "close"
              : "transport_failure",
    });
    try {
      this.#pending?.onStopping?.();
    } catch {
      // Presentation cannot prevent termination or settle an owned process.
    }
    // A signal request is not a close receipt. Failed kill/throw/error retains
    // the same pending owner; late replies cannot settle it or trigger replay.
    try {
      if (this.#pending?.background) {
        // Native SIGTERM only sets a cancellation flag. Its synchronous pair's
        // defer posts the prebuilt up, then best-effort deactivation before exit.
        child.kill("SIGTERM");
        this.#grace = setTimeout(() => {
          this.#backgroundUnsafe = true;
          try {
            child.kill("SIGKILL");
          } catch {
            /* Retain owner until real close. */
          }
        }, 2_000);
      } else child.kill("SIGKILL");
    } catch {
      // Preserve the original failure and wait for actual process/pipe close.
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#child)
      this.#terminate(this.#child, new Error("Computer target session closed"));
    await this.#exit;
  }
}

function isBackgroundOperation(operation: unknown): boolean {
  return ["backgroundClick", "backgroundType", "backgroundKeyPress"].includes(
    String(operation),
  );
}
