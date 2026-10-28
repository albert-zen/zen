import { unwrapCompactionIpcReply } from "../src/preload/compaction-ipc.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { requestQueuedEdit } from "../src/renderer/src/queue-edit-request.js";
import { i18n } from "../src/renderer/src/i18n.js";
import {
  queueEditIpcRejection,
  unwrapQueueEditIpcReply,
} from "../src/preload/queue-edit-ipc.js";
import type { NativeQueueEditParams } from "../../../src/protocol/native/wire.js";

const require = createRequire(import.meta.url);
const source = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));
const mainBundle = await build({
  entryPoints: [source("../src/main/protocol-request-ipc.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  packages: "external",
  write: false,
});
const preloadBundle = await build({
  entryPoints: [source("../src/preload/index.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  packages: "external",
  write: false,
});
function runBundle(code: string, electron: unknown) {
  const module = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    "process",
    "__dirname",
    "__filename",
    code,
  )(
    (name: string) => (name === "electron" ? electron : require(name)),
    module,
    module.exports,
    process,
    path.dirname(source("../src/preload/index.ts")),
    source("../src/preload/index.ts"),
  );
  return module.exports;
}

/** Exercise the actual registration + complete preload, stripping thrown Error fields
 * at both Electron boundaries and structured-cloning fulfilled reply values. */
function boundary(
  request: (method: string, params: unknown) => Promise<unknown>,
) {
  let handler!: (...args: unknown[]) => Promise<unknown>;
  let exposed!: Window["zenx"];
  const electron = {
    ipcMain: {
      handle(_channel: string, callback: typeof handler) {
        handler = callback;
      },
    },
    ipcRenderer: {
      async invoke(_channel: string, ...args: unknown[]) {
        try {
          return structuredClone(await handler({}, ...structuredClone(args)));
        } catch (error) {
          throw new Error(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    contextBridge: {
      exposeInMainWorld(_name: string, api: Window["zenx"]) {
        exposed = api;
      },
    },
  };
  const main = runBundle(
    mainBundle.outputFiles![0]!.text,
    electron,
  ) as typeof import("../src/main/protocol-request-ipc.js");
  main.registerProtocolRequestIpc(
    { request } as Parameters<typeof main.registerProtocolRequestIpc>[0],
    () => undefined,
  );
  runBundle(preloadBundle.outputFiles![0]!.text, electron);
  const bridgeRequest = async (method: string, params: unknown) => {
    try {
      return structuredClone(
        await exposed.protocol.request(
          method as never,
          structuredClone(params) as never,
        ),
      );
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  };
  return { handler, request: bridgeRequest };
}
const params: NativeQueueEditParams = {
  threadId: "thread",
  queuedItemId: "queue",
  clientId: "client",
  expectedRevision: 0,
  editId: "edit",
  input: [{ type: "text", text: "changed" }],
};
const original = {
  type: "user_message_queued",
  id: "queue",
  threadId: "thread",
  clientId: "client",
  createdAt: "2026-10-12T00:00:00.000Z",
  input: [{ type: "text", text: "original" }],
};
async function withBridge<T>(
  request: (method: string, params: unknown) => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { zenx: { protocol: { request } } },
  });
  try {
    return await run();
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

for (const [code, key] of [
  ["attachment_missing", "queueEditAttachmentUnavailable"],
  ["queue_edit_unsupported_input", "queueEditUnsupported"],
  ["queue_revision_conflict", "queueEditConflict"],
  ["queue_already_started", "queueEditNoLongerPending"],
] as const)
  test(`known ${code} survives main/preload serialization and gives the actual renderer a localized repair reason`, async () => {
    const calls: string[] = [];
    const bridge = boundary(async (method) => {
      calls.push(method);
      throw Object.assign(
        new Error("raw /Users/private/attachment.png secret=never-display"),
        {
          code: -32602,
          data: { zenCode: code, rawPath: "/private/host-path" },
        },
      );
    });
    const raw = await bridge.handler({}, "zen/thread/queue/edit", params);
    assert.ok(typeof (raw as { detail?: string }).detail === "string");
    assert.deepEqual(
      { ...(raw as object), detail: undefined },
      {
        detail: undefined,
        type: "zenx.queue-edit-rejection.v1",
        data: { zenCode: code },
        message: "raw /Users/private/attachment.png secret=never-display",
      },
    );
    assert(JSON.stringify(raw).includes("/Users/private/attachment.png"));
    calls.length = 0;
    await withBridge(bridge.request, async () => {
      await assert.rejects(requestQueuedEdit(params), {
        message: i18n.t(`shell:${key}`),
      });
    });
    assert.deepEqual(calls, ["zen/thread/queue/edit"]); // No uncertain-outcome recovery read.
  });

test("successful edit result is unchanged across the real registration and preload", async () => {
  const result = {
    queuedItemId: "queue",
    clientId: "client",
    revision: 1,
    editItemId: "fact",
    status: "edited",
  };
  const bridge = boundary(async () => result);
  await withBridge(bridge.request, async () =>
    assert.deepEqual(await requestQueuedEdit(params), result),
  );
});

test("unknown edit failures preserve Host diagnostics and retain exactly one read-only recovery", async () => {
  const calls: string[] = [];
  const bridge = boundary(async (method) => {
    calls.push(method);
    if (method === "zen/thread/read")
      return { thread: { id: params.threadId, items: [original] } };
    throw Object.assign(new Error("unknown /private/secret-host-path"), {
      data: { zenCode: "/private/untrusted-code" },
    });
  });
  await assert.rejects(bridge.request("zen/thread/queue/edit", params), {
    message: "unknown /private/secret-host-path",
  });
  calls.length = 0;
  let recovered = 0;
  await withBridge(bridge.request, async () => {
    await assert.rejects(
      requestQueuedEdit(params, () => {
        recovered++;
      }),
      {
        message: i18n.t("shell:queueEditUnconfirmed"),
      },
    );
  });
  assert.deepEqual(calls, ["zen/thread/queue/edit", "zen/thread/read"]);
  assert.equal(recovered, 1);
});

test("uncertain edit recovery still finds its immutable receipt without resending", async () => {
  const calls: string[] = [];
  const bridge = boundary(async (method) => {
    calls.push(method);
    if (method === "zen/thread/read")
      return {
        thread: {
          id: params.threadId,
          items: [
            original,
            {
              type: "user_message_queue_edited",
              id: "fact",
              threadId: "thread",
              createdAt: original.createdAt,
              queuedItemId: "queue",
              clientId: "client",
              revision: 1,
              editId: "edit",
              input: params.input,
            },
          ],
        },
      };
    throw new Error("acknowledgement lost");
  });
  const recovered: unknown[] = [];
  await withBridge(bridge.request, async () =>
    assert.deepEqual(
      await requestQueuedEdit(params, (snapshot) => {
        recovered.push(snapshot);
      }),
      {
        status: "already_edited",
        queuedItemId: "queue",
        clientId: "client",
        revision: 1,
        editItemId: "fact",
      },
    ),
  );
  assert.deepEqual(calls, ["zen/thread/queue/edit", "zen/thread/read"]);
  assert.equal(recovered.length, 1);
  const snapshot = recovered[0] as {
    thread: { items: Array<{ type: string; id: string }> };
  };
  assert.equal(snapshot.thread.items[1]?.type, "user_message_queue_edited");
  assert.equal(snapshot.thread.items[1]?.id, "fact");
});

test("other RPC failures and replies preserve the existing IPC behavior", async () => {
  const failure = Object.assign(new Error("existing error"), {
    data: { zenCode: "attachment_missing" },
  });
  const rejected = boundary(async () => {
    throw failure;
  });
  await assert.rejects(
    rejected.handler({}, "turn/start", {}),
    (error) => error === failure,
  );
  await assert.rejects(rejected.request("turn/start", {}), {
    message: "existing error",
  });
  const reply = { value: "untouched" };
  const successful = boundary(async () => reply);
  assert.deepEqual(await successful.request("account/read", {}), reply);
  assert.equal(
    queueEditIpcRejection({ data: { zenCode: "unknown" } }),
    undefined,
  );
  assert.throws(
    () =>
      unwrapQueueEditIpcReply({
        type: "zenx.queue-edit-rejection.v1",
        data: { zenCode: "unknown" },
      }),
    /unconfirmed/u,
  );
});

test("queue edit recovery rejects a snapshot from another thread without refreshing the viewport", async () => {
  let recovered = 0;
  const bridge = boundary(async (method) => {
    if (method === "zen/thread/read")
      return { thread: { id: "other-thread", items: [original] } };
    throw new Error("response lost");
  });
  await withBridge(bridge.request, async () =>
    assert.rejects(
      requestQueuedEdit(params, () => {
        recovered++;
      }),
      { message: i18n.t("shell:queueEditUnconfirmed") },
    ),
  );
  assert.equal(recovered, 0);
});

test("compaction service code and original diagnostic survive main, preload and contextBridge", async () => {
  const message =
    "HTTP 400 invalid_parameter_error: developer is not an allowed role";
  const bridge = boundary(async () => {
    throw Object.assign(new Error(message), {
      code: -32000,
      data: { zenCode: "compaction_generation_failed" },
    });
  });
  const reply = await bridge.request("thread/compact", {
    threadId: "synthetic",
  });
  assert.throws(() => unwrapCompactionIpcReply(reply as never), {
    message,
    zenCode: "compaction_generation_failed",
  });
});

test("compaction unknown failure preserves diagnostics without inventing a semantic code", async () => {
  const bridge = boundary(async () => {
    throw new Error("Connection closed after dispatch");
  });
  const reply = await bridge.request("thread/compact", {
    threadId: "synthetic",
  });
  assert.throws(
    () => unwrapCompactionIpcReply(reply as never),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Connection closed after dispatch" &&
      (error as { zenCode?: unknown }).zenCode === undefined,
  );
});

test("compaction successful receipt survives the same bridge unchanged", async () => {
  const receipt = { compactionItemId: "synthetic-compaction" };
  const bridge = boundary(async () => receipt);
  const reply = await bridge.request("thread/compact", {
    threadId: "synthetic",
  });
  assert.deepEqual(unwrapCompactionIpcReply(reply as never), receipt);
});

test("missing compaction receipt cannot be presented as confirmed success", () => {
  for (const reply of [null, undefined, {}, { compactionItemId: "" }]) {
    assert.throws(
      () => unwrapCompactionIpcReply(reply as never),
      /did not contain a committed compaction receipt/u,
    );
  }
});
