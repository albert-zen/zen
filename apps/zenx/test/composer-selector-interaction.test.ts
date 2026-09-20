import "./dom-primitives.js";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";
import type { Thread } from "../src/protocol-client/index.js";
import type { WorkspaceFileSearch } from "../src/main/workspace-files.js";
import {
  editComposer,
  emptyComposerState,
} from "../src/renderer/src/composer-state.js";
import {
  parseSkillDraft,
  withSkillDraft,
} from "../src/renderer/src/skill-draft.js";
const { act, createElement } = React;
const { ThreadView } = await import("../src/renderer/src/ThreadView.js");

for (const command of [
  "/compact",
  "/compact ",
  "  /compact\t",
  "/compact reason",
]) {
  test(`compact input ${JSON.stringify(command)} reaches the existing handler`, async () => {
    await withView(async ({ sends }) => {
      await input(command);
      await key("Enter");
      assert.deepEqual(sends, [command]);
      assert.equal(
        document.querySelector('[aria-label="Slash commands"]'),
        null,
      );
    });
  });
}

const skill = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "sample",
  description: "Manual instructions",
  source: "C:/skills/sample",
  directory: "C:/host/sample",
  mode: "manual",
  configurationSource: "default",
};
const fileResult = (name: string): WorkspaceFileSearch => ({
  cwd: "C:/workspace",
  entries: [{ name, path: name }],
  truncated: false,
  scanned: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function thread(id: string): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "openai",
    createdAt: 10,
    updatedAt: 10,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "C:/workspace",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}
function textarea() {
  const element =
    document.querySelector<HTMLTextAreaElement>("#thread-composer");
  assert.ok(element);
  return element;
}
function options() {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}
async function settleSearch() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}
async function input(value: string, caret = value.length) {
  await act(async () => {
    const element = textarea();
    element.focus();
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.setSelectionRange(caret, caret);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function key(value: string, extra: KeyboardEventInit = {}) {
  let event!: KeyboardEvent;
  await act(async () => {
    event = new window.KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    textarea().dispatchEvent(event);
  });
  return event;
}

async function withView(
  run: (view: {
    getDraft(): ReturnType<typeof parseSkillDraft>;
    sends: string[];
    reads: string[];
    scrolled: string[];
    setThread(id: string): Promise<void>;
    setDraft(text: string): Promise<void>;
    api: {
      skills: {
        list: () => Promise<{
          skills: Array<typeof skill>;
          errors: string[];
          catalogBudgetBytes: number;
        }>;
      };
      workspaceFiles: {
        search: (id: string, query: string) => Promise<WorkspaceFileSearch>;
        validateReference: (
          id: string,
          path: string,
        ) => Promise<{ cwd: string; path: string; name: string }>;
      };
      threads: {
        list: () => Promise<
          Array<{
            threadId: string;
            name: string;
            preview: string;
            status: string;
            currentMetadata: { cwd: string };
          }>
        >;
      };
    };
  }) => Promise<void>,
) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => {},
    detachEvent: () => {},
  });
  const scrolled: string[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.id);
  };
  const sends: string[] = [];
  const reads: string[] = [];
  const api = {
    skills: {
      list: async () => ({
        skills: [skill],
        errors: [],
        catalogBudgetBytes: 16384,
      }),
    },
    workspaceFiles: {
      search: async (
        _id: string,
        _query: string,
      ): Promise<WorkspaceFileSearch> => ({
        cwd: "C:/workspace",
        entries: [],
        truncated: false,
        scanned: 0,
      }),
      validateReference: async (_id: string, path: string) => ({
        cwd: "C:/workspace",
        path,
        name: path.split("/").at(-1)!,
      }),
    },
    threads: {
      list: async (): Promise<
        Array<{
          threadId: string;
          name: string;
          preview: string;
          status: string;
          currentMetadata: { cwd: string };
        }>
      > => [],
    },
    protocol: {
      request: async (_method: string, params: { threadId: string }) => {
        reads.push(params.threadId);
        return { thread: thread(params.threadId) };
      },
    },
  };
  Object.assign(window, { zenx: api });
  const root = createRoot(document.getElementById("root")!);
  let composer = emptyComposerState();
  let activeThread = "current-thread";
  const render = () =>
    root.render(
      createElement(ThreadView, {
        approvals: [],
        composer,
        thread: thread(activeThread),
        onDraftChange: (text: string) => {
          composer = editComposer(composer, text);
          render();
        },
        onInterrupt: async () => {},
        onRespondToApproval: async () => {},
        onSubmit: async () => {
          sends.push(composer.draft.text);
        },
      }),
    );
  try {
    await act(async () => render());
    await run({
      api,
      sends,
      reads,
      scrolled,
      getDraft: () => parseSkillDraft(composer.draft.text),
      setThread: async (id) => {
        await act(async () => {
          activeThread = id;
          render();
        });
      },
      setDraft: async (text) => {
        await act(async () => {
          composer = editComposer(composer, text);
          render();
        });
      },
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

test("real input discards superseded file searches and searches from the previous thread", async () => {
  await withView(async ({ api, setThread }) => {
    const old = deferred<WorkspaceFileSearch>();
    const switched = deferred<WorkspaceFileSearch>();
    api.workspaceFiles.search = async (id, query) =>
      id === "next-thread"
        ? fileResult("next.txt")
        : query === "old"
          ? old.promise
          : query === "switch"
            ? switched.promise
            : fileResult("new.txt");
    await input("@old");
    await settleSearch();
    await input("@new");
    await settleSearch();
    assert.match(
      options()
        .map((row) => row.textContent)
        .join(" "),
      /new.txt/,
    );
    await act(async () => old.resolve(fileResult("old.txt")));
    assert.doesNotMatch(
      options()
        .map((row) => row.textContent)
        .join(" "),
      /old.txt/,
    );
    await input("@switch");
    await settleSearch();
    await setThread("next-thread");
    await settleSearch();
    await act(async () => switched.resolve(fileResult("previous-thread.txt")));
    assert.match(
      options()
        .map((row) => row.textContent)
        .join(" "),
      /next.txt/,
    );
    assert.doesNotMatch(
      options()
        .map((row) => row.textContent)
        .join(" "),
      /previous-thread.txt/,
    );
  });
});

test("duplicate thread names select canonical ID with keyboard, preserve tail, focus and active-descendant", async () => {
  await withView(async ({ api, getDraft, sends, reads, scrolled }) => {
    api.threads.list = async () =>
      ["aaaaaaaa-first", "bbbbbbbb-second"].map((threadId) => ({
        threadId,
        name: "Same title",
        preview: "",
        status: "idle",
        currentMetadata: { cwd: "C:/workspace" },
      }));
    await input("Ask @Same after", 9);
    await settleSearch();
    assert.equal(options().length, 2);
    assert.equal(
      textarea().getAttribute("aria-controls"),
      document.querySelector('[role="listbox"]')?.id,
    );
    await key("ArrowDown");
    const active = textarea().getAttribute("aria-activedescendant")!;
    assert.equal(
      document.getElementById(active)?.getAttribute("aria-selected"),
      "true",
    );
    assert.ok(scrolled.includes(active));
    await key("Enter");
    assert.deepEqual(reads, ["bbbbbbbb-second"]);
    assert.equal(getDraft().references[0]?.kind, "thread");
    assert.equal(
      (getDraft().references[0] as { id: string }).id,
      "bbbbbbbb-second",
    );
    assert.equal(getDraft().text, "Ask  after");
    assert.equal(document.activeElement, textarea());
    assert.deepEqual(sends, []);
  });
});

test("loading Enter, IME Enter and Escape do not send; Tab chooses a file reference", async () => {
  await withView(async ({ api, getDraft, sends }) => {
    const pending = deferred<WorkspaceFileSearch>();
    api.workspaceFiles.search = () => pending.promise;
    await input("@file");
    assert.equal((await key("Enter")).defaultPrevented, true);
    await key("Enter", { isComposing: true });
    await key("Escape");
    assert.equal(document.querySelector('[role="listbox"]'), null);
    assert.deepEqual(sends, []);
    await input("@file2");
    await settleSearch();
    await act(async () => pending.resolve(fileResult("文档 [draft] # %.bin")));
    await key("Tab");
    assert.equal(getDraft().references[0]?.name, "文档 [draft] # %.bin");
    assert.equal(document.activeElement, textarea());
    assert.deepEqual(sends, []);
  });
});

test("removing a selected reference preserves selected Skills and editable message", async () => {
  await withView(async ({ setDraft, getDraft, sends }) => {
    await setDraft(
      withSkillDraft(
        "Review this",
        [skill],
        [
          {
            kind: "file",
            name: "report.md",
            cwd: "C:/workspace",
            path: "report.md",
          },
        ],
      ),
    );
    const remove = document.querySelector<HTMLButtonElement>(
      '[aria-label="Remove reference report.md"]',
    );
    assert.ok(remove);
    await act(async () => remove.click());
    assert.deepEqual(getDraft().references, []);
    assert.deepEqual(getDraft().skills, [{ id: skill.id, name: skill.name }]);
    assert.equal(getDraft().text, "Review this");
    assert.deepEqual(sends, []);
  });
});

test("an in-flight file validation cannot edit the next thread's draft", async () => {
  await withView(async ({ api, setThread, setDraft, getDraft, sends }) => {
    const pending = deferred<{ cwd: string; path: string; name: string }>();
    api.workspaceFiles.search = async () => fileResult("selected.txt");
    api.workspaceFiles.validateReference = () => pending.promise;
    await input("@selected");
    await settleSearch();
    await key("Enter");
    await setThread("another-thread");
    await setDraft("Next thread draft");
    await act(async () =>
      pending.resolve({
        cwd: "C:/workspace",
        path: "selected.txt",
        name: "selected.txt",
      }),
    );
    assert.equal(getDraft().text, "Next thread draft");
    assert.deepEqual(getDraft().references, []);
    assert.deepEqual(sends, []);
  });
});

test("failed reference validation preserves input, announces the error and never sends", async () => {
  await withView(async ({ api, getDraft, sends }) => {
    api.workspaceFiles.search = async () => fileResult("deleted.txt");
    api.workspaceFiles.validateReference = async () => {
      throw new Error("ENOENT: deleted.txt disappeared");
    };
    await input("@deleted");
    await settleSearch();
    await key("Enter");
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /ENOENT.*deleted.txt/,
    );
    assert.equal(getDraft().text, "@deleted");
    assert.deepEqual(getDraft().references, []);
    assert.deepEqual(sends, []);
    assert.equal(document.activeElement, textarea());
  });
});

test("empty reference results prevent accidental Enter send until Escape dismisses the menu", async () => {
  await withView(async ({ sends }) => {
    await input("@unmatched");
    await settleSearch();
    assert.equal(options().length, 0);
    assert.ok(document.querySelector('[role="listbox"]'));
    assert.equal((await key("Enter")).defaultPrevented, true);
    assert.deepEqual(sends, []);
    await key("Escape");
    assert.equal(document.querySelector('[role="listbox"]'), null);
    await key("Enter");
    assert.deepEqual(sends, ["@unmatched"]);
  });
});

test("editing after Escape reopens the same reference query", async () => {
  await withView(async ({ api, sends }) => {
    api.workspaceFiles.search = async () => fileResult("same.txt");
    await input("@same");
    await settleSearch();
    assert.equal(options().length, 1);
    await key("Escape");
    assert.equal(document.querySelector('[role="listbox"]'), null);
    await input("@sam");
    await input("@same");
    await settleSearch();
    assert.match(options()[0]?.textContent ?? "", /same.txt/);
    assert.equal(document.activeElement, textarea());
    assert.deepEqual(sends, []);
  });
});

test("same-name Skills distinguish source and select the second native ID", async () => {
  await withView(async ({ api, getDraft, sends }) => {
    const second = {
      ...skill,
      id: "22222222-2222-2222-2222-222222222222",
      source: "D:/other/sample",
      directory: "C:/host/other-sample",
    };
    api.skills.list = async () => ({
      skills: [skill, second],
      errors: [],
      catalogBudgetBytes: 16384,
    });
    await input("/sample");
    assert.equal(options().length, 2);
    assert.match(options()[0]?.textContent ?? "", /C:\/skills\/sample/);
    assert.match(options()[1]?.textContent ?? "", /D:\/other\/sample/);
    await key("ArrowDown");
    await key("Tab");
    assert.deepEqual(getDraft().skills, [{ id: second.id, name: "sample" }]);
    assert.equal(getDraft().text, "");
    assert.deepEqual(sends, []);
  });
});
