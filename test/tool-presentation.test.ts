import assert from "node:assert/strict";
import test from "node:test";

import type { ModelTool } from "../src/model.js";
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";
import { testToolRuntime } from "./tool-fixtures.js";
import {
  buildToolPresentation,
  COMPACT_CONTEXT_NAME,
  createRunCodeModelTool,
  generateToolSdk,
} from "../src/tool-presentation.js";

const ordinaryTools: ModelTool[] = [
  {
    name: "shell",
    description: "Run a command",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "plugin.tool-name",
    description: "Namespaced fixture",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "integer" },
        "invalid-key": { type: "boolean" },
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "default",
    description: "Reserved-word fixture",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "malformed",
    description: "Malformed schema fixture",
    inputSchema: { type: "definitely-not-json-schema" },
  },
];

test("runtime concurrency declarations reach both SDK and discovery descriptions", () => {
  const parallel = testToolRuntime({
    name: "read_rows",
    description: "Read rows.",
    executionMode: "parallel_safe",
    execute: async () => ({ output: "", exitCode: 0 }),
  });
  const exclusive = testToolRuntime({
    name: "edit_rows",
    description: "Edit rows.",
    execute: async () => ({ output: "", exitCode: 0 }),
  });
  const environment = new ToolEnvironment({
    runtimes: [new ShellToolRuntime(), parallel, exclusive],
  });
  const snapshot = buildToolPresentation(
    [...environment.definitions, createRunCodeModelTool([])],
    "both",
  );
  for (const name of ["shell", "read_rows"]) {
    assert.match(
      snapshot.codeTools.find((tool) => tool.name === name)!.description,
      /^\[parallel_safe\]/,
    );
    assert.match(
      snapshot.modelTools.find((tool) => tool.name === name)!.description,
      /^\[parallel_safe\]/,
    );
  }
  assert.equal(
    snapshot.codeTools.find((tool) => tool.name === "edit_rows")!.description,
    "Edit rows.",
  );
  assert.match(
    snapshot.modelTools.find((tool) => tool.name === "run_code")!.description,
    /\[parallel_safe\] Read rows\./,
  );
  assert.equal(parallel.specification.description, "Read rows.");
});

test("presentation modes project one frozen ordinary-tool snapshot", () => {
  const definitions = structuredClone([
    ...ordinaryTools,
    createRunCodeModelTool([]),
  ]);
  const direct = buildToolPresentation(definitions, "direct");
  const code = buildToolPresentation(definitions, "code");
  const both = buildToolPresentation(definitions, "both");

  assert.deepEqual(
    direct.modelTools.map((tool) => tool.name),
    ordinaryTools.map((tool) => tool.name),
  );
  assert.deepEqual(
    code.modelTools.map((tool) => tool.name),
    ["run_code"],
  );
  assert.deepEqual(
    both.modelTools.map((tool) => tool.name),
    [...ordinaryTools.map((tool) => tool.name), "run_code"],
  );
  assert.deepEqual(
    [...direct.nestedToolNames],
    ordinaryTools.map(({ name }) => name),
  );
  assert.deepEqual(
    [...code.nestedToolNames],
    ordinaryTools.map(({ name }) => name),
  );
  assert.deepEqual(
    [...both.nestedToolNames],
    ordinaryTools.map(({ name }) => name),
  );
  assert.deepEqual(
    [...direct.modelToolNames],
    ordinaryTools.map(({ name }) => name),
  );
  assert.deepEqual([...code.modelToolNames], ["run_code"]);

  const codeDescription = code.modelTools[0]?.description ?? "";
  assert.equal(codeDescription, both.modelTools.at(-1)?.description);
  assert.match(codeDescription, /\n  shell\(args:/u);
  assert.match(codeDescription, /\n  "plugin\.tool-name"\(args:/u);
  assert.match(
    codeDescription,
    /Invoke as tools\["plugin\.tool-name"\]\(\.\.\.\)/u,
  );
  assert.match(codeDescription, /\n  default\(args:/u);
  assert.match(codeDescription, /\n  malformed\(args: unknown\)/u);
  assert.doesNotMatch(codeDescription, /\n  run_code\(|\n  "run_code"\(/u);

  assert.deepEqual(
    code.codeTools,
    ordinaryTools.map(({ name, description }) => ({ name, description })),
  );
  assert.deepEqual(code.codeTools, both.codeTools);
  assert.deepEqual(code.codeTools, direct.codeTools);
  assert.ok(Object.isFrozen(code.codeTools));
  assert.ok(code.codeTools.every((tool) => Object.isFrozen(tool)));
  definitions[0]!.description = "mutated";
  assert.equal(code.codeTools[0]?.description, "Run a command");
  assert.equal(direct.modelTools[0]?.description, "Run a command");
});

test("SDK generation is deterministic and quotes illegal identifiers", () => {
  const sdk = generateToolSdk(ordinaryTools);
  assert.equal(sdk, generateToolSdk(structuredClone(ordinaryTools)));
  assert.match(
    sdk,
    /shell\(args: \{ \/\*\* Command to execute\. \*\/ command: string; \}\)/u,
  );
  assert.match(
    sdk,
    /"plugin\.tool-name"\(args: \{ value: number; "invalid-key"\?: boolean; \}\)/u,
  );
  assert.match(sdk, /default\(args: \{ \}\)/u);
  assert.match(sdk, /malformed\(args: unknown\)/u);
  assert.match(sdk, /Run a command/u);
  assert.match(sdk, /Command to execute\./u);
  const runCode = createRunCodeModelTool(ordinaryTools);
  assert.match(runCode.description, /JavaScript async module/u);
  assert.match(runCode.description, /No Node.js, filesystem, network/u);
  assert.match(runCode.description, /submitted code must be JavaScript/u);
});

test("code presentation requires the registered run_code execution capability", () => {
  assert.throws(
    () => buildToolPresentation(ordinaryTools, "code"),
    /requires a registered run_code runtime/u,
  );
  assert.throws(
    () => buildToolPresentation(ordinaryTools, "both"),
    /requires a registered run_code runtime/u,
  );
});

test("compact_context stays top-level in every presentation mode", () => {
  const compactContext: ModelTool = {
    name: COMPACT_CONTEXT_NAME,
    description: "Compact the current context.",
    inputSchema: { type: "object", additionalProperties: false },
  };
  const definitions = [
    ...ordinaryTools,
    compactContext,
    createRunCodeModelTool([]),
  ];

  const direct = buildToolPresentation(definitions, "direct");
  const code = buildToolPresentation(definitions, "code");
  const both = buildToolPresentation(definitions, "both");
  assert.deepEqual(
    direct.modelTools.map(({ name }) => name),
    [...ordinaryTools.map(({ name }) => name), COMPACT_CONTEXT_NAME],
  );
  assert.deepEqual(
    code.modelTools.map(({ name }) => name),
    ["run_code", COMPACT_CONTEXT_NAME],
  );
  assert.deepEqual(
    both.modelTools.map(({ name }) => name),
    [
      ...ordinaryTools.map(({ name }) => name),
      COMPACT_CONTEXT_NAME,
      "run_code",
    ],
  );
  assert.equal(code.modelToolNames.has(COMPACT_CONTEXT_NAME), true);
  assert.equal(code.nestedToolNames.has(COMPACT_CONTEXT_NAME), false);
  assert.doesNotMatch(
    code.modelTools[0]!.description,
    /tools\.compact_context/u,
  );

  assert.throws(
    () =>
      buildToolPresentation(
        [...definitions, structuredClone(compactContext)],
        "code",
      ),
    /at most one valid compact_context definition/u,
  );
});
