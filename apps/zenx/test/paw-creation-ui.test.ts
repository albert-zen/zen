import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

const preview = {
  workspace: "/project",
  resolvedWorkspace: "/project",
  model: "mock/model",
  providerProfileId: "mock",
  modelId: "model",
  reasoningEffort: null,
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  processEpoch: "host",
  revision: 0,
};

test("PAW defaults to its own new working Thread, and duplicate clicks share one explicit create", async () => {
  await withForm(async ({ calls, root, sdk, release }) => {
    assert.equal(
      document.querySelector('[aria-label="Working conversation"]')
        ?.textContent,
      "Create a new conversation",
    );
    assert.equal(
      document.querySelector('[aria-label="Member conversation"]'),
      null,
    );
    const submit = createButton();
    assert.equal(submit.disabled, false, "no existing Thread is required");
    assert.ok(
      calls.every((call) =>
        ["list", "workspaces", "preview-target"].includes(call.id),
      ),
    );
    await act(async () => {
      submit.click();
      submit.click();
    });
    const creates = calls.filter((call) => call.id === "create-assistant");
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0]!.input.target, {
      kind: "new",
      workspace: "/project",
      expected: preview,
    });
    assert.equal(creates[0]!.input.name, "PAW");
    assert.equal(typeof creates[0]!.input.operationId, "string");
    await act(async () => release({ id: "created-paw" }));
    assert.equal(document.querySelector(".paw-start-content"), null);
    const introduction = calls.filter(
      (call) => call.id === "start-introduction",
    );
    assert.equal(introduction.length, 1);
    assert.equal(introduction[0]!.input.roomId, "created-paw");
    assert.equal(introduction[0]!.input.text, undefined);
    assert.equal(calls.filter((call) => call.id === "post-message").length, 0);
  });
});

test("using an existing Thread is an explicit PAW alternative", async () => {
  await withForm(async ({ calls, release }) => {
    await choose("Working conversation", "existing");
    const picker = document.querySelector<HTMLButtonElement>(
      '[aria-label="Existing conversation"]',
    )!;
    assert.ok(picker);
    await act(async () => picker.click());
    await act(async () =>
      document
        .querySelector<HTMLElement>(
          '[role="option"][data-value="existing-thread"]',
        )!
        .click(),
    );
    await act(async () => createButton().click());
    const create = calls.find((call) => call.id === "create-assistant")!;
    assert.deepEqual(create.input.target, {
      kind: "existing",
      threadId: "existing-thread",
    });
    await act(async () => release({ id: "bound-paw" }));
  });
});

test("equivalent SDK replacement retains the open PAW Project and preview without new setup reads", async () => {
  await withForm(
    async ({ root, sdk, calls, delaySetupReads, releaseSetupReads }) => {
      const project = document.querySelector('[aria-label="Project"]')!;
      const selected = project.textContent;
      assert.equal(createButton().disabled, false);
      delaySetupReads();
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk: sdk() })),
      );
      assert.equal(calls.filter((call) => call.id === "workspaces").length, 1);
      assert.equal(
        calls.filter((call) => call.id === "preview-target").length,
        1,
      );
      assert.equal(project.textContent, selected);
      assert.equal(createButton().disabled, false);
      assert.doesNotMatch(
        document.querySelector(".paw-start-content")?.textContent ?? "",
        /Add a Project before|Unavailable selection/,
      );
      releaseSetupReads();
    },
  );
});

test("a genuine Project change retires the old preview while SDK-only changes do not, and mode changes still review the target", async () => {
  await withForm(
    async ({ root, sdk, calls, delaySetupReads, releaseSetupReads }) => {
      delaySetupReads();
      await choose("Project", "/second");
      assert.equal(
        createButton().disabled,
        true,
        "a different workspace requires its own preview",
      );
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk: sdk() })),
      );
      assert.equal(
        calls.filter((call) => call.id === "preview-target").length,
        2,
      );
      assert.equal(
        document.querySelector('[aria-label="Project"]')?.textContent,
        "/second",
      );
      await act(async () => releaseSetupReads());
      assert.equal(createButton().disabled, false);
      await choose("Working conversation", "existing");
      assert.equal(document.querySelector('[aria-label="Project"]'), null);
      assert.equal(
        createButton().disabled,
        true,
        "existing mode requires an explicit binding",
      );
      await choose("Working conversation", "new");
      assert.equal(
        calls.filter((call) => call.id === "preview-target").length,
        3,
      );
      assert.equal(createButton().disabled, false);
    },
  );
});

for (const interruption of [
  "cancel before",
  "cancel during",
  "new route",
  "unmount",
] as const) {
  test(`PAW creation respects ${interruption} without repeat or stale navigation`, async () => {
    await withForm(async ({ calls, routes, root, sdk, release }) => {
      if (interruption !== "cancel before")
        await act(async () => createButton().click());
      if (interruption.startsWith("cancel"))
        await act(async () => {
          document.querySelector(".paw-start-content")!.dispatchEvent(
            new window.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
            }),
          );
        });
      if (interruption === "new route")
        await act(async () =>
          root.render(
            React.createElement(RoomsPage, {
              sdk: sdk("/plugins/zenx-rooms/rooms?roomId=newer"),
            }),
          ),
        );
      if (interruption === "unmount")
        await act(async () =>
          root.render(React.createElement("p", null, "Other page")),
        );
      await act(async () => release({ id: "late-paw" }));
      assert.equal(
        calls.filter((call) => call.id === "create-assistant").length,
        interruption === "cancel before" ? 0 : 1,
      );
      assert.ok(
        routes.every((route) => !route.includes("late-paw")),
        "accepted background creation cannot replace newer intent",
      );
      assert.equal(document.querySelector(".paw-start-content"), null);
    });
  });
}

test("a failed PAW setup preserves its error and blocks blind new-Thread retries", async () => {
  await withForm(async ({ calls, reject }) => {
    await act(async () => createButton().click());
    await act(async () =>
      reject(Error("Thread new-thread was created, but PAW setup failed")),
    );
    assert.equal(createButton().disabled, true);
    assert.match(
      document.querySelector('.paw-start-content [role="alert"]')
        ?.textContent ?? "",
      /new-thread.*setup failed/,
    );
    await act(async () => createButton().click());
    assert.equal(
      calls.filter((call) => call.id === "create-assistant").length,
      1,
    );
    await choose("Working conversation", "existing");
    assert.equal(document.querySelector('[aria-label="Project"]'), null);
  });
});

test("confirmed PAW creation navigates even when follow-up list refresh fails", async () => {
  await withForm(async ({ routes, release, failRefresh }) => {
    await act(async () => createButton().click());
    failRefresh();
    await act(async () => release({ id: "saved-paw" }));
    assert.deepEqual(routes, ["/plugins/zenx-rooms/rooms?roomId=saved-paw"]);
    assert.equal(document.querySelector(".paw-start-content"), null);
  });
});

test("a failed explicit binding keeps visible fields aligned with its retained submission", async () => {
  await withForm(async ({ calls, reject }) => {
    await choose("Working conversation", "existing");
    await choose("Existing conversation", "existing-thread");
    await act(async () => createButton().click());
    await act(async () =>
      reject(Error("Binding result could not be confirmed")),
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Existing conversation"]',
      )!.disabled,
      true,
    );
    await act(async () => createButton().click());
    const submitted = calls.filter((call) => call.id === "create-assistant");
    assert.equal(submitted.length, 2);
    assert.deepEqual(
      submitted[0]!.input,
      submitted[1]!.input,
      "retry reuses exactly the acknowledged operation identity and visible draft",
    );
  });
});

async function choose(label: string, value: string) {
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
      .click(),
  );
  await act(async () =>
    document
      .querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`)!
      .click(),
  );
}
function createButton() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Create and say hello",
  )!;
}
async function withForm(
  run: (value: {
    root: Root;
    calls: Array<{ id: string; input: any }>;
    routes: string[];
    sdk: (route?: string) => PluginUiSdkV1;
    release: (value: unknown) => void;
    reject: (reason: unknown) => void;
    failRefresh: () => void;
    delayRefresh: () => void;
    releaseRefresh: () => void;
    failIntroduction: () => void;
    delayIntroduction: () => void;
    releaseIntroduction: () => void;
    delaySetupReads: () => void;
    releaseSetupReads: () => void;
  }) => Promise<void>,
  _legacyStartAtName = false,
  failFirstSetupRead = false,
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const plugins = [
    "zenx-rooms",
    "zenx-triggers",
    "zenx-self-control",
    "zenx-subagents",
  ].map((id) => ({ id, enabled: true, available: true, lifecycle: "enabled" }));
  Object.assign(window, {
    zenx: {
      threads: {
        list: async () => [
          {
            threadId: "existing-thread",
            name: "Existing",
            preview: "Existing",
            status: "idle",
            archived: false,
            currentMetadata: { cwd: "/project" },
          },
        ],
      },
      plugins: { get: async () => ({ plugins }), onChange: () => () => {} },
    },
  });
  const calls: Array<{ id: string; input: any }> = [];
  const routes: string[] = [];
  let release!: (value: unknown) => void, reject!: (reason: unknown) => void;
  let refreshFails = false;
  let refreshDelayed = false;
  let releaseRefresh!: () => void;
  const refreshWait = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let introductionFails = false;
  let introductionDelayed = false;
  let releaseIntroduction!: () => void;
  const introductionWait = new Promise<void>((resolve) => {
    releaseIntroduction = resolve;
  });
  let delaySetup = false;
  let releaseSetupReads!: () => void;
  const setupReads = new Promise<void>((resolve) => {
    releaseSetupReads = resolve;
  });
  const creation = new Promise((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  const sdk = (route = "/plugins/zenx-rooms/rooms?create=companion") =>
    ({
      context: { route, primaryNavigation: true },
      navigation: { navigate: (route: string) => routes.push(route) },
      commands: {
        execute: async (id: string, input: any) => {
          calls.push({ id, input });
          if (id === "list") {
            if (refreshFails) throw Error("List unavailable");
            if (refreshDelayed) await refreshWait;
            return { rooms: [] };
          }
          if (id === "workspaces") {
            if (failFirstSetupRead) {
              failFirstSetupRead = false;
              throw new Error("Project settings temporarily unavailable");
            }
            if (delaySetup) await setupReads;
            return ["/project", "/second"];
          }
          if (id === "preview-target") {
            if (delaySetup) await setupReads;
            return {
              ...preview,
              workspace: input.workspace,
              resolvedWorkspace: input.workspace,
            };
          }
          if (id === "create-assistant") return await creation;
          if (id === "prepare-introduction") return {};
          if (id === "start-introduction") {
            if (introductionDelayed) await introductionWait;
            if (introductionFails)
              throw new Error("Introduction transport outcome unknown");
            return { wakeupId: "introduction" };
          }
          if (id === "ack-operation") return { acknowledged: true };
          throw Error(id);
        },
      },
    }) as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk() })),
    );
    await run({
      root,
      calls,
      routes,
      sdk,
      release,
      reject,
      delayIntroduction: () => {
        introductionDelayed = true;
      },
      releaseIntroduction,
      failIntroduction: () => {
        introductionFails = true;
      },
      delayRefresh: () => {
        refreshDelayed = true;
      },
      releaseRefresh,
      failRefresh: () => {
        refreshFails = true;
      },
      delaySetupReads: () => {
        delaySetup = true;
      },
      releaseSetupReads,
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}

test("first-use PAW creation is inline, has no name form, and can be postponed without a turn", async () => {
  await withForm(async ({ calls, routes }) => {
    assert.equal(document.querySelector('[role="dialog"]') !== null, false);
    assert.equal(
      document.querySelector(".paw-start-content input") !== null,
      false,
    );
    assert.match(
      document.querySelector(".paw-start-content")!.textContent!,
      /will introduce itself/,
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Later")!
        .click(),
    );
    assert.equal(document.querySelector(".paw-start-content") !== null, false);
    assert.equal(
      calls.some((call) =>
        [
          "create-assistant",
          "prepare-introduction",
          "start-introduction",
        ].includes(call.id),
      ),
      false,
    );
    assert.deepEqual(routes, ["/plugins/zenx-rooms/rooms"]);
  });
});

test("failed setup reads preserve the form and explicitly retry without creating work", async () => {
  await withForm(
    async ({ calls }) => {
      assert.match(
        document.body.textContent!,
        /Project settings temporarily unavailable/,
      );
      assert.equal(createButton().disabled, true);
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent === "Retry setup checks")!
          .click(),
      );
      assert.equal(createButton().disabled, false);
      assert.equal(calls.filter((call) => call.id === "workspaces").length, 2);
      assert.equal(
        calls.some((call) => call.id === "create-assistant"),
        false,
      );
    },
    false,
    true,
  );
});

test("uncertain introduction opens the created Room without recreating it or inventing a reply", async () => {
  await withForm(
    async ({ calls, routes, release, failIntroduction, root, sdk }) => {
      failIntroduction();
      await act(async () => createButton().click());
      await act(async () =>
        release({ id: "saved-paw", operationEpoch: "epoch" }),
      );
      assert.deepEqual(routes, ["/plugins/zenx-rooms/rooms?roomId=saved-paw"]);
      assert.equal(
        calls.filter((call) => call.id === "create-assistant").length,
        1,
      );
      assert.equal(
        calls.filter((call) => call.id === "start-introduction").length,
        1,
      );
      assert.equal(
        calls.filter((call) => call.id === "ack-operation").length,
        0,
      );
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk: sdk(routes[0]) })),
      );
      assert.equal(
        calls.filter((call) => call.id === "start-introduction").length,
        1,
        "reopening does not resend initialization",
      );
      assert.equal(
        document.querySelector(".room-message") !== null,
        false,
        "no renderer-generated model welcome",
      );
    },
  );
});

test("confirmed creation opens chat before introduction admission, and a newer route is never replaced", async () => {
  await withForm(
    async ({
      calls,
      routes,
      release,
      delayIntroduction,
      releaseIntroduction,
      root,
      sdk,
    }) => {
      delayIntroduction();
      await act(async () => createButton().click());
      await act(async () =>
        release({ id: "new-chat", operationEpoch: "epoch" }),
      );
      assert.deepEqual(routes, ["/plugins/zenx-rooms/rooms?roomId=new-chat"]);
      assert.equal(
        calls.filter((call) => call.id === "start-introduction").length,
        1,
      );
      assert.equal(
        calls.filter((call) => call.id === "ack-operation").length,
        0,
      );
      await act(async () =>
        root.render(
          React.createElement(RoomsPage, {
            sdk: sdk("/plugins/zenx-rooms/rooms?roomId=other"),
          }),
        ),
      );
      await act(async () => releaseIntroduction());
      assert.deepEqual(routes, ["/plugins/zenx-rooms/rooms?roomId=new-chat"]);
      assert.equal(
        calls.filter((call) => call.id === "start-introduction").length,
        1,
      );
      assert.equal(
        calls.filter((call) => call.id === "ack-operation").length,
        1,
      );
    },
  );
});

test("admission opens new PAW before unrelated list refresh settles", async () => {
  await withForm(
    async ({ calls, routes, release, delayRefresh, releaseRefresh }) => {
      await act(async () => createButton().click());
      delayRefresh();
      await act(async () =>
        release({ id: "accepted-paw", operationEpoch: "epoch" }),
      );
      try {
        assert.deepEqual(
          [...routes],
          ["/plugins/zenx-rooms/rooms?roomId=accepted-paw"],
        );
        assert.equal(
          calls.filter((c) => c.id === "prepare-introduction").length,
          1,
        );
      } finally {
        await act(async () => releaseRefresh());
      }
    },
  );
});

test("accepted explicit greeting survives navigation during create admission", async () => {
  await withForm(async ({ root, sdk, calls, routes, release }) => {
    await act(async () => createButton().click());
    await act(async () =>
      root.render(
        React.createElement(RoomsPage, {
          sdk: sdk("/plugins/zenx-rooms/rooms?roomId=other"),
        }),
      ),
    );
    await act(async () =>
      release({ id: "accepted-paw", operationEpoch: "epoch" }),
    );
    assert.deepEqual(routes, []);
    assert.equal(
      calls.filter((c) => c.id === "prepare-introduction").length,
      1,
      "create-and-greet owns its accepted request even when navigation changes",
    );
  });
});
