import "./dom-primitives.js";
/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const bootstrap = new JSDOM('<div id="root"></div>', {
  url: "https://zenx.local/",
});
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { FleetSettings } = await import("../src/renderer/src/FleetSettings.js");
type Snapshot =
  import("../src/renderer/src/FleetSettings.js").FleetSettingsSnapshot;
type Api = import("../src/renderer/src/FleetSettings.js").FleetSettingsApi;

const sshDevice = {
  id: "build",
  label: "Build machine",
  sshHost: "build.example",
  command: ["node", "/app/fleet-bridge.js", "/app/connection.json"],
  access: "read" as const,
};

async function mount(
  overrides: Partial<Api> = {},
  devices: Snapshot["config"]["devices"] = [sshDevice],
  initial?: Partial<Snapshot>,
  beforeRender?: (dom: JSDOM) => void,
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });
  let snapshot: Snapshot = {
    revision: 1,
    config: { version: 1, devices },
    host: { enabled: false, hostId: "host-local", clients: [] },
    ...initial,
  };
  const saved: Parameters<Api["save"]>[0][] = [];
  const removed: string[] = [];
  const paired: Parameters<Api["pair"]>[0][] = [];
  const calls: Parameters<Api["invoke"]>[0][] = [];
  const api: Api = {
    status: async () => structuredClone(snapshot),
    save: async (config, revision) => {
      assert.equal(revision, snapshot.revision);
      saved.push(structuredClone(config));
      const publicConfig: Snapshot["config"] = { ...config };
      if (config.hosting) {
        const { relayRegistrationToken: _secret, ...hosting } = config.hosting;
        publicConfig.hosting = hosting;
      }
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        config: publicConfig,
      };
    },
    remove: async (id) => {
      removed.push(id);
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        config: {
          ...snapshot.config,
          devices: snapshot.config.devices.filter((device) => device.id !== id),
        },
      };
    },
    pair: async (input) => {
      paired.push(input);
      const { code: _code, ...device } = input;
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        config: {
          ...snapshot.config,
          devices: [
            ...snapshot.config.devices,
            { ...device, transport: "https" },
          ],
        },
      };
    },
    test: async () => ({ ok: true }),
    invoke: async (input) => {
      calls.push(input);
      return { device: input.device, result: {} };
    },
    hostPair: async () => ({
      hostId: "host-local",
      code: "ONE-TIME",
      expiresAt: "2026-10-01T10:00:00Z",
    }),
    revoke: async () => {},
    ...overrides,
  };
  Object.defineProperty(dom.window, "zenx", { value: { fleet: api } });
  beforeRender?.(dom);
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(React.createElement(FleetSettings)));
  const button = (label: string) => {
    const found = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (entry) =>
        entry.getAttribute("aria-label") === label ||
        entry.textContent?.trim() === label,
    );
    assert.ok(found, `Missing button: ${label}`);
    return found;
  };
  const input = (label: string) => {
    const found = [...document.querySelectorAll("label")]
      .find(
        (entry) => entry.querySelector("span")?.textContent?.trim() === label,
      )
      ?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
    assert.ok(found, `Missing input: ${label}`);
    return found;
  };
  const close = async () => {
    await act(async () => root.unmount());
    dom.window.close();
  };
  return {
    dom,
    button,
    input,
    saved,
    removed,
    paired,
    calls,
    close,
    getSnapshot: () => snapshot,
  };
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
    await Promise.resolve();
  });
}
async function fill(
  node: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    node.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function choose(label: string, value: string) {
  const trigger = [...document.querySelectorAll("label")]
    .find((entry) => entry.querySelector("span")?.textContent?.trim() === label)
    ?.querySelector<HTMLButtonElement>("button.ui-select");
  assert.ok(trigger, `Missing select: ${label}`);
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((entry) => entry.dataset.value === value);
  assert.ok(option, `Missing option: ${value}`);
  await act(async () => {
    option.focus();
    option.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

test("Host status failure without a clients array keeps Fleet visible and can recover on refresh", async () => {
  let unavailable = true;
  const view = await mount({
    status: async () =>
      ({
        revision: 1,
        config: { version: 1, devices: [sshDevice] },
        host: unavailable
          ? {
              enabled: false,
              hostId: "host-local",
              error: "Host status connection is unavailable",
            }
          : { enabled: false, hostId: "host-local", clients: [] },
      }) as Snapshot,
  });
  try {
    assert.match(document.body.textContent ?? "", /Host this device/u);
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Host status connection is unavailable/u,
    );
    assert.equal(view.button("Add device").disabled, false);
    assert.match(document.body.textContent ?? "", /Build machine/u);
    unavailable = false;
    await click(view.button("Refresh Fleet"));
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.match(document.body.textContent ?? "", /No paired clients/u);
    assert.equal(view.saved.length, 0);
  } finally {
    await view.close();
  }
});

test("Android-facing endpoint requires explicit hosting consent and survives configuration refresh", async () => {
  const hosting = {
    enabled: true,
    bindAddress: "127.0.0.1",
    port: 9443,
    tlsCertificateFile: "/tls/certificate.pem",
    tlsKeyFile: "/tls/private-key.pem",
    access: "read" as const,
  };
  const view = await mount({}, [sshDevice], {
    config: { version: 1, devices: [sshDevice], hosting },
  });
  try {
    await fill(
      view.input("Android-facing HTTPS endpoint"),
      "https://device.example:9443",
    );
    assert.match(
      document.body.textContent ?? "",
      /certificate SAN.*explicit port.*Origin-absent/su,
    );
    assert.equal(view.button("Apply hosting").disabled, true);
    const consent = [...document.querySelectorAll("label")].find((entry) =>
      entry.textContent?.includes("I allow this Host to listen"),
    );
    assert.ok(consent);
    assert.match(consent.textContent ?? "", /https:\/\/device.example:9443/u);
    await click(
      consent.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
    );
    await click(view.button("Apply hosting"));
    assert.equal(
      view.saved[0]!.hosting!.originEndpoint,
      "https://device.example:9443",
    );
    await click(view.button("Refresh Fleet"));
    assert.equal(
      view.input("Android-facing HTTPS endpoint").value,
      "https://device.example:9443",
    );
  } finally {
    await view.close();
  }
});

test("Fleet adds an SSH route, rereads configuration, and removes only the named route", async () => {
  const view = await mount();
  try {
    await click(view.button("Add device"));
    await fill(view.input("Device ID"), "laptop");
    await fill(view.input("Label"), "My laptop");
    await fill(view.input("SSH host"), "me@laptop.example");
    await fill(
      view.input("Command arguments (one per line)"),
      "node\n/zen/fleet-bridge.js\n/zen/connection.json",
    );
    await click(view.button("Save device"));
    assert.equal(view.saved.length, 1);
    assert.deepEqual(view.saved[0]!.devices[1], {
      id: "laptop",
      label: "My laptop",
      sshHost: "me@laptop.example",
      command: ["node", "/zen/fleet-bridge.js", "/zen/connection.json"],
      access: "read",
      transport: "ssh",
    });
    assert.match(document.body.textContent ?? "", /My laptop/u);
    await click(view.button("Remove My laptop"));
    assert.equal(view.removed.length, 0);
    await click(view.button("Remove device"));
    assert.deepEqual(view.removed, ["laptop"]);
    assert.match(document.body.textContent ?? "", /Build machine/u);
    assert.doesNotMatch(document.body.textContent ?? "", /My laptop/u);
  } finally {
    await view.close();
  }
});

test("Fleet editor Cancel and Escape discard changes and restore the initiating button", async () => {
  const view = await mount();
  try {
    await click(view.button("Edit Build machine"));
    await fill(view.input("Label"), "Changed label");
    await click(view.button("Cancel"));
    assert.equal(view.saved.length, 0);
    assert.equal(document.activeElement, view.button("Edit Build machine"));
    await click(view.button("Add device"));
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(view.saved.length, 0);
    assert.equal(document.activeElement, view.button("Add device"));
    assert.equal(document.querySelector('[aria-label="Device editor"]'), null);
  } finally {
    await view.close();
  }
});

test("Failed connection is visible and can be retried without changing a device", async () => {
  let checks = 0;
  const view = await mount({
    test: async () => {
      if (++checks === 1) throw new Error("SSH host unreachable");
      return { ok: true };
    },
  });
  try {
    await click(view.button("Test Build machine"));
    assert.match(
      document.body.textContent ?? "",
      /Connection failed.*SSH host unreachable/su,
    );
    await click(view.button("Test Build machine"));
    assert.match(document.body.textContent ?? "", /Connected/u);
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(view.saved.length, 0);
  } finally {
    await view.close();
  }
});

test("HTTPS pairing passes a transient code without saving it in the public configuration", async () => {
  const view = await mount();
  try {
    await click(view.button("Add device"));
    await choose("Connection", "https");
    await fill(view.input("Device ID"), "desktop");
    await fill(view.input("Label"), "Home desktop");
    await fill(view.input("HTTPS endpoint"), "https://desktop.example:3940");
    await fill(view.input("Remote Host ID"), "host-desktop");
    await fill(view.input("One-time pairing code"), "TEMPORARY-CODE");
    await click(view.button("Pair device"));
    assert.deepEqual(view.paired, [
      {
        id: "desktop",
        label: "Home desktop",
        endpoint: "https://desktop.example:3940",
        hostId: "host-desktop",
        code: "TEMPORARY-CODE",
        access: "read",
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(view.getSnapshot()),
      /TEMPORARY-CODE|token/u,
    );
    assert.equal(
      document.querySelector(
        '[aria-label="Device editor"] input[type="password"]',
      ),
      null,
    );
    assert.match(document.body.textContent ?? "", /Device paired/u);
    await click(view.button("Edit Home desktop"));
    assert.equal(view.input("HTTPS endpoint").disabled, true);
    assert.equal(view.input("Remote Host ID").disabled, true);
    await click(view.button("Cancel"));
  } finally {
    await view.close();
  }
});

test("Remote control is not saved until its explicit acknowledgment is checked", async () => {
  const view = await mount();
  try {
    await click(view.button("Edit Build machine"));
    await choose("Access", "control");
    assert.equal(view.button("Save device").disabled, true);
    const acknowledgment = document.querySelector<HTMLInputElement>(
      '[aria-label="Device editor"] input[type="checkbox"]',
    );
    assert.ok(acknowledgment);
    await click(acknowledgment);
    await click(view.button("Save device"));
    assert.equal(view.saved[0]!.devices[0]!.access, "control");
  } finally {
    await view.close();
  }
});

test("HTTPS hosting requires exposure and control acknowledgment; discarding and disabling are safe", async () => {
  const view = await mount();
  try {
    const enabled = [...document.querySelectorAll("label")]
      .find((entry) => entry.textContent?.includes("Enable HTTPS hosting"))
      ?.querySelector<HTMLInputElement>("input");
    assert.ok(enabled);
    await click(enabled);
    await fill(view.input("Bind address"), "0.0.0.0");
    await fill(view.input("Port"), "9443");
    await fill(view.input("TLS certificate file"), "/tls/certificate.pem");
    await fill(view.input("TLS private key file"), "/tls/private-key.pem");
    await choose("Maximum client access", "control");
    assert.equal(view.button("Apply hosting").disabled, true);
    const checkbox = (text: string) => {
      const value = [...document.querySelectorAll("label")]
        .find((entry) => entry.textContent?.includes(text))
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      assert.ok(value, `Missing acknowledgment: ${text}`);
      return value;
    };
    await click(checkbox("I allow this Host to listen"));
    assert.equal(view.button("Apply hosting").disabled, true);
    await click(checkbox("I allow paired clients with control access"));
    await click(view.button("Apply hosting"));
    assert.deepEqual(view.saved[0]!.hosting, {
      enabled: true,
      bindAddress: "0.0.0.0",
      port: 9443,
      tlsCertificateFile: "/tls/certificate.pem",
      tlsKeyFile: "/tls/private-key.pem",
      access: "control",
    });
    await fill(view.input("Port"), "9444");
    assert.equal(view.button("Apply hosting").disabled, true);
    await click(view.button("Discard changes"));
    assert.equal(view.input("Port").value, "9443");
    await click(enabled);
    assert.equal(view.button("Apply hosting").disabled, false);
    await click(view.button("Apply hosting"));
    assert.equal(view.saved.at(-1)!.hosting!.enabled, false);
  } finally {
    await view.close();
  }
});

test("Hosted pairing code can be hidden and a named client can be revoked independently", async () => {
  const revoked: string[] = [];
  let status: Snapshot = {
    revision: 1,
    config: {
      version: 1,
      devices: [],
      hosting: {
        enabled: true,
        bindAddress: "127.0.0.1",
        port: 3940,
        tlsCertificateFile: "/tls/cert.pem",
        tlsKeyFile: "/tls/key.pem",
        access: "read",
      },
    },
    host: {
      enabled: true,
      hostId: "host-local",
      url: "https://localhost:3940",
      clients: [
        {
          deviceId: "phone",
          label: "My phone",
          access: "read",
          revoked: false,
        },
        {
          deviceId: "laptop",
          label: "My laptop",
          access: "read",
          revoked: false,
        },
      ],
    },
  };
  const view = await mount({
    status: async () => status,
    revoke: async (id) => {
      revoked.push(id);
      status = {
        ...status,
        host: {
          ...status.host,
          clients: status.host.clients.map((entry) =>
            entry.deviceId === id ? { ...entry, revoked: true } : entry,
          ),
        },
      };
    },
  });
  try {
    await click(view.button("Create pairing code"));
    assert.match(document.body.textContent ?? "", /ONE-TIME/u);
    await click(view.button("Hide code"));
    assert.doesNotMatch(document.body.textContent ?? "", /ONE-TIME/u);
    await click(view.button("Revoke My phone"));
    assert.deepEqual(revoked, []);
    await click(view.button("Revoke client"));
    assert.deepEqual(revoked, ["phone"]);
    assert.equal(view.button("Revoke My phone").disabled, true);
    assert.equal(view.button("Revoke My laptop").disabled, false);
  } finally {
    await view.close();
  }
});

test("Remote browser uses workspace IDs, reads bounded history, and sends an explicit remote message", async () => {
  const device: Snapshot["config"]["devices"][number] = {
    transport: "https",
    id: "desktop",
    label: "Home desktop",
    access: "control",
    endpoint: "https://desktop.example:3940",
    hostId: "host-desktop",
  };
  const calls: Parameters<Api["invoke"]>[0][] = [];
  const view = await mount(
    {
      invoke: async (input) => {
        calls.push(input);
        const result =
          input.name === "zenx_projects_list"
            ? {
                projects: [
                  {
                    id: "workspace-1",
                    project: "workspace-1",
                    name: "Example project",
                    cwd: "workspace-1",
                  },
                ],
              }
            : input.name === "zenx_threads_list"
              ? {
                  threads: [
                    {
                      threadId: "thread-1",
                      name: "Remote task",
                      status: "idle",
                    },
                  ],
                  nextCursor: null,
                }
              : input.name === "zenx_threads_read"
                ? {
                    threadId: "thread-1",
                    items: [
                      {
                        id: "item-1",
                        type: "agent_message",
                        text: "Remote reply",
                      },
                    ],
                    nextCursor: null,
                  }
                : { accepted: true };
        return { device: input.device, result };
      },
    },
    [device],
  );
  try {
    await click(view.button("Browse Home desktop"));
    await choose("Remote workspace", "workspace-1");
    assert.deepEqual(calls.at(-1), {
      device: "desktop",
      name: "zenx_threads_list",
      arguments: { workspace: "workspace-1", limit: 50 },
    });
    await click(view.button("Read Remote task"));
    assert.match(document.body.textContent ?? "", /Remote reply/u);
    assert.deepEqual(calls.at(-1), {
      device: "desktop",
      name: "zenx_threads_read",
      arguments: {
        target: "thread-1",
        workspace: "workspace-1",
        granularity: "items",
        maxItemsPerTurn: 25,
      },
    });
    await fill(view.input("Message to remote Thread"), "Continue the task");
    await choose("Message behavior", "follow_up");
    await click(view.button("Send to remote Thread"));
    assert.deepEqual(calls.at(-1), {
      device: "desktop",
      name: "zenx_threads_send",
      arguments: {
        target: "thread-1",
        workspace: "workspace-1",
        text: "Continue the task",
        messageType: "follow_up",
      },
    });
    assert.match(
      document.body.textContent ?? "",
      /Message accepted.*Work may still be running/su,
    );
    await click(view.button("Use selected workspace"));
    assert.equal(view.saved[0]!.devices[0]!.workspace, "workspace-1");
    await click(view.button("Close browser"));
    assert.equal(document.activeElement, view.button("Browse Home desktop"));
    assert.equal(document.querySelector('[aria-label="Remote Thread"]'), null);
  } finally {
    await view.close();
  }
});

test("Failed pairing preserves the editor for review, and Cancel leaves no configured peer", async () => {
  const view = await mount({
    pair: async () => {
      throw new Error("Pairing code expired");
    },
  });
  try {
    await click(view.button("Add device"));
    await choose("Connection", "https");
    await fill(view.input("Device ID"), "desktop");
    await fill(view.input("Label"), "Home desktop");
    await fill(view.input("HTTPS endpoint"), "https://desktop.example:3940");
    await fill(view.input("Remote Host ID"), "host-desktop");
    await fill(view.input("One-time pairing code"), "EXPIRED-CODE");
    await click(view.button("Pair device"));
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Pairing code expired/u,
    );
    assert.ok(document.querySelector('[aria-label="Device editor"]'));
    await click(view.button("Cancel"));
    assert.equal(view.saved.length, 0);
    assert.equal(view.getSnapshot().config.devices.length, 1);
    assert.equal(
      document.querySelector(
        '[aria-label="Device editor"] input[type="password"]',
      ),
      null,
    );
  } finally {
    await view.close();
  }
});

test("Fresh HTTPS peers with multiple workspaces wait for explicit workspace selection", async () => {
  const calls: Parameters<Api["invoke"]>[0][] = [];
  const peer: Snapshot["config"]["devices"][number] = {
    transport: "https",
    id: "desktop",
    label: "Desktop",
    access: "read",
    endpoint: "https://desktop.example:3940",
    hostId: "host-desktop",
  };
  const view = await mount(
    {
      invoke: async (input) => {
        calls.push(input);
        return input.name === "zenx_projects_list"
          ? {
              projects: [
                { project: "one", name: "One" },
                { project: "two", name: "Two" },
              ],
            }
          : { threads: [{ threadId: "task", name: "Task", status: "idle" }] };
      },
    },
    [peer],
  );
  try {
    await click(view.button("Browse Desktop"));
    assert.equal(calls.length, 1);
    assert.match(
      document.body.textContent ?? "",
      /Choose a workspace to browse/u,
    );
    assert.equal(view.button("Refresh Threads").disabled, true);
    await choose("Remote workspace", "two");
    assert.deepEqual(calls.at(-1), {
      device: "desktop",
      name: "zenx_threads_list",
      arguments: { workspace: "two", limit: 50 },
    });
    await click(view.button("Read Task"));
    assert.equal(calls.at(-1)!.arguments.workspace, "two");
    assert.equal(document.querySelector("textarea"), null);
  } finally {
    await view.close();
  }
});

test("Refresh Fleet preserves unsaved edits and requires reload after a revision conflict", async () => {
  let latest: Snapshot = {
    revision: 1,
    config: { version: 1, devices: [sshDevice] },
    host: { enabled: false, hostId: "host-local", clients: [] },
  };
  const view = await mount({ status: async () => latest });
  try {
    await click(view.button("Edit Build machine"));
    await fill(view.input("Label"), "Unsaved name");
    latest = {
      ...latest,
      revision: 2,
      config: {
        ...latest.config,
        devices: [{ ...sshDevice, label: "Updated elsewhere" }],
      },
    };
    await click(view.button("Refresh Fleet"));
    assert.equal(view.input("Label").value, "Unsaved name");
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /configuration changed while you were editing/u,
    );
    assert.equal(view.saved.length, 0);
    await click(view.button("Cancel"));
    await click(view.button("Refresh Fleet"));
    assert.match(document.body.textContent ?? "", /Updated elsewhere/u);
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally {
    await view.close();
  }
});

test("Visible pairing code rechecks only status, preserves revision-bound edits, and stops when hidden", async () => {
  let poll: (() => void) | undefined;
  let clears = 0;
  let reads = 0;
  let expectedRevision: number | undefined;
  const hosting = {
    enabled: true,
    bindAddress: "127.0.0.1",
    port: 3940,
    tlsCertificateFile: "/tls/cert.pem",
    tlsKeyFile: "/tls/key.pem",
    access: "read" as const,
  };
  const first: Snapshot = {
    revision: 1,
    config: { version: 1, devices: [sshDevice], hosting },
    host: { enabled: true, hostId: "host-local", clients: [] },
  };
  let latest = first;
  const view = await mount(
    {
      status: async () => {
        reads++;
        return latest;
      },
      hostPair: async () => ({
        hostId: "host-local",
        code: "TRANSIENT",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      save: async (_config, revision) => {
        expectedRevision = revision;
        throw new Error(
          "Fleet configuration revision conflict; refresh required",
        );
      },
    },
    [sshDevice],
    undefined,
    (dom) => {
      dom.window.setInterval = ((callback: () => void) => {
        poll = callback;
        return 1;
      }) as typeof dom.window.setInterval;
      dom.window.clearInterval = (() => {
        clears++;
      }) as typeof dom.window.clearInterval;
    },
  );
  try {
    await click(view.button("Create pairing code"));
    await click(view.button("Edit Build machine"));
    await fill(view.input("Label"), "Unsaved name");
    latest = {
      ...first,
      revision: 2,
      host: {
        ...first.host,
        clients: [
          {
            deviceId: "phone",
            label: "New phone",
            access: "read",
            revoked: false,
          },
        ],
      },
    };
    assert.ok(poll);
    await act(async () => {
      poll!();
      await Promise.resolve();
    });
    assert.equal(reads, 2);
    assert.match(document.body.textContent ?? "", /New phone/u);
    assert.equal(view.input("Label").value, "Unsaved name");
    assert.equal(view.calls.length, 0);
    await click(view.button("Save device"));
    assert.equal(expectedRevision, 1);
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /revision conflict/u,
    );
    await click(view.button("Hide code"));
    assert.equal(clears, 1);
    await act(async () => {
      poll!();
      await Promise.resolve();
    });
    assert.equal(view.input("Label").value, "Unsaved name");
    assert.doesNotMatch(document.body.textContent ?? "", /TRANSIENT/u);
  } finally {
    await view.close();
  }
});

test("Relay registration sends its token only on Apply and clears it after save or discard", async () => {
  const hosting = {
    enabled: true,
    bindAddress: "127.0.0.1",
    port: 3940,
    tlsCertificateFile: "/tls/cert.pem",
    tlsKeyFile: "/tls/key.pem",
    access: "read" as const,
  };
  const initial: Partial<Snapshot> = {
    config: { version: 1, devices: [sshDevice], hosting },
    host: {
      enabled: true,
      hostId: "host-local",
      clients: [],
      relayConfigured: false,
      relayConnected: false,
    },
  };
  const view = await mount({}, [sshDevice], initial);
  try {
    await fill(
      view.input("Relay endpoint (optional)"),
      "https://relay.example",
    );
    await fill(
      view.input("Relay registration token"),
      "TRANSIENT-RELAY-SECRET",
    );
    assert.match(
      document.body.textContent ?? "",
      /terminates TLS.*pairing.*messages.*device credentials.*not end-to-end encrypted/su,
    );
    assert.equal(view.button("Apply hosting").disabled, true);
    const consent = [...document.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("I allow this Host to listen"),
    );
    assert.ok(consent);
    assert.match(consent.textContent ?? "", /https:\/\/relay.example/u);
    await click(
      consent.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
    );
    await click(view.button("Apply hosting"));
    assert.equal(
      view.saved.at(-1)!.hosting!.relayRegistrationToken,
      "TRANSIENT-RELAY-SECRET",
    );
    assert.equal(
      view.saved.at(-1)!.hosting!.relayEndpoint,
      "https://relay.example",
    );
    assert.doesNotMatch(
      JSON.stringify(view.getSnapshot()),
      /TRANSIENT-RELAY-SECRET|relayRegistrationToken/u,
    );
    assert.equal(view.input("Relay registration token").value, "");
    await click(view.button("Refresh Fleet"));
    assert.equal(view.input("Relay registration token").value, "");
    await fill(view.input("Relay registration token"), "ANOTHER-SECRET");
    await click(view.button("Discard changes"));
    assert.equal(view.input("Relay registration token").value, "");
    assert.equal(view.saved.length, 1);
  } finally {
    await view.close();
  }
});
