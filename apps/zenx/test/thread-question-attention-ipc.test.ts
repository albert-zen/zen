import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isHostEvent } from "../src/main/host-messages.js";

test("Thread question attention Host event is content-free and rejects authored payloads", () => {
  const type = "thread-question/attention-invalidated";
  assert.equal(isHostEvent({ type }), true);
  for (const payload of [
    { threadId: "private" },
    { question: "Private question text" },
    { roomId: "not-a-Room-event" },
    { kind: "membership" },
  ])
    assert.equal(isHostEvent({ type, ...payload }), false);
  assert.equal(
    isHostEvent(Object.assign(Object.create({ type }), { other: true })),
    false,
  );
  assert.equal(
    isHostEvent(
      new Proxy(
        {},
        {
          has() {
            throw Error("hostile access");
          },
        },
      ),
    ),
    false,
  );
});

test("actual preload attention subscription strips event data and removes the exact listener", async () => {
  const source = await readFile(
    new URL("../src/preload/index.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "preload.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let property: ts.PropertyAssignment | undefined;
  const find = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(ast) === "threadQuestionAttention"
    )
      property = node;
    ts.forEachChild(node, find);
  };
  find(ast);
  assert.ok(property && ts.isObjectLiteralExpression(property.initializer));
  const registrations: Array<{
    channel: string;
    listener: (...args: unknown[]) => void;
  }> = [];
  const removals: typeof registrations = [];
  const executable = ts.transpileModule(
    `const api = ${property.initializer.getText(ast)}; api;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const api = runInNewContext(executable, {
    ipcChannels: {
      threadQuestionAttentionChanged: "synthetic-attention-channel",
    },
    ipcRenderer: {
      on(channel: string, listener: (...args: unknown[]) => void) {
        registrations.push({ channel, listener });
      },
      removeListener(channel: string, listener: (...args: unknown[]) => void) {
        removals.push({ channel, listener });
      },
    },
  });
  const received: unknown[][] = [];
  const end = api.onChanged((...args: unknown[]) => received.push(args));
  assert.equal(registrations.length, 1);
  registrations[0]!.listener(
    { sender: "never exposed" },
    "private Thread content",
  );
  assert.deepEqual(received, [[]]);
  end();
  assert.deepEqual(removals, registrations);
});

test("actual App uses native question attention as catalog fallback only without the standalone bridge", async () => {
  const source = await readFile(
    new URL("../src/renderer/src/App.tsx", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "App.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let fallback: ts.IfStatement | undefined;
  const find = (node: ts.Node) => {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(ast).startsWith("nativeQuestionAttention &&")
    )
      fallback = node;
    ts.forEachChild(node, find);
  };
  find(ast);
  assert.ok(fallback);
  const executable = ts.transpileModule(fallback.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const available of [false, true]) {
    let reads = 0;
    runInNewContext(executable, {
      nativeQuestionAttention: true,
      window: { zenx: { threadQuestionAttention: available ? {} : undefined } },
      questionAttentionChanged: () => reads++,
    });
    assert.equal(reads, available ? 0 : 1);
  }
});
