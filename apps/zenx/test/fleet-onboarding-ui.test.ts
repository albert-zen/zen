import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import {
  encodeFleetInvitation,
  type FleetInvitation,
} from "../src/fleet-invitation.js";

const bootstrap = new JSDOM('<div id="root"></div>');
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { FleetConnectionSetup, FleetInvitationIssuer } =
  await import("../src/renderer/src/FleetOnboarding.js");
type Api = import("../src/renderer/src/FleetSettings.js").FleetSettingsApi;
type Snapshot =
  import("../src/renderer/src/FleetSettings.js").FleetSettingsSnapshot;
const invite = (): FleetInvitation => ({
  version: 1,
  hostId: "machine-b",
  endpoint: "https://b.example:3940",
  label: "Machine B",
  expiresAt: Date.now() + 300_000,
  access: "control",
  shellEnabled: true,
  code: "transient_fixture_code_12345678901234567890",
});
const snapshot: Snapshot = {
  revision: 1,
  config: {
    version: 1,
    devices: [],
    hosting: {
      enabled: true,
      bindAddress: "127.0.0.1",
      port: 3940,
      tlsCertificateFile: "/fixture/cert.pem",
      tlsKeyFile: "/fixture/key.pem",
      originEndpoint: "https://b.example:3940",
      access: "control",
      shellEnabled: true,
    },
  },
  host: {
    enabled: true,
    hostId: "machine-b",
    url: "https://127.0.0.1:3940",
    clients: [],
  },
};

test("invitation review requires human trust and defaults to read without shell", async () => {
  const v = await mount();
  try {
    await click(v.button("Use invitation"));
    await fill(v.input("Invitation"), encodeFleetInvitation(invite()));
    await click(v.button("Review invitation"));
    assert.equal(v.paired.length, 0);
    assert.match(document.body.textContent ?? "", /machine-b/u);
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /transient_fixture_code/u,
    );
    assert.equal(document.querySelector('input[type="password"]'), null);
    assert.equal(v.button("Pair and check").disabled, true);
    await click(v.checkbox("I verified this Host"));
    await click(v.button("Pair and check"));
    assert.equal(v.paired.length, 1);
    assert.equal(v.paired[0]?.access, "read");
    assert.equal(v.paired[0]?.shellEnabled, false);
    assert.deepEqual(v.checked, [v.paired[0]!.id]);
    assert.match(document.body.textContent ?? "", /Paired.*reachable/iu);
    await click(v.button("Use invitation"));
    assert.equal(v.input("Invitation").value, "");
  } finally {
    await v.close();
  }
});

test("cancel erases the imported invitation and makes no enrollment request", async () => {
  const v = await mount();
  try {
    await click(v.button("Use invitation"));
    await fill(v.input("Invitation"), encodeFleetInvitation(invite()));
    await click(v.button("Cancel invitation"));
    await click(v.button("Use invitation"));
    assert.equal(v.input("Invitation").value, "");
    assert.equal(v.paired.length, 0);
  } finally {
    await v.close();
  }
});

test("invalid and expired invitation errors never echo their secret input", async () => {
  const v = await mount();
  try {
    await click(v.button("Use invitation"));
    await fill(v.input("Invitation"), "secret-invalid-invitation");
    await click(v.button("Review invitation"));
    assert.match(document.body.textContent ?? "", /Invalid.*invitation/iu);
    assert.doesNotMatch(document.body.textContent ?? "", /secret-invalid/iu);
    const expired = { ...invite(), expiresAt: Date.now() - 1 };
    await fill(
      v.input("Invitation"),
      `zenx-fleet:v1:${Buffer.from(JSON.stringify(expired)).toString("base64url")}`,
    );
    await click(v.button("Review invitation"));
    assert.match(document.body.textContent ?? "", /expired/iu);
    assert.equal(v.paired.length, 0);
  } finally {
    await v.close();
  }
});

test("a failed pairing clears the invitation before another attempt", async () => {
  const v = await mount({
    pair: async () => {
      throw new Error(
        "Error invoking remote method 'zenx:fleet:control': Error: Operating-system credential encryption is unavailable; no remote grant requested",
      );
    },
  });
  try {
    await click(v.button("Use invitation"));
    await fill(v.input("Invitation"), encodeFleetInvitation(invite()));
    await click(v.button("Review invitation"));
    await click(v.checkbox("I verified this Host"));
    await click(v.button("Pair and check"));
    assert.match(document.body.textContent ?? "", /credential encryption/iu);
    assert.doesNotMatch(document.body.textContent ?? "", /zenx:fleet:control/u);
    assert.equal(
      document.querySelector('[aria-label="Review machine invitation"]'),
      null,
    );
    await click(v.button("Use invitation"));
    assert.equal(v.input("Invitation").value, "");
  } finally {
    await v.close();
  }
});

test("a successful pair followed by connection failure reports the durable trust result", async () => {
  const v = await mount({
    test: async () => {
      throw new Error("Host unreachable");
    },
  });
  try {
    await click(v.button("Use invitation"));
    await fill(v.input("Invitation"), encodeFleetInvitation(invite()));
    await click(v.button("Review invitation"));
    await click(v.checkbox("I verified this Host"));
    await click(v.button("Pair and check"));
    assert.equal(v.paired.length, 1);
    assert.match(document.body.textContent ?? "", /Paired.*check failed/iu);
    assert.match(document.body.textContent ?? "", /Host unreachable/u);
  } finally {
    await v.close();
  }
});

test("issuing an invitation requires explicit sharing consent and hiding clears it", async () => {
  const v = await mount({}, "issuer");
  try {
    assert.equal(v.button("Create invitation").disabled, true);
    await click(v.checkbox("I allow one client"));
    await click(v.button("Create invitation"));
    assert.equal(v.issued.length, 1);
    assert.equal(v.issued[0]?.confirmed, true);
    assert.equal(v.issued[0]?.endpoint, "https://b.example:3940");
    assert.deepEqual(v.issued[0]?.expected, {
      revision: 1,
      hostId: "machine-b",
      access: "control",
      shellEnabled: true,
      relayEndpoint: null,
    });
    assert.ok(v.input("Share invitation").value);
    await click(v.button("Hide invitation"));
    assert.equal(
      document.querySelector('[aria-label="Share invitation"]'),
      null,
    );
  } finally {
    await v.close();
  }
});

test("changing access or shell scope requires a renewed human acknowledgment", async () => {
  const v = await mount();
  try {
    await click(v.button("Use invitation"));
    await fill(v.input("Invitation"), encodeFleetInvitation(invite()));
    await click(v.button("Review invitation"));
    await click(v.checkbox("I verified this Host"));
    await chooseAccess("control");
    assert.equal(v.button("Pair and check").disabled, true);
    await click(v.checkbox("I verified this Host"));
    await click(v.checkbox("Allow explicit bounded remote shell"));
    assert.equal(v.button("Pair and check").disabled, true);
    await click(v.checkbox("I verified this Host"));
    await click(v.button("Pair and check"));
    assert.equal(v.paired[0]?.access, "control");
    assert.equal(v.paired[0]?.shellEnabled, true);
  } finally {
    await v.close();
  }
});

test("a repeated Pair click admits one request and a late result after unmount stays dismissed", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let requests = 0;
  const v = await mount({
    pair: async () => {
      requests++;
      await pending;
    },
  });
  await click(v.button("Use invitation"));
  await fill(v.input("Invitation"), encodeFleetInvitation(invite()));
  await click(v.button("Review invitation"));
  await click(v.checkbox("I verified this Host"));
  const submit = v.button("Pair and check");
  await act(async () => {
    submit.click();
    submit.click();
  });
  assert.equal(requests, 1);
  await v.close();
  await act(async () => {
    finish();
    await pending;
  });
  assert.equal(document.body.textContent ?? "", "");
});

test("expiry removes an unsubmitted preview and its bearer before Pair", async () => {
  const timers: Array<() => void> = [];
  const v = await mount({}, "receiver", (dom) => {
    dom.window.setTimeout = ((callback: () => void) => {
      timers.push(callback);
      return timers.length;
    }) as typeof dom.window.setTimeout;
  });
  try {
    await click(v.button("Use invitation"));
    await fill(v.input("Invitation"), encodeFleetInvitation(invite()));
    await click(v.button("Review invitation"));
    await act(async () => timers.at(-1)!());
    assert.equal(
      document.querySelector('[aria-label="Review machine invitation"]'),
      null,
    );
    assert.equal(v.input("Invitation").value, "");
    assert.match(document.body.textContent ?? "", /expired/iu);
    assert.equal(v.paired.length, 0);
  } finally {
    await v.close();
  }
});

test("changed displayed Host or grant scope clears sharing consent and any issued secret", async () => {
  const v = await mount({}, "issuer");
  try {
    await click(v.checkbox("I allow one client"));
    await v.render({
      ...snapshot,
      revision: 2,
      host: { ...snapshot.host, hostId: "replacement-host" },
    });
    assert.equal(v.checkbox("I allow one client").checked, false);
    assert.equal(v.button("Create invitation").disabled, true);
    await click(v.checkbox("I allow one client"));
    await click(v.button("Create invitation"));
    assert.equal(v.issued[0]?.expected.hostId, "replacement-host");
    assert.ok(v.input("Share invitation").value);
    await v.render({
      ...snapshot,
      revision: 3,
      config: {
        ...snapshot.config,
        hosting: {
          ...snapshot.config.hosting!,
          access: "read",
          shellEnabled: false,
        },
      },
    });
    assert.equal(v.checkbox("I allow one client").checked, false);
    assert.equal(
      document.querySelector('[aria-label="Share invitation"]'),
      null,
    );
  } finally {
    await v.close();
  }
});

test("a late invitation receipt cannot appear after the displayed scope changes", async () => {
  let resolve!: (value: {
    invitation: FleetInvitation;
    serialized: string;
  }) => void;
  const pending = new Promise<{
    invitation: FleetInvitation;
    serialized: string;
  }>((finish) => {
    resolve = finish;
  });
  const v = await mount(
    { hostInvitation: async () => await pending },
    "issuer",
  );
  try {
    await click(v.checkbox("I allow one client"));
    await click(v.button("Create invitation"));
    await v.render({
      ...snapshot,
      revision: 2,
      host: { ...snapshot.host, hostId: "replacement-host" },
    });
    const invitation = invite();
    await act(async () => {
      resolve({ invitation, serialized: encodeFleetInvitation(invitation) });
      await pending;
    });
    assert.equal(
      document.querySelector('[aria-label="Share invitation"]'),
      null,
    );
    assert.equal(v.checkbox("I allow one client").checked, false);
    assert.match(
      document.body.textContent ?? "",
      /Host or sharing scope changed/u,
    );
  } finally {
    await v.close();
  }
});

async function mount(
  overrides: Partial<Api> = {},
  mode: "receiver" | "issuer" = "receiver",
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
  const paired: Parameters<Api["pair"]>[0][] = [];
  const checked: string[] = [];
  const issued: Array<Parameters<NonNullable<Api["hostInvitation"]>>[0]> = [];
  const api = {
    status: async () => structuredClone(snapshot),
    pair: async (input) => {
      paired.push(input);
    },
    test: async (id) => {
      checked.push(id);
    },
    hostInvitation: async (input) => {
      issued.push(input);
      const invitation = invite();
      return { invitation, serialized: encodeFleetInvitation(invitation) };
    },
    ...overrides,
  } as Api;
  const root = createRoot(document.getElementById("root")!);
  beforeRender?.(dom);
  const props = {
    api,
    snapshot,
    disabled: false,
    onBusy: () => {},
    onChanged: async () => {},
    hostingDirty: false,
    onHostStatus: () => {},
  };
  await act(async () =>
    root.render(
      React.createElement(
        mode === "issuer" ? FleetInvitationIssuer : FleetConnectionSetup,
        props,
      ),
    ),
  );
  const render = async (value: Snapshot) => {
    await act(async () =>
      root.render(
        React.createElement(
          mode === "issuer" ? FleetInvitationIssuer : FleetConnectionSetup,
          { ...props, snapshot: value },
        ),
      ),
    );
  };
  const button = (label: string) => {
    const item = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent?.trim() === label);
    assert(item, `Missing button: ${label}`);
    return item;
  };
  const input = (label: string) => {
    const item = document.querySelector<HTMLInputElement>(
      `[aria-label="${label}"]`,
    );
    assert(item, `Missing input: ${label}`);
    return item;
  };
  const checkbox = (text: string) => {
    const item = [...document.querySelectorAll("label")]
      .find((l) => l.textContent?.includes(text))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert(item, `Missing checkbox: ${text}`);
    return item;
  };
  return {
    button,
    input,
    checkbox,
    paired,
    checked,
    issued,
    render,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function fill(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function chooseAccess(value: string) {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="Invitation access"]',
  );
  assert(trigger);
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((item) => item.dataset.value === value);
  assert(option);
  await act(async () => {
    option.focus();
    option.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}
