/**
 * GNOME capture transport adapted from T3 Code LinuxSnapShot.ts at
 * https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { EventEmitter } from "node:events";
import type { MessageBus, MessageLike } from "dbus-next";

export const GNOME_APP_SHOT_UUID = "app-shot@zenx.local";
export const GNOME_APP_SHOT_SERVICE = "org.gnome.Shell.Extensions.ZenXAppShot";
export const GNOME_APP_SHOT_PATH = "/org/gnome/Shell/Extensions/ZenXAppShot";
const DBUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** These are host constants, never a renderer-supplied app ID or bus name. */
export function gnomeAppShotClientName(development = false): string {
  return development
    ? "io.github.albert_zen.ZenX.Development.GnomeCapture"
    : "io.github.albert_zen.ZenX.GnomeCapture";
}

export interface GnomeAppShotImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width: number;
    height: number;
    quality: "best";
  }): GnomeAppShotImage;
  toPNG(): Buffer;
}
export interface GnomeAppShotOptions {
  /** Main-process configuration only. */
  development?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  excludedPids?: readonly number[];
}
export interface GnomeAppShotCapture {
  /** Caller owns these bounded, private bytes. No temporary file is created. */
  png: Buffer;
  width: number;
  height: number;
  /** Only compositor-supplied metadata; never inferred from the current focus. */
  window?: {
    title: string;
    appName: string;
    appIdentifier: string;
    processId: number;
    bounds: { x: number; y: number; width: number; height: number };
    accessibilityBoundsReliable: boolean;
  };
}
type DbusModule = Pick<
  typeof import("dbus-next"),
  "sessionBus" | "Message" | "NameFlag" | "RequestNameReply"
>;
export interface GnomeAppShotDependencies {
  loadDbus?: () => Promise<DbusModule>;
  createImage?: (png: Buffer) => GnomeAppShotImage;
  /** Inject deadlines, not duration policy, in synthetic transport tests. */
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
  /** Monotonic time boundary for synchronous image-work deadline tests. */
  now?: () => number;
}
export type GnomeAppShotSupport = {
  status:
    | "ready"
    | "unsupported-session"
    | "extension-unavailable"
    | "incompatible-version";
  interfaceVersion?: number;
};

export function isGnomeAppShotSession(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    !env.FLATPAK_ID &&
    !env.SNAP &&
    env.XDG_SESSION_TYPE === "wayland" &&
    Boolean(
      env.XDG_CURRENT_DESKTOP?.split(":").some(
        (name) => name.toLowerCase() === "gnome",
      ),
    )
  );
}
function aborted(): Error {
  const error = new Error("GNOME App Shot capture cancelled.");
  error.name = "AbortError";
  return error;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function unavailable(error: unknown): boolean {
  return (
    record(error) &&
    typeof error.type === "string" &&
    [
      "ServiceUnknown",
      "NameHasNoOwner",
      "UnknownObject",
      "UnknownInterface",
      "UnknownMethod",
    ].some((name) => error.type === `${DBUS}.Error.${name}`)
  );
}

/** One operation, one bus, one overall deadline including loading and decoding. */
async function withConnection<T>(
  options: GnomeAppShotOptions,
  dependencies: GnomeAppShotDependencies,
  operation: (connection: {
    call(message: MessageLike): Promise<import("dbus-next").Message>;
    claim(): Promise<void>;
    wait<V>(pending: Promise<V>): Promise<V>;
    check(): void;
  }) => Promise<T>,
): Promise<T> {
  if (options.signal?.aborted) throw aborted();
  const now = dependencies.now ?? (() => performance.now());
  const deadline = now() + 15_000;
  let bus: MessageBus | undefined;
  let failure: Error | undefined;
  let detach: (() => void) | undefined;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => undefined);
  const fail = (cause: unknown) => {
    if (failure) return;
    failure =
      cause instanceof Error ? cause : new Error("GNOME session bus failed.");
    rejectFailure(failure);
  };
  const check = () => {
    if (options.signal?.aborted) throw aborted();
    if (failure) throw failure;
    // A timer cannot run while native decode/resize blocks the JS thread.
    if (now() >= deadline) throw new Error("GNOME App Shot timed out.");
  };
  const abort = () => fail(aborted());
  options.signal?.addEventListener("abort", abort, { once: true });
  const schedule =
    dependencies.scheduleTimeout ??
    ((callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    });
  const cancelTimeout = schedule(
    () => fail(new Error("GNOME App Shot timed out.")),
    15_000,
  );
  const wait = async <V>(pending: Promise<V>): Promise<V> => {
    // Always observe pending even if a synchronous transport callback failed.
    const result = await Promise.race([pending, failed]);
    check();
    return result;
  };
  try {
    const dbus = await wait(
      (dependencies.loadDbus ?? (() => import("dbus-next")))(),
    );
    check();
    bus = dbus.sessionBus();
    bus.on("error", fail);
    // dbus-next 0.10.2 does not forward clean EOF on MessageBus.
    const connection: unknown = Reflect.get(bus, "_connection");
    const stream: unknown =
      connection instanceof EventEmitter
        ? Reflect.get(connection, "stream")
        : undefined;
    if (
      !(connection instanceof EventEmitter) ||
      !(stream instanceof EventEmitter)
    )
      throw new Error("Unsupported D-Bus transport lifecycle.");
    const ended = () => fail(new Error("GNOME session bus disconnected."));
    connection.on("end", ended);
    stream.on("close", ended);
    detach = () => {
      connection.removeListener("end", ended);
      stream.removeListener("close", ended);
    };
    const activeBus = bus;
    const result = await wait(
      operation({
        check,
        wait,
        call: async (message) => {
          check();
          const reply = await wait(activeBus.call(new dbus.Message(message)));
          if (!reply) throw new Error("GNOME returned no D-Bus reply.");
          if (
            message.destination?.startsWith(":") &&
            reply.sender !== message.destination
          )
            throw new Error("GNOME reply came from a different bus owner.");
          return reply;
        },
        claim: async () => {
          check();
          const result = await wait(
            activeBus.requestName(
              gnomeAppShotClientName(options.development),
              dbus.NameFlag.DO_NOT_QUEUE,
            ),
          );
          if (result !== dbus.RequestNameReply.PRIMARY_OWNER)
            throw new Error(
              "Another ZenX instance is capturing a GNOME window.",
            );
        },
      }),
    );
    check();
    return result;
  } finally {
    cancelTimeout();
    options.signal?.removeEventListener("abort", abort);
    detach?.();
    // Keep the error listener to consume late transport errors after disconnect.
    bus?.disconnect();
  }
}

type Connection = Parameters<Parameters<typeof withConnection>[2]>[0];
async function extension(
  connection: Connection,
): Promise<{ owner: string; version: number }> {
  const ownerReply = await connection.call({
    destination: DBUS,
    path: DBUS_PATH,
    interface: DBUS,
    member: "GetNameOwner",
    signature: "s",
    body: [GNOME_APP_SHOT_SERVICE],
  });
  const owner: unknown = ownerReply.body[0];
  if (typeof owner !== "string" || !/^:[0-9]+\.[0-9]+$/.test(owner))
    throw new Error("GNOME returned an invalid extension owner.");
  const reply = await connection.call({
    destination: owner,
    path: GNOME_APP_SHOT_PATH,
    interface: "org.freedesktop.DBus.Properties",
    member: "GetAll",
    signature: "s",
    body: [GNOME_APP_SHOT_SERVICE],
  });
  const properties: unknown = reply.body[0];
  if (
    !record(properties) ||
    !record(properties.Version) ||
    properties.Version.signature !== "u" ||
    !integer(properties.Version.value) ||
    properties.Version.value < 0 ||
    properties.Version.value > 0xffff_ffff
  )
    throw new Error("GNOME returned invalid extension properties.");
  return { owner, version: properties.Version.value };
}

/** Read-only capability probe: no capture, claim, installation, enable or settings write. */
export async function checkGnomeAppShotSupport(
  options: GnomeAppShotOptions = {},
  dependencies: GnomeAppShotDependencies = {},
): Promise<GnomeAppShotSupport> {
  if (options.signal?.aborted) throw aborted();
  if (!isGnomeAppShotSession(options.env))
    return { status: "unsupported-session" };
  return withConnection(options, dependencies, async (connection) => {
    const info = await extension(connection).catch((error: unknown) => {
      if (unavailable(error)) return undefined;
      throw error; // Denial, transport errors and malformed responses are not absence.
    });
    return info
      ? {
          status: info.version === 2 ? "ready" : "incompatible-version",
          interfaceVersion: info.version,
        }
      : { status: "extension-unavailable" };
  });
}

function decodeWindow(value: unknown): GnomeAppShotCapture["window"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value) > 64 * 1024)
    throw new Error("Invalid GNOME window metadata.");
  const window: unknown = JSON.parse(value);
  if (
    !record(window) ||
    ![window.title, window.appName, window.appIdentifier].every(
      (item) => typeof item === "string",
    ) ||
    !integer(window.processId) ||
    window.processId < 0 ||
    window.processId > 0xffff_ffff ||
    !record(window.bounds)
  )
    throw new Error("Invalid GNOME window metadata.");
  const { x, y, width, height } = window.bounds;
  if (
    ![x, y, width, height].every(integer) ||
    (width as number) <= 0 ||
    (height as number) <= 0
  )
    throw new Error("Invalid GNOME window bounds.");
  return {
    title: window.title as string,
    appName: window.appName as string,
    appIdentifier: window.appIdentifier as string,
    processId: window.processId,
    bounds: {
      x: x as number,
      y: y as number,
      width: width as number,
      height: height as number,
    },
    accessibilityBoundsReliable: window.processId > 0,
  };
}
function pngSize(
  png: Buffer,
  limit: number,
): { width: number; height: number } {
  if (
    png.length < 33 ||
    png.length > limit ||
    !png.subarray(0, 8).equals(PNG_HEADER) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Invalid or oversized GNOME screenshot.");
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 32_768 ||
    height > 32_768 ||
    width * height > 100_000_000
  )
    throw new Error("Invalid GNOME screenshot dimensions.");
  return { width, height };
}
async function normalizePng(
  bytes: unknown,
  dependencies: GnomeAppShotDependencies,
  connection: Connection,
): Promise<Pick<GnomeAppShotCapture, "png" | "width" | "height">> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PNG_BYTES)
    throw new Error("Invalid or oversized GNOME screenshot.");
  // Copy before decoding and again before returning: no bus/native buffer aliases escape.
  const png = Buffer.from(bytes);
  const original = pngSize(png, MAX_PNG_BYTES);
  const createImage =
    dependencies.createImage ??
    (await connection.wait(import("electron"))).nativeImage.createFromBuffer;
  connection.check();
  const image = createImage(png);
  connection.check();
  const size = image.getSize();
  if (
    image.isEmpty() ||
    size.width !== original.width ||
    size.height !== original.height
  )
    throw new Error("Invalid GNOME screenshot image.");
  const scale = Math.min(2_560 / size.width, 1_600 / size.height, 1);
  const output =
    scale < 1
      ? image
          .resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: "best",
          })
          .toPNG()
      : png;
  connection.check();
  const normalized = pngSize(output, MAX_OUTPUT_BYTES);
  if (normalized.width > 2_560 || normalized.height > 1_600)
    throw new Error("GNOME screenshot exceeds output dimensions.");
  return { png: Buffer.from(output), ...normalized };
}

/** Explicit capture only. No activation, feedback, accessibility read, persistence or fallback. */
export async function captureGnomeActiveAppShot(
  options: GnomeAppShotOptions = {},
  dependencies: GnomeAppShotDependencies = {},
): Promise<GnomeAppShotCapture> {
  if (options.signal?.aborted) throw aborted();
  if (!isGnomeAppShotSession(options.env))
    throw new Error("App Shot requires a host GNOME Wayland session.");
  return withConnection(options, dependencies, async (connection) => {
    const { owner, version } = await extension(connection);
    if (version !== 2)
      throw new Error("GNOME App Shot requires extension interface version 2.");
    await connection.claim();
    const reply = await connection.call({
      destination: owner,
      path: GNOME_APP_SHOT_PATH,
      interface: GNOME_APP_SHOT_SERVICE,
      member: "Capture",
    });
    const window = decodeWindow(reply.body[1]);
    if (
      window &&
      (window.processId === process.pid ||
        options.excludedPids?.includes(window.processId))
    )
      throw new Error("App Shot cannot capture its own application window.");
    const image = await normalizePng(reply.body[0], dependencies, connection);
    connection.check();
    return { ...image, ...(window ? { window } : {}) };
  });
}
