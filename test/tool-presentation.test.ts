import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { ViewImageToolRuntime } from "../src/view-image.js";

import type { ModelTool } from "../src/model.js";
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";
import { testToolRuntime } from "./tool-fixtures.js";
import {
  buildToolPresentation,
  COMPACT_CONTEXT_NAME,
  createRunCodeModelTool,
  generateToolSdk,
  generateToolCatalog,
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
  assert.doesNotMatch(
    snapshot.modelTools.find((tool) => tool.name === "run_code")!.description,
    /Read rows/,
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
  assert.equal(codeDescription, createRunCodeModelTool([]).description);
  assert.match(codeDescription, /Filter\/map it in JavaScript/u);
  assert.doesNotMatch(codeDescription, /shell\(args:|plugin\.tool-name/u);

  assert.deepEqual(code.codeTools, generateToolCatalog(ordinaryTools));
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

test("code SDK preserves sibling properties with required-only alternatives", () => {
  for (const keyword of ["oneOf", "anyOf"]) {
    const sdk = generateToolSdk([
      {
        name: "inspect_target",
        description: "Inspect an exact target.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", description: "Unique target name." },
            threadId: { type: "string", description: "Exact Thread ID." },
            turnId: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["turnId"],
          [keyword]: [{ required: ["target"] }, { required: ["threadId"] }],
          additionalProperties: false,
        },
      },
    ]);
    assert.doesNotMatch(sdk, /inspect_target\(args: unknown\)/u);
    assert.match(sdk, /Unique target name\./u);
    assert.match(sdk, /Exact Thread ID\./u);
    assert.match(sdk, /target: string;/u);
    assert.match(sdk, /threadId: string;/u);
    assert.match(sdk, /turnId: string;/u);
    assert.match(sdk, /limit\?: number;/u);
    if (keyword === "oneOf") {
      assert.match(sdk, /target\?: never;/u);
      assert.match(sdk, /threadId\?: never;/u);
    } else {
      assert.doesNotMatch(sdk, /(?:target|threadId)\?: never/u);
    }
  }
});

test("required-only alternatives keep nested schemas and direct definitions intact", () => {
  const definition: ModelTool = {
    name: "view_image",
    description: "View an image.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative to Thread cwd." },
        attachment: {
          type: "object",
          properties: { sha256: { type: "string" } },
          required: ["sha256"],
        },
      },
      oneOf: [{ required: ["path"] }, { required: ["attachment"] }],
      additionalProperties: false,
    },
  };
  const before = structuredClone(definition);
  const sdk = generateToolSdk([definition]);
  assert.match(sdk, /attachment: \{ sha256: string; \}/u);
  assert.match(sdk, /Relative to Thread cwd/u);
  assert.deepEqual(definition, before);
  assert.deepEqual(buildToolPresentation([definition], "direct").modelTools, [
    before,
  ]);
});

test("shipped image and first-party schemas retain code-mode argument contracts", () => {
  const image = new ViewImageToolRuntime({
    attachments: new InMemoryAttachmentStore(),
    journal: new InMemoryThreadJournal(),
  }).specification;
  const imageSdk = generateToolSdk([image]);
  assert.match(imageSdk, /path: string;/u);
  assert.match(imageSdk, /attachment: \{/u);
  assert.match(imageSdk, /sha256: string;/u);
  assert.doesNotMatch(imageSdk, /view_image\(args: unknown\)/u);

  for (const plugin of ["self-control", "fleet", "rooms"]) {
    const manifest = JSON.parse(
      readFileSync(`packages/zenx-${plugin}-plugin/zenx.plugin.json`, "utf8"),
    ) as { tools: ModelTool[] };
    const sdk = generateToolSdk(manifest.tools);
    assert.doesNotMatch(sdk, /\(args: unknown\)/u, plugin);
    if (plugin === "self-control") {
      const send = manifest.tools.find(
        (tool) => tool.name === "zenx_threads_send",
      )!;
      const sendSdk = generateToolSdk([send]);
      assert.match(sendSdk, /target: string;/u);
      assert.match(sendSdk, /threadId: string;/u);
      assert.match(sendSdk, /text: string;/u);
      assert.match(sendSdk, /messageType\?:/u);
    }
  }
});
