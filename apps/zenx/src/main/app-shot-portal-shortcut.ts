/**
 * Wayland GlobalShortcuts portal entry adapted from T3 Code:
 * https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot/PortalCaptureShortcut.ts
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
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Message, MessageBus, MessageLike, Variant } from "dbus-next";

const PORTAL = "org.freedesktop.portal.Desktop";
const PATH = "/org/freedesktop/portal/desktop";
const SHORTCUTS = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST = "org.freedesktop.portal.Request";
const SESSION = "org.freedesktop.portal.Session";
const DBUS = "org.freedesktop.DBus";
type DbusModule = Pick<
  typeof import("dbus-next"),
  "sessionBus" | "Message" | "MessageType" | "MessageFlag" | "Variant"
>;

export interface PortalAppShotShortcutState {
  readonly registered: boolean;
  /** Hyprland action registration does not establish that any keys are bound. */
  readonly actionRegistered?: boolean;
  /** Only the desktop's actual trigger_description, never the requested chord. */
  readonly shortcutDescription?: string;
  readonly canConfigure: boolean;
}
export interface PortalAppShotShortcutOptions {
  development?: boolean;
  /** Host-selected native Hyprland mode; never supplied by the renderer. */
  managedByHyprland?: boolean;
  signal?: AbortSignal;
  isCurrentOwner(): boolean;
  onCapture(): void;
  /** Live failures only; initial setup failures reject the start promise. */
  onFailure(error: Error): void;
  onStateChanged?(state: PortalAppShotShortcutState): void;
}
export interface PortalAppShotShortcutHandle extends PortalAppShotShortcutState {
  stop(): void;
  /** May open a desktop dialog. Call only for an explicit user settings action. */
  configure(): Promise<void>;
}
export interface PortalAppShotShortcutDependencies {
  loadDbus?: () => Promise<DbusModule>;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
  /** Flatpak/Snap already supply identity. Production reads the environment. */
  sandboxed?: boolean;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringVariant(value: unknown): string {
  if (
    !record(value) ||
    value.signature !== "s" ||
    typeof value.value !== "string"
  )
    throw new Error("Invalid shortcut portal string.");
  return value.value;
}
function cancelled(): Error {
  return Object.assign(new Error("App Shot shortcut registration cancelled."), {
    name: "AbortError",
  });
}

/**
 * Explicit user opt-in only: this function can open the desktop consent prompt.
 * Importing the module has no native side effects. No Electron fallback, native
 * capture, automatic retry, configuration edit, or message send is performed.
 */
export async function startPortalAppShotShortcut(
  options: PortalAppShotShortcutOptions,
  dependencies: PortalAppShotShortcutDependencies = {},
): Promise<PortalAppShotShortcutHandle> {
  let closed = false;
  let ready = false;
  let registered = false;
  let actionRegistered = false;
  let shortcutDescription: string | undefined;
  let bus: MessageBus | undefined;
  let dbus: DbusModule | undefined;
  let detachTransport: (() => void) | undefined;
  let owner = "";
  let namespace = "";
  let session = "";
  let version = 0;
  let pending: { path: string; resolve?: (body: unknown) => void } | undefined;
  const responses = new Map<string, unknown>();
  const appId = options.development
    ? "io.github.albert_zen.ZenX.Development"
    : "io.github.albert_zen.ZenX";
  const managedByHyprland = options.managedByHyprland === true;
  const trigger = "CTRL+SHIFT+2";
  const shortcutId = managedByHyprland
    ? "capture-window"
    : `zen-app-shot-${createHash("sha256")
        .update(appId + ":" + trigger)
        .digest("hex")
        .slice(0, 16)}`;
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  void stopped.catch(() => undefined);
  const owns = () => {
    try {
      return !options.signal?.aborted && options.isCurrentOwner();
    } catch {
      return false;
    }
  };
  const current = () => !closed && owns();
  const assertCurrent = () => {
    if (!current())
      throw options.signal?.aborted
        ? cancelled()
        : new Error("App Shot shortcut owner is no longer current.");
  };
  const closeObject = (path: string, iface: string) => {
    if (!owner || !bus || !dbus || !path) return;
    try {
      bus.send(
        new dbus.Message({
          destination: owner,
          path,
          interface: iface,
          member: "Close",
          flags: dbus.MessageFlag.NO_REPLY_EXPECTED,
        }),
      );
    } catch {
      /* Still release the other objects and the connection. */
    }
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    registered = false;
    actionRegistered = false;
    shortcutDescription = undefined;
    rejectStopped(cancelled());
    options.signal?.removeEventListener("abort", stop);
    if (pending) closeObject(pending.path, REQUEST);
    closeObject(session, SESSION);
    responses.clear();
    detachTransport?.();
    bus?.removeListener("message", message);
    // Keep the error listener to absorb late errors from the ending transport.
    try {
      bus?.disconnect();
    } catch {
      /* Already disconnected. */
    }
  };
  const fail = (error: unknown) => {
    if (closed) return;
    const notify = ready && current();
    const cause =
      error instanceof Error
        ? error
        : new Error("App Shot shortcut portal failed.");
    rejectStopped(cause);
    stop();
    if (notify && owns()) {
      try {
        options.onFailure(cause);
      } catch {
        /* Cannot revive a closed owner. */
      }
    }
  };
  const schedule =
    dependencies.scheduleTimeout ??
    ((callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    });
  const wait = async <T>(
    promise: Promise<T>,
    milliseconds = 5_000,
  ): Promise<T> => {
    assertCurrent();
    let cancel: (() => void) | undefined;
    try {
      const result = await Promise.race([
        promise,
        stopped,
        new Promise<never>((_, reject) => {
          cancel = schedule(
            () =>
              reject(
                new Error("App Shot shortcut permission request timed out."),
              ),
            milliseconds,
          );
        }),
      ]);
      assertCurrent();
      return result;
    } finally {
      cancel?.();
    }
  };
  const call = async (data: MessageLike): Promise<Message> => {
    assertCurrent();
    const reply = await wait(bus!.call(new dbus!.Message(data)));
    if (!reply) throw new Error("Missing shortcut portal reply.");
    return reply;
  };
  const state = (): PortalAppShotShortcutState => ({
    registered,
    ...(managedByHyprland ? { actionRegistered } : {}),
    shortcutDescription,
    canConfigure:
      !managedByHyprland && current() && Boolean(session) && version >= 2,
  });
  const bound = (shortcuts: unknown) => {
    if (!Array.isArray(shortcuts))
      throw new Error("Invalid shortcut portal bindings.");
    let matching = false;
    let description: string | undefined;
    for (const entry of shortcuts) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !record(entry[1])
      )
        throw new Error("Invalid shortcut portal binding.");
      if (entry[0] === shortcutId) {
        matching = true;
        if (entry[1].trigger_description !== undefined)
          description =
            stringVariant(entry[1].trigger_description).trim() || undefined;
      }
    }
    // xdg-desktop-portal-hyprland registers an action, not a verified key chord.
    // Users must add the matching global binding to their Hyprland config.
    actionRegistered = managedByHyprland && matching;
    shortcutDescription = managedByHyprland ? undefined : description;
    registered = !managedByHyprland && Boolean(description);
    if (ready) options.onStateChanged?.(state());
  };
  function message(event: Message) {
    if (closed || event.type !== dbus?.MessageType.SIGNAL) return;
    if (!current()) {
      stop();
      return;
    }
    try {
      if (
        event.sender === DBUS &&
        event.path === "/org/freedesktop/DBus" &&
        event.interface === DBUS &&
        event.member === "NameOwnerChanged" &&
        event.body[0] === PORTAL &&
        event.body[1] === owner
      ) {
        fail(
          new Error(
            "The desktop shortcut service restarted. Enable App Shot again.",
          ),
        );
        return;
      }
      if (!owner || event.sender !== owner) return;
      if (
        pending &&
        event.interface === REQUEST &&
        event.member === "Response" &&
        event.signature === "ua{sv}" &&
        event.path.startsWith(namespace)
      ) {
        if (pending.resolve && event.path === pending.path)
          pending.resolve(event.body);
        else if (responses.size < 8) responses.set(event.path, event.body);
        return;
      }
      if (
        session &&
        event.path === session &&
        event.interface === SESSION &&
        event.member === "Closed"
      ) {
        fail(new Error("Your desktop closed the App Shot shortcut."));
        return;
      }
      if (
        !session ||
        event.path !== PATH ||
        event.interface !== SHORTCUTS ||
        event.body[0] !== session
      )
        return;
      if (
        event.member === "Activated" &&
        event.signature === "osta{sv}" &&
        event.body[1] === shortcutId &&
        ready &&
        (registered || actionRegistered)
      )
        options.onCapture();
      if (
        event.member === "ShortcutsChanged" &&
        event.signature === "oa(sa{sv})"
      )
        bound(event.body[1]);
    } catch (error) {
      fail(error);
    }
  }
  const validHandle = (handle: unknown, prefix: string): handle is string =>
    typeof handle === "string" &&
    handle.startsWith(prefix) &&
    /^[A-Za-z0-9_]+$/.test(handle.slice(prefix.length));
  const request = async (
    member: string,
    signature: string,
    body: unknown[],
    extra: Record<string, Variant<unknown>> = {},
  ) => {
    const token = `zen_${randomUUID().replaceAll("-", "")}`;
    pending = { path: namespace + token };
    responses.clear();
    let complete = false;
    try {
      const reply = await call({
        destination: owner,
        path: PATH,
        interface: SHORTCUTS,
        member,
        signature: signature + "a{sv}",
        body: [
          ...body,
          { ...extra, handle_token: new dbus!.Variant("s", token) },
        ],
      });
      const handle: unknown = reply.body[0];
      if (!validHandle(handle, namespace))
        throw new Error("Invalid shortcut request handle.");
      pending.path = handle;
      const response = responses.has(handle)
        ? responses.get(handle)
        : await wait(
            new Promise<unknown>((resolve) => {
              pending!.resolve = resolve;
            }),
            member === "BindShortcuts" ? 120_000 : 5_000,
          );
      if (
        !Array.isArray(response) ||
        response.length !== 2 ||
        !Number.isInteger(response[0]) ||
        !record(response[1])
      )
        throw new Error("Invalid shortcut portal response.");
      complete = true;
      if (response[0] !== 0) {
        if (member === "BindShortcuts") {
          registered = false;
          actionRegistered = false;
          shortcutDescription = undefined;
          return undefined;
        }
        throw new Error(
          "Your desktop did not create an App Shot shortcut session.",
        );
      }
      return response[1];
    } finally {
      if (!complete && !closed && pending) closeObject(pending.path, REQUEST);
      pending = undefined;
      responses.clear();
    }
  };

  assertCurrent();
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    dbus = await wait((dependencies.loadDbus ?? (() => import("dbus-next")))());
    bus = dbus.sessionBus();
    bus.on("error", fail);
    bus.on("message", message);
    // dbus-next 0.10.2 does not forward clean EOF as a public bus event.
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
    const ended = () => fail(new Error("App Shot session bus disconnected."));
    connection.on("end", ended);
    stream.on("close", ended);
    detachTransport = () => {
      connection.removeListener("end", ended);
      stream.removeListener("close", ended);
    };
    if (!(
      dependencies.sandboxed ??
      Boolean(process.env.FLATPAK_ID || process.env.SNAP)
    )) {
      await call({
        destination: PORTAL,
        path: PATH,
        interface: "org.freedesktop.host.portal.Registry",
        member: "Register",
        signature: "sa{sv}",
        body: [appId, {}],
      }).catch((error: unknown) => {
        if (!(
          record(error) &&
          [
            DBUS + ".Error.UnknownMethod",
            DBUS + ".Error.UnknownInterface",
          ].includes(String(error.type))
        ))
          throw error;
      });
    }
    const ownerCall: MessageLike = {
      destination: DBUS,
      path: "/org/freedesktop/DBus",
      interface: DBUS,
      member: "GetNameOwner",
      signature: "s",
      body: [PORTAL],
    };
    const reply = await call(ownerCall);
    if (
      typeof reply.body[0] !== "string" ||
      !/^:[0-9]+\.[0-9]+$/.test(reply.body[0]) ||
      typeof reply.destination !== "string" ||
      !/^:[0-9]+\.[0-9]+$/.test(reply.destination)
    )
      throw new Error("Invalid shortcut service identity.");
    owner = reply.body[0];
    namespace = `${PATH}/request/${reply.destination.slice(1).replaceAll(".", "_")}/`;
    for (const rule of [
      `type='signal',sender='${owner}',path_namespace='${PATH}'`,
      `type='signal',sender='org.freedesktop.DBus',interface='${DBUS}',member='NameOwnerChanged',arg0='${PORTAL}'`,
    ])
      await call({
        destination: DBUS,
        path: "/org/freedesktop/DBus",
        interface: DBUS,
        member: "AddMatch",
        signature: "s",
        body: [rule],
      });
    if ((await call(ownerCall)).body[0] !== owner)
      throw new Error("The desktop shortcut service changed during setup.");
    const value: unknown = (
      await call({
        destination: owner,
        path: PATH,
        interface: DBUS + ".Properties",
        member: "Get",
        signature: "ss",
        body: [SHORTCUTS, "version"],
      })
    ).body[0];
    if (
      !record(value) ||
      value.signature !== "u" ||
      typeof value.value !== "number" ||
      !Number.isInteger(value.value) ||
      value.value < 1
    )
      throw new Error("Unsupported shortcut portal version.");
    version = value.value;
    const sessionToken = `zen_capture_${randomUUID().replaceAll("-", "")}`;
    const sessionNamespace = namespace.replace("/request/", "/session/");
    // Own the predicted session even while CreateSession's method reply is pending.
    session = sessionNamespace + sessionToken;
    const created = await request("CreateSession", "", [], {
      session_handle_token: new dbus.Variant("s", sessionToken),
    });
    const handle = stringVariant(created?.session_handle);
    if (!validHandle(handle, sessionNamespace))
      throw new Error("Invalid shortcut session handle.");
    session = handle;
    const result = await request("BindShortcuts", "oa(sa{sv})s", [
      session,
      [
        [
          shortcutId,
          {
            description: new dbus.Variant("s", "Capture a window"),
            ...(!managedByHyprland
              ? { preferred_trigger: new dbus.Variant("s", trigger) }
              : {}),
          },
        ],
      ],
      "",
    ]);
    if (result) {
      const shortcuts = result.shortcuts;
      if (!record(shortcuts) || shortcuts.signature !== "a(sa{sv})")
        throw new Error("Invalid shortcut portal bindings result.");
      bound(shortcuts.value);
    }
    assertCurrent();
    ready = true;
    return {
      stop,
      get registered() {
        return current() && registered;
      },
      get actionRegistered() {
        return managedByHyprland ? current() && actionRegistered : undefined;
      },
      get shortcutDescription() {
        return current() ? shortcutDescription : undefined;
      },
      get canConfigure() {
        return state().canConfigure;
      },
      async configure() {
        try {
          assertCurrent();
          if (managedByHyprland)
            throw new Error(
              "Change the App Shot binding in your Hyprland config, then save it.",
            );
          if (version < 2)
            throw new Error(
              "Choose the App Shot shortcut in your desktop's shortcut settings.",
            );
          await call({
            destination: owner,
            path: PATH,
            interface: SHORTCUTS,
            member: "ConfigureShortcuts",
            signature: "osa{sv}",
            body: [session, "", {}],
          });
        } catch (error) {
          // Unsupported explicit settings is not a dead transport/session.
          if ((!managedByHyprland && version >= 2) || !current()) fail(error);
          throw error;
        }
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
