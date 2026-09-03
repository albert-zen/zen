import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { ToolEnvironment } from "../src/tool.js";

test("the default Host exposes one apply_patch runtime through direct and code presentation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-host-patch-"));
  const host = createHostedAppServer({
    cwd: directory,
    dataDirectory: path.join(directory, "data"),
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    toolPresentation: "both",
  });
  try {
    const directPatch =
      "*** Begin Patch\n*** Add File: direct.txt\n+direct\n*** End Patch";
    const direct = await host.startThread();
    await (
      await host.startTurn(
        direct.id,
        `!tool apply_patch ${JSON.stringify({ patch: directPatch })}`,
      )
    ).done;

    const codePatch =
      "*** Begin Patch\n*** Add File: code.txt\n+code\n*** End Patch";
    const code = await host.startThread();
    await (
      await host.startTurn(
        code.id,
        `!tool run_code ${JSON.stringify({
          code: `const result = await tools.apply_patch(${JSON.stringify({ patch: codePatch })}); text(result.output);`,
          description: "edit through nested tools",
        })}`,
      )
    ).done;

    assert.equal(
      await readFile(path.join(directory, "direct.txt"), "utf8"),
      "direct\n",
    );
    assert.equal(
      await readFile(path.join(directory, "code.txt"), "utf8"),
      "code\n",
    );
    const calls = (await host.readThread(code.id)).items.filter(
      (item) => item.type === "tool_call",
    );
    assert.deepEqual(
      calls.map((item) => [item.name, item.parentCallId ?? null]),
      [
        ["run_code", null],
        ["apply_patch", calls[0]?.callId],
      ],
    );
  } finally {
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host rejects a caller-supplied runtime that collides with reserved apply_patch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-host-patch-"));
  const toolEnvironment = new ToolEnvironment({
    runtimes: [
      {
        name: "apply_patch",
        specification: {
          name: "apply_patch",
          description: "Caller-owned patch runtime",
          inputSchema: { type: "object" },
        },
        execute: async () => ({ output: "caller runtime", exitCode: 0 }),
      },
    ],
  });
  try {
    assert.throws(
      () =>
        createHostedAppServer({
          cwd: directory,
          dataDirectory: path.join(directory, "data"),
          model: "fake",
          models: ["fake"],
          approvalPolicy: "never",
          provider: { type: "fake" },
          toolPresentation: "direct",
          toolEnvironment,
        }),
      /Tool name apply_patch is reserved for the builtin runtime/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the default Host composition publishes run_code and canonical child lineage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-host-code-"));
  const host = createHostedAppServer({
    cwd: directory,
    dataDirectory: directory,
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(
        thread.id,
        '!tool run_code {"code":"const value: number = 40 + 2; const nested = await tools.shell({ command: \\\"printf child\\\" }); text(`${value}:${nested.output}`);","description":"host composition tracer"}',
      )
    ).done;

    const snapshot = await host.readThread(thread.id);
    const calls = snapshot.items.filter((item) => item.type === "tool_call");
    const results = snapshot.items.filter(
      (item) => item.type === "tool_result",
    );
    assert.deepEqual(
      calls.map((item) => [item.name, item.parentCallId ?? null]),
      [
        ["run_code", null],
        ["shell", calls[0]?.callId],
      ],
    );
    assert.equal(results.at(-1)?.output, "42:child");
  } finally {
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host mode failure is strict for code and warning-backed for both", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-host-mode-"));
  const missingWorker = new URL(
    `file://${path.join(directory, "missing-worker.js")}`,
  );
  const base = {
    cwd: directory,
    dataDirectory: directory,
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never" as const,
    provider: { type: "fake" as const },
    codeRuntimeOptions: { workerUrl: missingWorker },
  };
  try {
    assert.throws(
      () => createHostedAppServer({ ...base, toolPresentation: "code" }),
      /Code Runtime initialization failed.*missing-worker/u,
    );

    const warnings: string[] = [];
    const fallback = createHostedAppServer({
      ...base,
      toolPresentation: "both",
      onToolPresentationWarning: (warning) => warnings.push(warning),
    });
    try {
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /falling back to direct tools/u);
      const thread = await fallback.startThread();
      await (
        await fallback.startTurn(
          thread.id,
          '!tool run_code {"code":"text(1)","description":"unavailable"}',
        )
      ).done;
      const snapshot = await fallback.readThread(thread.id);
      assert.equal(
        snapshot.items.some(
          (item) => item.type === "tool_call" && item.name === "run_code",
        ),
        false,
      );
    } finally {
      await fallback.closeHostResources();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct, code, and both publish only their configured model entry points", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-host-modes-"));
  try {
    for (const testCase of [
      { mode: "direct", direct: true, code: false },
      { mode: "code", direct: false, code: true },
      { mode: "both", direct: true, code: true },
    ] as const) {
      const host = createHostedAppServer({
        cwd: directory,
        dataDirectory: path.join(directory, testCase.mode),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
        toolPresentation: testCase.mode,
      });
      try {
        const direct = await host.startThread();
        await (
          await host.startTurn(
            direct.id,
            '!tool shell {"command":"printf direct"}',
          )
        ).done;
        const directSnapshot = await host.readThread(direct.id);
        assert.equal(
          directSnapshot.items.some(
            (item) => item.type === "tool_call" && item.name === "shell",
          ),
          testCase.direct,
        );

        const code = await host.startThread();
        await (
          await host.startTurn(
            code.id,
            '!tool run_code {"code":"text(\\"code\\")","description":"mode probe"}',
          )
        ).done;
        const codeSnapshot = await host.readThread(code.id);
        assert.equal(
          codeSnapshot.items.some(
            (item) => item.type === "tool_call" && item.name === "run_code",
          ),
          testCase.code,
        );
      } finally {
        await host.closeHostResources();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("switching to direct keeps canonical run_code history replayable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-host-rollback-"));
  let threadId: string;
  const both = createHostedAppServer({
    cwd: directory,
    dataDirectory: directory,
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    toolPresentation: "both",
  });
  try {
    const thread = await both.startThread();
    threadId = thread.id;
    await (
      await both.startTurn(
        thread.id,
        '!tool run_code {"code":"const child = await tools.shell({ command: \\"printf replay\\" }); text(child.output);","description":"rollback history"}',
      )
    ).done;
  } finally {
    await both.closeHostResources();
  }

  const direct = createHostedAppServer({
    cwd: directory,
    dataDirectory: directory,
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    toolPresentation: "direct",
  });
  try {
    const replayed = await direct.readThread(threadId!);
    const calls = replayed.items.filter((item) => item.type === "tool_call");
    assert.deepEqual(
      calls.map((item) => [item.name, item.parentCallId ?? null]),
      [
        ["run_code", null],
        ["shell", calls[0]?.callId],
      ],
    );
    const fresh = await direct.startThread();
    await (
      await direct.startTurn(
        fresh.id,
        '!tool shell {"command":"printf direct"}',
      )
    ).done;
    assert.equal(
      (await direct.readThread(fresh.id)).items.some(
        (item) => item.type === "tool_call" && item.name === "shell",
      ),
      true,
    );
  } finally {
    await direct.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});
