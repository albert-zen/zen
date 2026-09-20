import { readFile } from "node:fs/promises";

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

export async function runChromeNativeHost(options: {
  descriptorFile: string;
  origin: string;
  expectedOrigin: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<void> {
  if (options.origin !== options.expectedOrigin) {
    throw new Error("Chrome native host caller is not the ZenX extension");
  }
  const descriptor = validateDescriptor(
    JSON.parse(await readFile(options.descriptorFile, "utf8")) as unknown,
  );
  const socket = new WebSocket(descriptor.nativeWebSocketUrl, {
    headers: { origin: options.origin },
    handshakeTimeout: 5_000,
  });
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
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
