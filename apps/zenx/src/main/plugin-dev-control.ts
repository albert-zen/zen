import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ZenXPluginDevRequest,
  ZenXPluginDevResult,
  ZenXPluginDevTargetDescriptor,
} from "@zenx/plugin-sdk";

const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_TRANSACTION_TIMEOUT_MS = 4 * 60_000;

export interface ZenXPluginDevControlOptions {
  descriptorFile: string;
  tokenFile: string;
  install(
    request: ZenXPluginDevRequest,
    signal: AbortSignal,
    enterCommitPhase: () => void,
  ): Promise<{
    pluginId: string;
    packageName: string;
    generation: string;
  }>;
  reload(
    pluginId: string,
  ): Promise<{ status: "reloaded" } | { status: "failed"; message: string }>;
  requestBodyTimeoutMs?: number;
  transactionTimeoutMs?: number;
  assertCanPublish?(): void;
}

interface ActiveDevRequest {
  controller: AbortController;
  operation: Promise<void>;
  interruptible: boolean;
}

/** Explicit, authenticated loopback control seam for one running ZenX instance. */
export class ZenXPluginDevControlServer {
  readonly #server: Server;
  readonly #descriptorFile: string;
  readonly #tokenFile: string;
  readonly #activeRequests: Set<ActiveDevRequest>;
  #closed = false;

  private constructor(
    server: Server,
    descriptorFile: string,
    tokenFile: string,
    activeRequests: Set<ActiveDevRequest>,
  ) {
    this.#server = server;
    this.#descriptorFile = descriptorFile;
    this.#tokenFile = tokenFile;
    this.#activeRequests = activeRequests;
  }

  static async start(
    options: ZenXPluginDevControlOptions,
  ): Promise<ZenXPluginDevControlServer> {
    const token = randomBytes(32).toString("hex");
    const activeRequests = new Set<ActiveDevRequest>();
    const bodyTimeoutMs = positiveTimeout(
      options.requestBodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
    );
    const transactionTimeoutMs = positiveTimeout(
      options.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS,
    );
    const server = createServer((request, response) => {
      const controller = new AbortController();
      const active: ActiveDevRequest = {
        controller,
        interruptible: true,
        operation: Promise.resolve(),
      };
      active.operation = serveDevRequest({
        request,
        response,
        token,
        options,
        active,
        bodyTimeoutMs,
        transactionTimeoutMs,
      }).finally(() => activeRequests.delete(active));
      activeRequests.add(active);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      options.assertCanPublish?.();
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Plugin dev control server has no loopback address");
      }
      await mkdir(path.dirname(options.descriptorFile), {
        recursive: true,
        mode: 0o700,
      });
      await writePrivateFile(options.tokenFile, `${token}\n`);
      options.assertCanPublish?.();
      const descriptor: ZenXPluginDevTargetDescriptor = {
        version: 1,
        transport: "http",
        url: `http://127.0.0.1:${String(address.port)}`,
        authentication: {
          type: "bearer-file",
          tokenFile: path.resolve(options.tokenFile),
        },
      };
      await writePrivateFile(
        options.descriptorFile,
        `${JSON.stringify(descriptor)}\n`,
      );
      options.assertCanPublish?.();
      return new ZenXPluginDevControlServer(
        server,
        options.descriptorFile,
        options.tokenFile,
        activeRequests,
      );
    } catch (error) {
      const failures = [asError(error)];
      const closing = closeServer(server);
      for (const active of activeRequests) {
        abortInterruptible(
          active,
          new Error("ZenX plugin dev control startup was cancelled"),
        );
      }
      const cleanup = await Promise.allSettled([
        Promise.allSettled(
          [...activeRequests].map((active) => active.operation),
        ).then(async () => {
          server.closeAllConnections();
          await closing;
        }),
        removeFile(options.descriptorFile),
        removeFile(options.tokenFile),
      ]);
      for (const result of cleanup) {
        if (result.status === "rejected") failures.push(asError(result.reason));
      }
      if (failures.length === 1) throw error;
      throw new AggregateError(
        failures,
        "Plugin dev control startup failed and cleanup was incomplete",
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closing = closeServer(this.#server);
    for (const active of this.#activeRequests) {
      abortInterruptible(active, new Error("ZenX plugin dev control stopped"));
    }
    const cleanup = await Promise.allSettled([
      Promise.allSettled(
        [...this.#activeRequests].map((active) => active.operation),
      ).then(async () => {
        this.#server.closeAllConnections();
        await closing;
      }),
      removeFile(this.#descriptorFile),
      removeFile(this.#tokenFile),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [asError(result.reason)] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Plugin dev control cleanup was incomplete",
      );
    }
  }
}

async function serveDevRequest(options: {
  request: IncomingMessage;
  response: import("node:http").ServerResponse;
  token: string;
  options: ZenXPluginDevControlOptions;
  active: ActiveDevRequest;
  bodyTimeoutMs: number;
  transactionTimeoutMs: number;
}): Promise<void> {
  const { request, response, active } = options;
  const { controller } = active;
  response.setHeader("content-type", "application/json");
  response.setHeader("connection", "close");
  const abortDisconnected = (): void => {
    if (!response.writableEnded) {
      abortInterruptible(active, new Error("Plugin dev client disconnected"));
    }
  };
  request.once("aborted", abortDisconnected);
  response.once("close", abortDisconnected);
  let transactionTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    abortInterruptible(
      active,
      new Error(
        `Plugin dev transaction timed out after ${String(options.transactionTimeoutMs)}ms`,
      ),
    );
  }, options.transactionTimeoutMs);
  let commitPhaseEntered = false;
  const enterCommitPhase = (): void => {
    if (commitPhaseEntered) {
      throw new Error("Plugin dev commit phase was entered more than once");
    }
    controller.signal.throwIfAborted();
    commitPhaseEntered = true;
    active.interruptible = false;
    clearTimeout(transactionTimer);
    transactionTimer = undefined;
  };
  try {
    if (request.method !== "POST" || request.url !== "/v1/plugins/dev") {
      respond(response, 404, { message: "Unknown plugin dev route" });
      return;
    }
    if (!authorized(request.headers.authorization, options.token)) {
      respond(response, 401, { message: "Plugin dev authorization failed" });
      return;
    }
    const devRequest = assertDevRequest(
      JSON.parse(
        await readRequestBody(
          request,
          options.bodyTimeoutMs,
          controller.signal,
        ),
      ) as unknown,
    );
    controller.signal.throwIfAborted();
    const installed = await options.options.install(
      devRequest,
      controller.signal,
      enterCommitPhase,
    );
    if (!commitPhaseEntered) {
      throw new Error("Plugin dev install did not enter its commit phase");
    }
    controller.signal.throwIfAborted();
    if (
      installed.pluginId !== devRequest.pluginId ||
      installed.packageName !== devRequest.packageName
    ) {
      throw new Error("Installed plugin identity does not match dev request");
    }
    const result: ZenXPluginDevResult = {
      version: 1,
      pluginId: installed.pluginId,
      packageName: installed.packageName,
      generation: installed.generation,
      reload: await options.options.reload(installed.pluginId),
    };
    respond(response, 200, result);
  } catch (error) {
    respond(response, 400, {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (transactionTimer !== undefined) clearTimeout(transactionTimer);
    request.off("aborted", abortDisconnected);
    response.off("close", abortDisconnected);
  }
}

function abortInterruptible(active: ActiveDevRequest, reason: Error): void {
  if (active.interruptible) active.controller.abort(reason);
}

function assertDevRequest(value: unknown): ZenXPluginDevRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { projectDirectory?: unknown }).projectDirectory !==
      "string" ||
    !path.isAbsolute(
      (value as { projectDirectory: string }).projectDirectory,
    ) ||
    typeof (value as { packageName?: unknown }).packageName !== "string" ||
    typeof (value as { pluginId?: unknown }).pluginId !== "string" ||
    !/^[a-z][a-z0-9-]{1,62}$/u.test((value as { pluginId: string }).pluginId)
  ) {
    throw new Error("Invalid ZenX plugin dev request");
  }
  return value as ZenXPluginDevRequest;
}

async function readRequestBody(
  request: IncomingMessage,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      signal.removeEventListener("abort", onSignalAbort);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BYTES) {
        finish(new Error("Plugin dev request is too large"));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onAborted = (): void =>
      finish(new Error("Plugin dev request body was aborted"));
    const onSignalAbort = (): void => finish(abortError(signal));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Plugin dev request body timed out after ${String(timeoutMs)}ms`,
          ),
        ),
      timeoutMs,
    );
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    signal.addEventListener("abort", onSignalAbort, { once: true });
    if (signal.aborted) onSignalAbort();
  });
}

function respond(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

async function writePrivateFile(
  filePath: string,
  value: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, value, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(filePath, 0o600);
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Plugin dev timeout must be a positive integer");
  }
  return value;
}
