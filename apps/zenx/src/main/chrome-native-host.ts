import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import WebSocket from "ws";

// Chrome accepts at most 1 MiB from a native host, while messages sent by the
// extension to the host may be as large as 64 MiB. Screenshot and screencast
// responses travel in the latter direction.
export const CHROME_NATIVE_OUTPUT_MAX_BYTES = 1024 * 1024;
export const CHROME_NATIVE_INPUT_MAX_BYTES = 64 * 1024 * 1024;

export interface ChromeBridgeDescriptor {
  protocolVersion: 1;
  nativeWebSocketUrl: string;
}

export type ChromeNativeHostStage =
  | "resolve-user-data"
  | "electron-ready"
  | "default-user-data"
  | "read-descriptor"
  | "stdio"
  | "connect"
  | "session";

export class ChromeNativeMessageDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const messages: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > CHROME_NATIVE_INPUT_MAX_BYTES) {
        throw new Error(
          `Chrome native message exceeds ${String(CHROME_NATIVE_INPUT_MAX_BYTES)} bytes`,
        );
      }
      if (this.#buffer.length < 4 + length) break;
      const payload = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      messages.push(JSON.parse(payload.toString("utf8")) as unknown);
    }
    return messages;
  }
}

export function encodeChromeNativeMessage(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > CHROME_NATIVE_OUTPUT_MAX_BYTES) {
    throw new Error(
      `Chrome native message exceeds ${String(CHROME_NATIVE_OUTPUT_MAX_BYTES)} bytes`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function chromeNativeHostOrigin(
  argv: readonly string[],
  expectedOrigin: string,
): string | undefined {
  return argv.find((value) => value === expectedOrigin);
}

export function chromeNativeHostUserDataDirectory(options: {
  argv: readonly string[];
  commandLineValue?: string;
}): string | undefined {
  const prefix = "--user-data-dir=";
  const argvValues = options.argv.flatMap((value, index, values) => {
    if (value.startsWith(prefix)) return [value.slice(prefix.length)];
    return value === "--user-data-dir" && values[index + 1] !== undefined
      ? [values[index + 1]!]
      : [];
  });
  const explicit = [...new Set(argvValues.map((value) => path.resolve(value)))];
  if (explicit.length > 1) {
    throw new Error("ZenX native host user data directory is invalid");
  }
  if (explicit[0] !== undefined) return explicit[0];
  return options.commandLineValue === undefined ||
    options.commandLineValue.length === 0
    ? undefined
    : path.resolve(options.commandLineValue);
}

export function chromeNativeHostFailureDiagnostic(
  error: unknown,
  stage: ChromeNativeHostStage,
): string {
  const code = safeErrorCode(error);
  const category = safeErrorCategory(error);
  return `ZenX Chrome native host failed [${stage}]${code === undefined ? "" : ` (${code})`}${category === undefined ? "" : ` {${category}}`}\n`;
}

function safeErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 3 || typeof error !== "object" || error === null)
    return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code)) return code;
  const cause = safeErrorCode((error as { cause?: unknown }).cause, depth + 1);
  if (cause !== undefined) return cause;
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  for (const nested of errors) {
    const nestedCode = safeErrorCode(nested, depth + 1);
    if (nestedCode !== undefined) return nestedCode;
  }
  return undefined;
}

function safeErrorCategory(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (/Unexpected server response: [0-9]{3}/u.test(error.message))
    return "http-response";
  if (/Opening handshake has timed out/u.test(error.message))
    return "handshake-timeout";
  if (/socket hang up/u.test(error.message)) return "socket-hang-up";
  if (
    /WebSocket was closed before the connection was established/u.test(
      error.message,
    )
  )
    return "closed-before-open";
  if (/Implement me\. Unknown stream file type!/u.test(error.message))
    return "unsupported-stdio";
  return undefined;
}

export async function runChromeNativeHost(options: {
  descriptorFile: string;
  origin: string;
  expectedOrigin: string;
  onStage?(stage: "read-descriptor" | "stdio" | "connect" | "session"): void;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<void> {
  if (options.origin !== options.expectedOrigin) {
    throw new Error("Chrome native host caller is not the ZenX extension");
  }
  options.onStage?.("read-descriptor");
  const descriptor = validateDescriptor(
    JSON.parse(await readFile(options.descriptorFile, "utf8")) as unknown,
  );
  options.onStage?.("stdio");
  // Electron replaces process.stdin with an already-ended Readable on Windows.
  // Native Messaging still supplies inherited pipe handles, so open those file
  // descriptors directly instead of observing Electron's synthetic EOF stream.
  const input: NodeJS.ReadableStream =
    options.input ??
    (process.platform === "win32"
      ? createReadStream("", { fd: 0, autoClose: false })
      : process.stdin);
  const output: NodeJS.WritableStream =
    options.output ??
    (process.platform === "win32"
      ? createWriteStream("", { fd: 1, autoClose: false })
      : process.stdout);
  options.onStage?.("connect");
  const socket = new WebSocket(descriptor.nativeWebSocketUrl, {
    headers: { origin: options.origin },
    handshakeTimeout: 5_000,
  });
  const decoder = new ChromeNativeMessageDecoder();
  const queued: string[] = [];
  let open = false;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    socket.once("open", () => {
      options.onStage?.("session");
      open = true;
      for (const message of queued.splice(0)) socket.send(message);
    });
    socket.on("message", (data) => {
      try {
        output.write(encodeChromeNativeMessage(JSON.parse(data.toString())));
      } catch (error) {
        fail(error);
        socket.close();
      }
    });
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    input.on("data", (chunk: Uint8Array) => {
      try {
        for (const message of decoder.push(chunk)) {
          const serialized = JSON.stringify(message);
          if (open) socket.send(serialized);
          else if (queued.length < 32) queued.push(serialized);
          else throw new Error("Chrome native host startup queue is full");
        }
      } catch (error) {
        fail(error);
        socket.close();
      }
    });
    input.once("end", () => socket.close());
    input.once("error", fail);
    output.once("error", fail);
  });
}

function validateDescriptor(value: unknown): ChromeBridgeDescriptor {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { protocolVersion?: unknown }).protocolVersion !== 1 ||
    typeof (value as { nativeWebSocketUrl?: unknown }).nativeWebSocketUrl !==
      "string"
  ) {
    throw new Error("ZenX Chrome bridge descriptor is invalid");
  }
  const descriptor = value as ChromeBridgeDescriptor;
  const url = new URL(descriptor.nativeWebSocketUrl);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    !/^\/native\/[A-Za-z0-9_-]{32,}$/u.test(url.pathname) ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "ZenX Chrome bridge descriptor is not loopback-authenticated",
    );
  }
  return descriptor;
}
