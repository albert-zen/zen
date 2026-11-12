/**
 * Niri session-bus capture entry adapted from T3 Code:
 * https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot/NiriCaptureShortcut.ts
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
import { EventEmitter } from "node:events";
import type { Message, MessageBus } from "dbus-next";

export interface NiriAppShotIdentity {
  readonly busName: string;
  readonly interfaceName: string;
  readonly objectPath: string;
}

const PRODUCTION: NiriAppShotIdentity = Object.freeze({
  busName: "io.github.albert_zen.ZenX.AppShot",
  interfaceName: "io.github.albert_zen.ZenX.AppShot",
  objectPath: "/io/github/albert_zen/ZenX/AppShot",
});
const DEVELOPMENT: NiriAppShotIdentity = Object.freeze({
  busName: "io.github.albert_zen.ZenX.Development.AppShot",
  interfaceName: "io.github.albert_zen.ZenX.Development.AppShot",
  objectPath: "/io/github/albert_zen/ZenX/Development/AppShot",
});

export function niriAppShotIdentity(development = false): NiriAppShotIdentity {
  return development ? DEVELOPMENT : PRODUCTION;
}

/**
 * Manual Niri configuration text only. Registering the session-bus action does
 * not reserve these keys, write configuration, or install this binding.
 * Fixed identifiers and individually quoted spawn arguments avoid a shell.
 */
export function niriAppShotBinding(development = false): string {
  const identity = niriAppShotIdentity(development);
  const args = [
    "gdbus",
    "call",
    "--session",
    "--dest",
    identity.busName,
    "--object-path",
    identity.objectPath,
    "--method",
    identity.interfaceName + ".Capture",
  ]
    .map((argument) => JSON.stringify(argument))
    .join(" ");
  return "Ctrl+Shift+2 repeat=false { spawn " + args + "; }";
}

type DbusModule = Pick<
  typeof import("dbus-next"),
  "sessionBus" | "Message" | "MessageType" | "NameFlag" | "RequestNameReply"
>;

export interface NiriAppShotShortcutOptions {
  development?: boolean;
  signal?: AbortSignal;
  /** Host-owned composer/session fence; do not accept a renderer callback. */
  isCurrentOwner(): boolean;
  /** Dispatch only; the host owns capture cancellation and error handling. */
  onCapture(): void;
  /** A live registration failed. Startup failures reject the start promise. */
  onFailure(error: Error): void;
}

export interface NiriAppShotShortcutDependencies {
  /** Lazy so other platforms and unarmed composers never load dbus-next. */
  loadDbus?: () => Promise<DbusModule>;
  /** Tests can drive the fixed 5-second registration timeout deterministically. */
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Niri App Shot failed.");
}

function cancelled(): Error {
  const error = new Error("Niri App Shot shortcut registration cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * Register only the explicit session-bus Capture action. A user-managed Niri
 * binding invokes it; any same-session process can also call the bus method.
 * The owner fence is required, and this is not proof of a physical key press.
 */
export async function startNiriAppShotShortcut(
  options: NiriAppShotShortcutOptions,
  dependencies: NiriAppShotShortcutDependencies = {},
): Promise<{ stop(): void }> {
  if (options.signal?.aborted) throw cancelled();
  if (!options.isCurrentOwner())
    throw new Error("Niri App Shot owner is no longer current.");

  const identity = niriAppShotIdentity(options.development);
  let bus: MessageBus | undefined;
  let detachTransport: (() => void) | undefined;
  let handler: ((message: Message) => boolean) | undefined;
  let closed = false;
  let registered = false;
  let cancelTimeout: (() => void) | undefined;
  let rejectFailure: (error: Error) => void = () => undefined;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  // Bus failures can arrive after startup has resolved or cancellation won.
  void failure.catch(() => undefined);

  const ownsRequest = () => {
    if (options.signal?.aborted) return false;
    try {
      return options.isCurrentOwner();
    } catch {
      return false;
    }
  };
  const currentOwner = () => !closed && ownsRequest();
  const close = () => {
    if (closed) return;
    closed = true;
    registered = false;
    cancelTimeout?.();
    cancelTimeout = undefined;
    options.signal?.removeEventListener("abort", abort);
    detachTransport?.();
    detachTransport = undefined;
    if (bus) {
      if (handler) bus.removeMethodHandler(handler);
      // Keep the error listener to absorb late errors from the ending stream.
      bus.disconnect();
    }
  };
  const fail = (error: unknown) => {
    if (closed) return;
    const notify = registered && currentOwner();
    const cause = asError(error);
    rejectFailure(cause);
    close();
    if (notify && ownsRequest()) {
      try {
        options.onFailure(cause);
      } catch {
        // Notification cannot revive a closed registration or escape the bus.
      }
    }
  };
  const abort = () => {
    rejectFailure(cancelled());
    close();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const dbus = await Promise.race([
      (dependencies.loadDbus ?? (() => import("dbus-next")))(),
      failure,
    ]);
    if (!currentOwner())
      throw options.signal?.aborted
        ? cancelled()
        : new Error("Niri App Shot owner is no longer current.");
    bus = dbus.sessionBus();
    const activeBus = bus;
    bus.on("error", fail);
    // Pinned dbus-next 0.10.2 forwards error, but not clean connection EOF.
    // Observe its exact transport without changing the reviewed T3 patch.
    const connection: unknown = Reflect.get(bus, "_connection");
    const stream: unknown =
      connection instanceof EventEmitter
        ? Reflect.get(connection, "stream")
        : undefined;
    if (
      !(connection instanceof EventEmitter) ||
      !(stream instanceof EventEmitter)
    )
      throw new Error("Unsupported D-Bus transport lifecycle");
    const ended = () =>
      fail(new Error("Niri App Shot session bus disconnected."));
    connection.on("end", ended);
    stream.on("close", ended);
    detachTransport = () => {
      connection.removeListener("end", ended);
      stream.removeListener("close", ended);
    };

    const replyError = (message: Message, name: string, text: string) => {
      // dbus-next 0.10.2's newError declaration incorrectly accepts a string.
      // Its method-return factory preserves the numeric reply serial.
      const reply = dbus.Message.newMethodReturn(message, "s", [text]);
      reply.type = dbus.MessageType.ERROR;
      reply.errorName = name;
      activeBus.send(reply);
    };
    handler = (message: Message) => {
      if (
        message.path !== identity.objectPath ||
        message.interface !== identity.interfaceName ||
        message.member !== "Capture"
      )
        return false;
      if (closed) return true;
      try {
        if (
          message.signature ||
          !Array.isArray(message.body) ||
          message.body.length
        ) {
          replyError(
            message,
            "org.freedesktop.DBus.Error.InvalidArgs",
            "Capture takes no arguments.",
          );
          return true;
        }
        if (!registered || !currentOwner()) {
          replyError(
            message,
            "org.freedesktop.DBus.Error.AccessDenied",
            "App Shot is not armed for this composer.",
          );
          if (registered) close();
          return true;
        }
        options.onCapture();
        if (!closed) activeBus.send(dbus.Message.newMethodReturn(message));
      } catch (error) {
        fail(error);
      }
      return true;
    };
    bus.addMethodHandler(handler);
    const schedule =
      dependencies.scheduleTimeout ??
      ((callback: () => void, milliseconds: number) => {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      });
    cancelTimeout = schedule(
      () => fail(new Error("Niri App Shot shortcut registration timed out.")),
      5_000,
    );
    const result = await Promise.race([
      bus.requestName(identity.busName, dbus.NameFlag.DO_NOT_QUEUE),
      failure,
    ]);
    if (result !== dbus.RequestNameReply.PRIMARY_OWNER)
      throw new Error("Another ZenX instance owns the Niri App Shot action.");
    if (!currentOwner())
      throw options.signal?.aborted
        ? cancelled()
        : new Error("Niri App Shot owner is no longer current.");
    registered = true;
    return { stop: close };
  } catch (error) {
    close();
    throw error;
  } finally {
    cancelTimeout?.();
    cancelTimeout = undefined;
  }
}
