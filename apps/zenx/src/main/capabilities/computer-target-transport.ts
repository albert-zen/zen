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
    resolve(value: unknown): void;
    reject(error: unknown): void;
    onStopping?: () => void;
    expectsInputReceipt: boolean;
  };
  #buffer = "";
  #stderr = "";
  #failure?: Error;
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
    const operation = this.#queue.then(() =>
      this.#request(request, signal, onStopping),
    );
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #request(
    request: Record<string, unknown>,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<unknown> {
    signal.throwIfAborted();
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
      const executable = await this.executable();
      signal.throwIfAborted();
      if (this.#closed) throw new Error("Computer target session is closed");
      this.#start(executable);
    }
    const child = this.#child!;
    const output = new Promise<unknown>((resolve, reject) => {
      this.#pending = {
        resolve,
        reject,
        onStopping,
        expectsInputReceipt:
          request.operation !== "select" && request.operation !== "verify",
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
          child.stdin.write(JSON.stringify(request) + "\n");
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
    });
    child.stdout.on("data", (chunk) => {
      // A late receipt cannot settle cancellation before the owned child closes.
      if (this.#terminating) return;
      this.#buffer += String(chunk);
      if (this.#buffer.length > 65536)
        return fail(new Error("Native target response exceeded bound"));
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const pending = this.#pending;
      if (!pending || this.#buffer.length)
        return fail(new Error("Unexpected native target response"));
      try {
        const response = JSON.parse(line) as {
          error?: string;
          result?: unknown;
        };
        if (
          !response ||
          typeof response !== "object" ||
          Array.isArray(response) ||
          ("error" in response
            ? typeof response.error !== "string" ||
              response.error.length === 0 ||
              "result" in response
            : !("result" in response))
        )
          throw new Error("Invalid native target response");
        if (
          !response.error &&
          pending.expectsInputReceipt &&
          !isPostedComputerInputReceipt(response.result)
        )
          throw new Error("Invalid native input receipt");
        this.#pending = undefined;
        if (response.error) pending.reject(new Error(response.error));
        else pending.resolve(response.result);
      } catch {
        fail(new Error("Invalid native target response"));
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
    try {
      this.#pending?.onStopping?.();
    } catch {
      // Presentation cannot prevent termination or settle an owned process.
    }
    // A signal request is not a close receipt. Failed kill/throw/error retains
    // the same pending owner; late replies cannot settle it or trigger replay.
    try {
      child.kill("SIGKILL");
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
