/**
 * Screenshot portal transport adapted from T3 Code:
 * https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot/LinuxSnapShot.ts
 * PNG bounds adapted from the same revision's linuxCaptureSession.ts.
 *
 * Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { constants } from "node:fs";
import * as NodeFSP from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DBusError,
  Message,
  MessageFlag,
  MessageType,
  Variant,
  sessionBus,
  type MessageBus,
  type MessageLike,
} from "dbus-next";

const PORTAL = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SCREENSHOT = "org.freedesktop.portal.Screenshot";
const REQUEST = "org.freedesktop.portal.Request";
const DBUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface PortalAppShotImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width: number;
    height: number;
    quality: "best";
  }): PortalAppShotImage;
  toPNG(): Buffer;
}

/** Pixels only: the portal supplies no identity suitable for accessibility correlation. */
export interface PortalAppShotCapture {
  png: Buffer;
  width: number;
  height: number;
}
export interface PortalAppShotOptions {
  /** Host-owned application identity, never renderer-controlled. */
  appId: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  createImage?: (png: Buffer) => PortalAppShotImage;
  /** A fresh, dedicated connection; injectable without granting desktop access. */
  createBus?: () => Pick<MessageBus, "call" | "send" | "disconnect"> &
    Pick<EventEmitter, "on" | "removeListener">;
  /** Test deadline seam. Production defaults are 5s calls and 120s portal response. */
  callTimeoutMs?: number;
  responseTimeoutMs?: number;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isUInt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}
function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function uintVariant(value: unknown): number {
  if (!isRecord(value) || value.signature !== "u" || !isUInt(value.value))
    throw new Error("Invalid screenshot portal properties.");
  return value.value;
}
function unavailable(error: unknown): boolean {
  return (
    error instanceof DBusError &&
    [
      "ServiceUnknown",
      "NameHasNoOwner",
      "UnknownObject",
      "UnknownInterface",
      "UnknownMethod",
    ].some((name) => error.type === `${DBUS}.Error.${name}`)
  );
}
function captureCancelled(): Error {
  const error = new Error("Portal App Shot capture cancelled.");
  error.name = "AbortError";
  return error;
}
function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw captureCancelled();
}

// Read the portal-owned file through one bounded descriptor, never delete it or
// claim ownership of its directory. O_NONBLOCK prevents a special-file open hang.
async function readPortalPng(
  uri: string,
  createImage?: PortalAppShotOptions["createImage"],
  signal?: AbortSignal,
): Promise<Pick<PortalAppShotCapture, "png" | "width" | "height">> {
  checkCancellation(signal);
  const file = await NodeFSP.open(
    fileURLToPath(uri),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  let png: Buffer;
  try {
    const stat = await file.stat();
    checkCancellation(signal);
    if (!stat.isFile() || stat.size > MAX_PNG_BYTES)
      throw new Error("Invalid screenshot file.");
    png = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < png.length) {
      checkCancellation(signal);
      const { bytesRead } = await file.read(
        png,
        offset,
        png.length - offset,
        offset,
      );
      if (!bytesRead) throw new Error("Incomplete screenshot file.");
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  checkCancellation(signal);
  if (!png.subarray(0, 8).equals(PNG_HEADER))
    throw new Error("Invalid or oversized window screenshot.");
  const image = createImage
    ? createImage(png)
    : (await import("electron")).nativeImage.createFromBuffer(png);
  checkCancellation(signal);
  if (image.isEmpty()) throw new Error("The window screenshot is empty.");
  const { width, height } = image.getSize();
  if (!isSize(width) || !isSize(height))
    throw new Error("Invalid window screenshot dimensions.");
  const scale = Math.min(2_560 / width, 1_600 / height, 1);
  if (scale >= 1) {
    if (png.length > MAX_OUTPUT_BYTES)
      throw new Error("Window screenshot exceeds the image size limit.");
    return { png, width, height };
  }
  const resized = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: "best",
  });
  if (resized.isEmpty()) throw new Error("The window screenshot is empty.");
  const resizedPng = resized.toPNG();
  checkCancellation(signal);
  const size = resized.getSize();
  if (
    resizedPng.length > MAX_OUTPUT_BYTES ||
    !resizedPng.subarray(0, 8).equals(PNG_HEADER) ||
    !isSize(size.width) ||
    !isSize(size.height) ||
    size.width > 2_560 ||
    size.height > 1_600
  )
    throw new Error("Invalid or oversized window screenshot.");
  return { png: resizedPng, ...size };
}

/**
 * Explicit capture only. Undefined means capability missing, never denied/cancelled.
 * No picker fallback, input, focus, config changes, shortcut registration, AX,
 * attachment persistence or model delivery. The host owns invocation policy.
 */
export function capturePortalActiveAppShot(
  options: PortalAppShotOptions,
): Promise<PortalAppShotCapture | undefined> {
  return runPortalOperation(options, true);
}

/** Read-only capability preflight. Never submits Screenshot or opens an image.
 * False means absent capability; denial, malformed replies and cancellation reject.
 * Host registration is connection-scoped identity, not a desktop permission grant.
 */
export function getPortalAppShotSupport(
  options: Omit<PortalAppShotOptions, "createImage" | "responseTimeoutMs">,
): Promise<boolean> {
  return runPortalOperation(options, false);
}

function runPortalOperation(
  options: PortalAppShotOptions,
  capture: true,
): Promise<PortalAppShotCapture | undefined>;
function runPortalOperation(
  options: PortalAppShotOptions,
  capture: false,
): Promise<boolean>;
async function runPortalOperation(
  options: PortalAppShotOptions,
  capture: boolean,
): Promise<PortalAppShotCapture | undefined | boolean> {
  checkCancellation(options.signal);
  const bus = (options.createBus ?? sessionBus)();
  let fail!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    fail = reject;
  });
  void stopped.catch(() => undefined);
  const onError = (error: Error) => fail(error);
  const onAbort = () => fail(captureCancelled());
  bus.on("error", onError);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let uniqueName = "";
  async function wait<T>(
    pending: Promise<T>,
    timeoutMs = options.callTimeoutMs ?? 5_000,
  ): Promise<T> {
    // A transport can synchronously abort while producing this promise.
    // Observe rejection even if the cancellation check below throws first.
    void pending.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      checkCancellation(options.signal);
      return await Promise.race([
        pending,
        stopped,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Portal App Shot timed out.")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function call(message: MessageLike): Promise<Message> {
    checkCancellation(options.signal);
    const reply = await wait(bus.call(new Message(message)));
    if (!reply) throw new Error("Missing D-Bus reply.");
    if (
      typeof reply.destination !== "string" ||
      !/^:[0-9]+(?:\.[0-9]+)+$/.test(reply.destination)
    )
      throw new Error("Invalid D-Bus connection identity.");
    uniqueName = reply.destination;
    return reply;
  }
  try {
    const env = options.env ?? process.env;
    if (!env.FLATPAK_ID && !env.SNAP) {
      await call({
        destination: PORTAL,
        path: PORTAL_PATH,
        interface: "org.freedesktop.host.portal.Registry",
        member: "Register",
        signature: "sa{sv}",
        body: [options.appId, {}],
      }).catch((error) => {
        if (!unavailable(error)) throw error;
      });
    }
    const properties = await call({
      destination: PORTAL,
      path: PORTAL_PATH,
      interface: "org.freedesktop.DBus.Properties",
      member: "GetAll",
      signature: "s",
      body: [SCREENSHOT],
    }).catch((error) => {
      if (!unavailable(error)) throw error;
      return undefined;
    });
    if (!properties) return capture ? undefined : false;
    const value: unknown = properties.body[0];
    if (!isRecord(value))
      throw new Error("Invalid screenshot portal properties.");
    const version = uintVariant(value.version);
    const targets =
      value.AvailableTargets === undefined
        ? 0
        : uintVariant(value.AvailableTargets);
    if (version < 3 || (targets & 8) === 0) return capture ? undefined : false;
    if (!capture) return true;
    const owner = await call({
      destination: DBUS,
      path: DBUS_PATH,
      interface: DBUS,
      member: "GetNameOwner",
      signature: "s",
      body: [PORTAL],
    });
    const sender: unknown = owner.body[0];
    if (typeof sender !== "string" || !/^:[0-9]+(?:\.[0-9]+)+$/.test(sender))
      throw new Error("Invalid portal owner.");
    const token = `zenx_${randomUUID().replaceAll("-", "")}`;
    const namespace = `${PORTAL_PATH}/request/${uniqueName.slice(1).replaceAll(".", "_")}/`;
    let handle = namespace + token;
    let completed = false;
    let submitted = false;
    const responses = new Map<string, unknown>();
    let deliver: ((body: unknown) => void) | undefined;
    const listener = (message: Message) => {
      if (
        message.type !== MessageType.SIGNAL ||
        message.sender !== sender ||
        message.interface !== REQUEST ||
        message.member !== "Response" ||
        typeof message.path !== "string" ||
        !message.path.startsWith(namespace)
      )
        return;
      if (deliver && message.path === handle) deliver(message.body);
      else if (responses.size < 8) responses.set(message.path, message.body);
    };
    bus.on("message", listener);
    try {
      await call({
        destination: DBUS,
        path: DBUS_PATH,
        interface: DBUS,
        member: "AddMatch",
        signature: "s",
        body: [
          `type='signal',sender='${sender}',interface='${REQUEST}',member='Response',path_namespace='${namespace.slice(0, -1)}'`,
        ],
      });
      checkCancellation(options.signal);
      submitted = true;
      const reply = await call({
        destination: sender,
        path: PORTAL_PATH,
        interface: SCREENSHOT,
        member: "Screenshot",
        signature: "sa{sv}",
        body: [
          "",
          {
            handle_token: new Variant("s", token),
            interactive: new Variant("b", false),
            modal: new Variant("b", false),
            target: new Variant("u", 8),
          },
        ],
      });
      const returnedHandle: unknown = reply.body[0];
      // Keep our predicted handle for Close if the service returns an invalid path.
      if (
        typeof returnedHandle !== "string" ||
        !returnedHandle.startsWith(namespace) ||
        !/^[A-Za-z0-9_]+$/.test(returnedHandle.slice(namespace.length))
      )
        throw new Error("Invalid screenshot request handle.");
      handle = returnedHandle;
      const body = await wait(
        new Promise<unknown>((resolve) => {
          deliver = resolve;
          if (responses.has(handle)) resolve(responses.get(handle));
        }),
        options.responseTimeoutMs ?? 120_000,
      );
      if (
        !Array.isArray(body) ||
        body.length !== 2 ||
        !isUInt(body[0]) ||
        !isRecord(body[1])
      )
        throw new Error("Invalid portal response.");
      completed = true;
      if (body[0] === 1) throw captureCancelled();
      if (body[0] !== 0)
        throw new Error("Your desktop did not allow the App Shot.");
      const uri: unknown = body[1].uri;
      if (
        !isRecord(uri) ||
        uri.signature !== "s" ||
        typeof uri.value !== "string"
      )
        throw new Error("Invalid screenshot URI.");
      return await readPortalPng(
        uri.value,
        options.createImage,
        options.signal,
      );
    } finally {
      bus.removeListener("message", listener);
      if (submitted && !completed) {
        // Best effort: preserve the original rejection even if the bus has died.
        try {
          bus.send(
            new Message({
              destination: sender,
              path: handle,
              interface: REQUEST,
              member: "Close",
              flags: MessageFlag.NO_REPLY_EXPECTED,
            }),
          );
        } catch {
          /* disconnected */
        }
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // A dedicated disconnect also drops the signal match and portal identity.
    // dbus-next can emit a queued transport error after disconnect. Replace the
    // operation closure with a no-op on this discarded, dedicated bus.
    bus.on("error", () => undefined);
    bus.removeListener("error", onError);
    bus.disconnect();
  }
}
