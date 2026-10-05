import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import type {
  ImZenXSetupView,
  ImZenXChannelSave,
} from "../src/main/imzenx-setup-service.js";
import { IM_CHANNEL_SCHEMAS } from "../../../packages/zenx-imzenx-plugin/src/channel-schema.js";

test("background parent updates preserve the open IM settings and do not reload its draft", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const keys = [
    "React",
    "window",
    "document",
    "MutationObserver",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const before = keys.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { PluginProductPage } =
    await import("../src/renderer/src/PluginProductPage.js");
  const { ImZenXDraftContext } =
    await import("../src/renderer/src/imzenx-ui.js");
  const drafts = {
    current: {} as Record<
      string,
      import("../src/renderer/src/imzenx-ui.js").ImZenXDraft
    >,
  };
  const snapshot: ZenXPluginSnapshot = {
    plugins: [],
    sidebar: [],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
    pages: [
      {
        id: "connection",
        key: "imzenx:connection",
        pluginId: "imzenx",
        title: "IMZenX",
        route: "/plugins/imzenx/connection",
        surfaceId: "connection",
      },
    ],
    bundles: [
      {
        id: "main",
        key: "imzenx:main",
        pluginId: "imzenx",
        apiVersion: 1,
        kind: "trusted",
        entry: "zenx/bundled/imzenx-ui",
      },
    ],
    surfaces: [
      {
        id: "connection",
        key: "imzenx:connection",
        pluginId: "imzenx",
        bundleId: "main",
        exportName: "connection",
      },
    ],
  };
  let statusCalls = 0;
  Object.defineProperty(dom.window, "zenx", {
    value: {
      plugins: {
        executeCommand: async () => {
          statusCalls++;
          return {
            state: "connected",
            configuration: {
              pythonExecutable: "/python",
              channelsConfigFile: "/channels",
              cwd: "/work",
            },
          };
        },
        readHandle: async () => ({}),
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const props = {
    snapshot,
    route: "/plugins/imzenx/connection",
    navigate: () => {},
  };
  const view = () =>
    React.createElement(
      ImZenXDraftContext.Provider,
      { value: drafts },
      React.createElement(PluginProductPage, props),
    );
  try {
    await act(async () => {
      root.render(view());
    });
    assert.match(dom.window.document.body.textContent ?? "", /PAW/);
    assert.match(dom.window.document.body.textContent ?? "", /\/paws/);
    assert.match(
      dom.window.document.body.textContent ?? "",
      /只接收它主动发到聊天室的回复/,
    );
    assert.match(
      dom.window.document.body.textContent ?? "",
      /自己的私有频道配置文件/,
    );
    const settings =
      dom.window.document.querySelector<HTMLDetailsElement>(
        ".imzenx-settings",
      )!;
    await act(async () => {
      settings.open = true;
      settings.dispatchEvent(new dom.window.Event("toggle"));
    });
    assert.equal(settings.open, true);
    await act(async () => {
      root.render(view());
    });
    assert.equal(
      settings.open,
      true,
      "incoming notifications must not collapse settings",
    );
    assert.equal(
      statusCalls,
      1,
      "unrelated renders must not reinitialize the form draft",
    );
    const input = dom.window.document.querySelector<HTMLInputElement>(
      'input[value="/work"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "/draft-work");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(drafts.current.imzenx?.config.cwd, "/draft-work");
    await act(async () => root.render(null));
    await act(async () => root.render(view()));
    assert.equal(
      dom.window.document.querySelector<HTMLInputElement>(
        'input[value="/draft-work"]',
      )?.value,
      "/draft-work",
      "route remount retains unsaved configuration rather than replacing it with Host values",
    );
    assert.equal(drafts.current.imzenx?.dirty, true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    keys.forEach((key, index) => {
      const descriptor = before[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

interface Call {
  command: string;
  input: unknown;
}
const preparedConfig = {
  pythonExecutable: "/private/imzen/.venv/bin/python",
  channelsConfigFile: "/private/imzen/channels.json",
  cwd: "/work",
  sharedFilesystemRoot: "",
  permissionMode: "approval-required",
  allowUnrestrictedFullAccess: false,
};
const ready = {
  ready: true,
  checks: [
    { id: "runtime", status: "ready", message: "Local setup is ready." },
  ],
  enabledChannels: ["qq"],
  singleConsumerConfirmationRequired: true,
  connectionState: "prepared",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mountImPage(
  execute: (command: string, input: unknown) => Promise<unknown>,
  nativeApi?: {
    inspect(): Promise<ImZenXSetupView>;
    saveChannel(input: ImZenXChannelSave): Promise<ImZenXSetupView>;
    prepareRuntime(): Promise<ImZenXSetupView>;
  },
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { ImZenXPage, ImZenXDraftContext } =
    await import("../src/renderer/src/imzenx-ui.js");
  const drafts = {
    current: {} as Record<
      string,
      import("../src/renderer/src/imzenx-ui.js").ImZenXDraft
    >,
  };
  const calls: Call[] = [];
  const sdk: import("../src/renderer/src/plugin-ui-host.js").PluginUiSdkV1 = {
    version: 1,
    pluginId: "imzenx",
    theme: "light",
    context: {},
    navigation: { navigate: () => {} },
    handles: { read: async () => ({}) },
    commands: {
      execute: async (command, input) => {
        calls.push({ command, input });
        return execute(command, input);
      },
    },
  };
  if (nativeApi)
    Object.defineProperty(dom.window, "zenx", { value: { imzenx: nativeApi } });
  const root = createRoot(document.getElementById("root")!);
  const view = () =>
    React.createElement(
      ImZenXDraftContext.Provider,
      { value: drafts },
      React.createElement(ImZenXPage, { sdk }),
    );
  await act(async () => root.render(view()));
  return {
    dom,
    calls,
    drafts,
    root,
    render: async () => {
      await act(async () => root.render(view()));
    },
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, previous);
    },
  };
}
function button(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const result = Array.from(
    scope.querySelectorAll<HTMLButtonElement>("button"),
  ).find((element) => element.textContent?.trim() === label);
  assert(result, `Missing button: ${label}`);
  return result;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function changeInput(dom: JSDOM, label: string, value: string) {
  const field = Array.from(document.querySelectorAll("label")).find(
    (element) => element.querySelector("span")?.textContent === label,
  );
  const input = field?.querySelector("input");
  assert(input, `Missing input: ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("IM preparation checks only selected paths and saves without connecting or installing", async () => {
  let configuration: unknown = null;
  const harness = await mountImPage(async (command, input) => {
    if (command === "prepare") configuration = input;
    if (command === "readiness")
      return {
        ...ready,
        ready: false,
        checks: [
          {
            id: "sdk",
            status: "blocked",
            message: "The private IM Agent SDK is missing.",
            action:
              "Use the trusted IMZen project: uv sync --project /trusted/imzen --locked, then select its .venv Python. This check installs nothing.",
          },
        ],
      };
    return {
      state: configuration ? "prepared" : "unconfigured",
      configuration,
      activeConfiguration: null,
    };
  });
  try {
    assert.equal(button("确认连接…").disabled, true);
    await changeInput(
      harness.dom,
      "Python 可执行文件",
      preparedConfig.pythonExecutable,
    );
    await changeInput(
      harness.dom,
      "自己的私有频道配置文件",
      preparedConfig.channelsConfigFile,
    );
    await changeInput(harness.dom, "工作目录", preparedConfig.cwd);
    await click(button("检查准备情况"));
    assert.deepEqual(
      harness.calls.find((call) => call.command === "readiness")?.input,
      preparedConfig,
    );
    assert.match(
      document.body.textContent ?? "",
      /uv sync --project \/trusted\/imzen --locked/,
    );
    assert.equal(
      document
        .querySelector('[data-status="blocked"]')
        ?.textContent?.includes("需处理"),
      true,
    );
    assert.equal(button("确认连接…").disabled, true);
    await click(button("保存准备"));
    assert.deepEqual(configuration, preparedConfig);
    assert.equal(harness.drafts.current.imzenx?.dirty, false);
    assert.match(document.body.textContent ?? "", /准备已保存，等待连接/);
    assert.match(document.body.textContent ?? "", /保存准备不会启动或重启连接/);
    assert.deepEqual(
      harness.calls.map((call) => call.command),
      ["status", "readiness", "prepare"],
    );
    assert.equal(document.querySelector('input[type="password"]'), null);
    assert.equal(
      document.querySelectorAll('input:not([type="checkbox"])').length,
      4,
    );
  } finally {
    await harness.close();
  }
});

test("IM connect requires fresh saved preparation and explicit single-consumer confirmation; Cancel and Escape are inert", async () => {
  const connection = deferred<unknown>();
  const harness = await mountImPage(async (command) => {
    if (command === "readiness") return ready;
    if (command === "connect") return connection.promise;
    return {
      state: "prepared",
      configuration: preparedConfig,
      activeConfiguration: null,
      explicitConnectRequired: true,
    };
  });
  try {
    const trigger = button("确认连接…");
    assert.equal(
      trigger.disabled,
      true,
      "saved paths alone do not allow connection",
    );
    await click(button("检查准备情况"));
    assert.equal(trigger.disabled, false);
    trigger.focus();
    await click(trigger);
    let dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert(dialog);
    assert.match(dialog.textContent ?? "", /无法验证其他进程是否已停止/);
    assert.equal(button("连接", dialog).disabled, true);
    await click(
      dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
    );
    await click(button("取消", dialog));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(
      harness.calls.some((call) => call.command === "connect"),
      false,
    );

    await click(trigger);
    dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(
      dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
      false,
    );
    await act(async () => {
      dialog.dispatchEvent(
        new harness.dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(
      harness.calls.some((call) => call.command === "connect"),
      false,
    );

    await click(trigger);
    dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await click(
      dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
    );
    const connect = button("连接", dialog);
    await act(async () => {
      connect.click();
      connect.click();
    });
    assert.deepEqual(
      harness.calls.filter((call) => call.command === "connect"),
      [{ command: "connect", input: { singleConsumerConfirmed: true } }],
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    connection.resolve({
      state: "connected",
      configuration: preparedConfig,
      activeConfiguration: preparedConfig,
    });
    await act(async () => {
      await connection.promise;
    });
    assert.match(
      document.body.textContent ?? "",
      /本机进程状态不能证明 QQ 等渠道已完成真实消息投递/,
    );
  } finally {
    connection.resolve({ state: "prepared", configuration: preparedConfig });
    await harness.close();
  }
});

test("IM save races preserve newer drafts, reject duplicate submits and do not replace the active configuration", async () => {
  const preparation = deferred<unknown>();
  const active = { ...preparedConfig, cwd: "/active-work" };
  const harness = await mountImPage(async (command) => {
    if (command === "prepare") return preparation.promise;
    return {
      state: "connected",
      configuration: active,
      activeConfiguration: active,
    };
  });
  try {
    await changeInput(harness.dom, "工作目录", "/selected-work");
    const form = document.querySelector<HTMLFormElement>(
      ".imzenx-settings form",
    )!;
    await act(async () => {
      form.dispatchEvent(
        new harness.dom.window.Event("submit", {
          bubbles: true,
          cancelable: true,
        }),
      );
      form.dispatchEvent(
        new harness.dom.window.Event("submit", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.equal(
      harness.calls.filter((call) => call.command === "prepare").length,
      1,
    );
    await changeInput(harness.dom, "工作目录", "/newer-draft");
    assert.equal(harness.drafts.current.imzenx?.dirty, true);
    preparation.resolve({
      state: "connected",
      configuration: { ...preparedConfig, cwd: "/selected-work" },
      activeConfiguration: active,
    });
    await act(async () => {
      await preparation.promise;
    });
    assert.equal(harness.drafts.current.imzenx?.config.cwd, "/newer-draft");
    assert.equal(harness.drafts.current.imzenx?.dirty, true);
    assert.match(
      document.body.textContent ?? "",
      /当前连接仍使用此前的运行配置/,
    );
    assert.equal(button("确认连接…").disabled, true);
    await harness.render();
    assert.equal(
      document.querySelector<HTMLInputElement>('input[value="/newer-draft"]')
        ?.value,
      "/newer-draft",
    );
  } finally {
    preparation.resolve({ state: "prepared", configuration: preparedConfig });
    await harness.close();
  }
});

test("IM readiness results cannot authorize an edited configuration", async () => {
  const inspection = deferred<unknown>();
  const harness = await mountImPage(async (command) => {
    if (command === "readiness") return inspection.promise;
    return {
      state: "prepared",
      configuration: preparedConfig,
      activeConfiguration: null,
    };
  });
  try {
    await click(button("检查准备情况"));
    await changeInput(harness.dom, "工作目录", "/changed-work");
    inspection.resolve(ready);
    await act(async () => {
      await inspection.promise;
    });
    assert.equal(document.querySelector(".imzenx-checks"), null);
    assert.match(
      document.body.textContent ?? "",
      /配置已修改，请重新检查准备情况/,
    );
    assert.equal(button("确认连接…").disabled, true);
    assert.equal(harness.drafts.current.imzenx?.dirty, true);
  } finally {
    inspection.resolve(ready);
    await harness.close();
  }
});

test("IM readiness may inspect an unsaved draft but connection waits for save-only preparation", async () => {
  let configuration: unknown = preparedConfig;
  const harness = await mountImPage(async (command, input) => {
    if (command === "readiness") return ready;
    if (command === "prepare") configuration = input;
    return { state: "prepared", configuration, activeConfiguration: null };
  });
  try {
    await changeInput(harness.dom, "工作目录", "/chosen-work");
    await click(button("检查准备情况"));
    assert.match(
      document.body.textContent ?? "",
      /先保存当前准备配置，再确认连接/,
    );
    assert.equal(button("确认连接…").disabled, true);
    await click(button("保存准备"));
    assert.equal(button("确认连接…").disabled, false);
    assert.deepEqual(
      harness.calls.map((call) => call.command),
      ["status", "readiness", "prepare"],
    );
    await changeInput(harness.dom, "工作目录", "/another-work");
    assert.equal(button("确认连接…").disabled, true);
    assert.equal(document.querySelector(".imzenx-checks"), null);
  } finally {
    await harness.close();
  }
});

test("IM readiness errors remain recoverable and never implicitly connect", async () => {
  let checks = 0;
  const harness = await mountImPage(async (command) => {
    if (command === "readiness") {
      if (++checks === 1) throw new Error("Python readiness request failed");
      return ready;
    }
    return {
      state: "prepared",
      configuration: preparedConfig,
      activeConfiguration: null,
    };
  });
  try {
    await click(button("检查准备情况"));
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Python readiness request failed/,
    );
    assert.equal(button("确认连接…").disabled, true);
    await click(button("检查准备情况"));
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(button("确认连接…").disabled, false);
    assert.equal(
      harness.calls.some((call) => call.command === "connect"),
      false,
    );
    assert.equal(harness.drafts.current.imzenx?.config.cwd, "/work");
  } finally {
    await harness.close();
  }
});

test("late IM background status cannot replace saved status or an edited draft", async () => {
  const background = deferred<unknown>();
  const beforeInterval = globalThis.setInterval;
  const beforeClearInterval = globalThis.clearInterval;
  let poll!: () => void;
  globalThis.setInterval = ((callback: () => void) => {
    poll = callback;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let reads = 0;
  const harness = await mountImPage(async (command, input) => {
    if (command === "status" && ++reads > 1) return background.promise;
    return {
      state: "prepared",
      configuration: command === "prepare" ? input : preparedConfig,
      activeConfiguration: null,
    };
  });
  try {
    await changeInput(harness.dom, "工作目录", "/draft-work");
    await act(async () => poll());
    await click(button("保存准备"));
    assert.equal(harness.drafts.current.imzenx?.dirty, false);
    background.resolve({
      state: "failed",
      configuration: { ...preparedConfig, cwd: "/old-host-work" },
      error: "old failure",
    });
    await act(async () => {
      await background.promise;
    });
    assert.equal(
      document.querySelector<HTMLInputElement>('input[value="/draft-work"]')
        ?.value,
      "/draft-work",
    );
    assert.equal(
      document.querySelector(".imzenx-status")?.getAttribute("data-state"),
      "prepared",
    );
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(harness.drafts.current.imzenx?.config.cwd, "/draft-work");
  } finally {
    background.resolve({ state: "prepared", configuration: preparedConfig });
    await harness.close();
    globalThis.setInterval = beforeInterval;
    globalThis.clearInterval = beforeClearInterval;
  }
});

function nativeView(): ImZenXSetupView {
  return {
    configurationFile: "/private/zenx/channels.managed.json",
    encryptionAvailable: true,
    runtime: {
      projectDirectory: "/trusted/imzen",
      pythonExecutable: "/trusted/imzen/.venv/bin/python",
      prepared: true,
      preparing: false,
      source:
        "Trusted IMZen source, locked dependencies, existing private repository access.",
    },
    channels: IM_CHANNEL_SCHEMAS.map((schema) => ({
      ...schema,
      fields: [...schema.fields],
      values: Object.fromEntries(
        schema.fields
          .filter((field) => !field.secret)
          .map((field) => [field.key, field.defaultValue ?? ""]),
      ),
      secretConfigured: Object.fromEntries(
        schema.fields
          .filter((field) => field.secret)
          .map((field) => [field.key, false]),
      ),
    })),
  };
}
const unconfiguredStatus = async () => ({
  state: "unconfigured",
  configuration: null,
  activeConfiguration: null,
});

test("native IM form uses declared fields and sends write-only credentials only through its local API", async () => {
  const saving = deferred<ImZenXSetupView>();
  const view = nativeView();
  const nativeSaves: ImZenXChannelSave[] = [];
  const harness = await mountImPage(unconfiguredStatus, {
    inspect: async () => view,
    prepareRuntime: async () => view,
    saveChannel: async (input) => {
      nativeSaves.push(input);
      return saving.promise;
    },
  });
  try {
    assert.match(
      document.body.textContent ?? "",
      /系统安全存储，不进入 Agent 工具或聊天/,
    );
    assert.equal(
      document.querySelector<HTMLDetailsElement>(".imzenx-settings")?.open,
      false,
    );
    assert.equal(document.querySelectorAll('input[type="password"]').length, 1);
    assert.equal(
      document.querySelector<HTMLInputElement>('input[type="password"]')?.name,
      "client_secret",
    );
    assert.equal(
      document.querySelector('.imzenx-own-setup [data-value="any"]') !== null,
      true,
      "declared enums use the shared selection control",
    );
    assert.match(
      document.body.textContent ?? "",
      /Weixin.*private state directory/,
    );
    await changeInput(harness.dom, "App ID", "123456");
    await changeInput(harness.dom, "App secret", "synthetic-native-secret");
    const password = document.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    assert.equal(password.value, "synthetic-native-secret");
    await harness.render();
    assert.equal(
      password.value,
      "synthetic-native-secret",
      "ordinary parent refresh must not erase an in-progress local secret input",
    );
    assert.equal(
      JSON.stringify(harness.drafts).includes("synthetic-native-secret"),
      false,
    );
    const form = document.querySelector<HTMLFormElement>(
      ".imzenx-own-setup form",
    )!;
    await act(async () => {
      form.dispatchEvent(
        new harness.dom.window.Event("submit", {
          bubbles: true,
          cancelable: true,
        }),
      );
      form.dispatchEvent(
        new harness.dom.window.Event("submit", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.equal(nativeSaves.length, 1);
    assert.deepEqual(nativeSaves[0]?.secrets, {
      client_secret: { operation: "replace", value: "synthetic-native-secret" },
    });
    assert.equal(nativeSaves[0]?.values.app_id, "123456");
    assert.equal(Object.hasOwn(nativeSaves[0]!.values, "client_secret"), false);
    assert.equal(
      password.value,
      "",
      "the transient input is cleared as soon as save is submitted",
    );
    assert.equal(
      JSON.stringify(harness.calls).includes("synthetic-native-secret"),
      false,
    );
    const result = structuredClone(view);
    result.channels[0]!.values.app_id = "123456";
    result.channels[0]!.secretConfigured.client_secret = true;
    saving.resolve(result);
    await act(async () => {
      await saving.promise;
    });
    assert.match(
      document.body.textContent ?? "",
      /频道设置已安全保存，连接尚未启动/,
    );
    assert.equal(
      document.querySelector('input[type="password"]'),
      null,
      "saved secrets are never returned into an input",
    );
    assert.equal(
      harness.drafts.current.imzenx?.config.channelsConfigFile,
      result.configurationFile,
    );
    assert.equal(
      harness.drafts.current.imzenx?.config.pythonExecutable,
      result.runtime.pythonExecutable,
    );
    assert.equal(
      JSON.stringify(harness.drafts).includes("synthetic-native-secret"),
      false,
    );
    assert.equal(
      harness.calls.some(
        (call) => call.command === "connect" || call.command === "configure",
      ),
      false,
    );
  } finally {
    saving.resolve(view);
    await harness.close();
  }
});

test("native IM Cancel, channel changes and route unmount discard unsaved credentials", async () => {
  const view = nativeView();
  let saves = 0;
  const harness = await mountImPage(unconfiguredStatus, {
    inspect: async () => view,
    prepareRuntime: async () => view,
    saveChannel: async () => {
      saves++;
      return view;
    },
  });
  try {
    await changeInput(harness.dom, "App secret", "synthetic-cancel-secret");
    const canceled = document.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    await click(button("取消修改"));
    assert.equal(canceled.value, "");
    assert.equal(
      document.querySelector<HTMLInputElement>('input[type="password"]')?.value,
      "",
    );
    assert.equal(saves, 0);
    await changeInput(harness.dom, "App secret", "synthetic-channel-secret");
    const beforeSwitch = document.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    const select = document.querySelector<HTMLButtonElement>(
      ".imzenx-own-setup .ui-select",
    )!;
    await act(async () =>
      select.dispatchEvent(
        new harness.dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      ),
    );
    const telegram = document.querySelector<HTMLElement>(
      '[role="option"][data-value="value:telegram"], [role="option"][data-value="telegram"]',
    );
    assert(
      telegram,
      "channel picker exposes Telegram from the declared schema",
    );
    await click(telegram);
    assert.equal(beforeSwitch.value, "");
    assert.equal(
      document.querySelector<HTMLInputElement>('input[type="password"]')?.name,
      "bot_token",
    );
    await changeInput(harness.dom, "Bot token", "synthetic-unmount-secret");
    const unmounted = document.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    await harness.close();
    assert.equal(unmounted.value, "");
    assert.equal(saves, 0);
  } catch (error) {
    await harness.close();
    throw error;
  }
});

test("native IM encryption failure prevents save and safe recovery preserves nonsecret drafts", async () => {
  let view = nativeView();
  view.encryptionAvailable = false;
  let saves = 0;
  const harness = await mountImPage(unconfiguredStatus, {
    inspect: async () => view,
    prepareRuntime: async () => view,
    saveChannel: async () => {
      saves++;
      return view;
    },
  });
  try {
    assert.match(document.body.textContent ?? "", /系统安全存储不可用/);
    assert.equal(
      document.querySelector<HTMLInputElement>('input[type="password"]')!
        .disabled,
      true,
    );
    await changeInput(harness.dom, "App ID", "789012");
    assert.equal(button("保存频道").disabled, true);
    await act(async () =>
      document
        .querySelector<HTMLFormElement>(".imzenx-own-setup form")!
        .dispatchEvent(
          new harness.dom.window.Event("submit", {
            bubbles: true,
            cancelable: true,
          }),
        ),
    );
    assert.equal(saves, 0);
    view = { ...view, encryptionAvailable: true };
    await click(button("重新读取设置"));
    assert.equal(
      document.querySelector<HTMLInputElement>('input[value="789012"]')?.value,
      "789012",
    );
    assert.equal(
      document.querySelector<HTMLInputElement>('input[type="password"]')!
        .disabled,
      false,
    );
    assert.equal(document.querySelector(".imzenx-storage-warning"), null);
  } finally {
    await harness.close();
  }
});

test("native runtime preparation is explicit and preserves a channel form being filled", async () => {
  const preparing = deferred<ImZenXSetupView>();
  const view = nativeView();
  view.runtime.prepared = false;
  let preparations = 0;
  const harness = await mountImPage(unconfiguredStatus, {
    inspect: async () => view,
    prepareRuntime: async () => {
      preparations++;
      return preparing.promise;
    },
    saveChannel: async () => view,
  });
  try {
    assert.equal(preparations, 0);
    await changeInput(harness.dom, "App ID", "13579");
    await changeInput(harness.dom, "App secret", "synthetic-runtime-secret");
    const prepare = button("准备运行环境");
    await act(async () => {
      prepare.click();
      prepare.click();
    });
    assert.equal(preparations, 1);
    const result = structuredClone(view);
    result.runtime.prepared = true;
    preparing.resolve(result);
    await act(async () => {
      await preparing.promise;
    });
    assert.equal(
      document.querySelector<HTMLInputElement>('input[value="13579"]')?.value,
      "13579",
    );
    assert.equal(
      document.querySelector<HTMLInputElement>('input[type="password"]')?.value,
      "synthetic-runtime-secret",
    );
    assert.equal(button("确认连接…").disabled, true);
    assert.match(
      document.body.textContent ?? "",
      /先保存或取消频道表单中的修改/,
    );
    assert.equal(
      harness.calls.some((call) => call.command === "connect"),
      false,
    );
    assert.equal(
      JSON.stringify(harness.drafts).includes("synthetic-runtime-secret"),
      false,
    );
  } finally {
    preparing.resolve(view);
    await harness.close();
  }
});

test("native secret-save failure clears inputs and never echoes credential-bearing errors", async () => {
  const view = nativeView();
  const harness = await mountImPage(unconfiguredStatus, {
    inspect: async () => view,
    prepareRuntime: async () => view,
    saveChannel: async () => {
      throw new Error("server diagnostic synthetic-rejected-secret");
    },
  });
  try {
    await changeInput(harness.dom, "App ID", "12345");
    await changeInput(harness.dom, "App secret", "synthetic-rejected-secret");
    await click(button("保存频道"));
    assert.match(
      document.querySelector('.imzenx-own-setup [role="alert"]')?.textContent ??
        "",
      /频道设置未保存/,
    );
    assert.equal(
      document.body.textContent?.includes("synthetic-rejected-secret"),
      false,
    );
    assert.equal(
      document.querySelector<HTMLInputElement>('input[type="password"]')?.value,
      "",
    );
    assert.equal(
      JSON.stringify(harness.drafts).includes("synthetic-rejected-secret"),
      false,
    );
    assert.equal(
      harness.calls.some((call) => call.command === "connect"),
      false,
    );
  } finally {
    await harness.close();
  }
});

test("same-path managed IM edits show the explicit pending gate while the old consumer is running", async () => {
  const harness = await mountImPage(async () => ({
    state: "connected",
    configuration: preparedConfig,
    activeConfiguration: preparedConfig,
    explicitConnectRequired: true,
  }));
  try {
    assert.match(
      document.querySelector(".imzenx-active-note")?.textContent ?? "",
      /新保存的准备配置或频道设置会在明确连接后使用/,
    );
    assert.equal(button("确认连接…").disabled, true);
    assert.equal(
      harness.calls.some((call) => call.command === "connect"),
      false,
    );
  } finally {
    await harness.close();
  }
});
