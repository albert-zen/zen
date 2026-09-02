import assert from "node:assert/strict";
import test from "node:test";

import type { ModelTool } from "../src/model.js";
import {
  buildToolPresentation,
  createRunCodeModelTool,
  generateToolSdk,
} from "../src/tool-presentation.js";

const ordinaryTools: ModelTool[] = [
  {
    name: "shell",
    description: "Run a command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
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

test("presentation modes project one frozen ordinary-tool snapshot", () => {
  const definitions = [...ordinaryTools, createRunCodeModelTool([])];
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

  definitions[0]!.description = "mutated";
  assert.equal(direct.modelTools[0]?.description, "Run a command");
});

test("SDK generation is deterministic and quotes illegal identifiers", () => {
  const sdk = generateToolSdk(ordinaryTools);
  assert.equal(sdk, generateToolSdk(structuredClone(ordinaryTools)));
  assert.match(sdk, /shell\(args: \{ command: string; \}\)/u);
  assert.match(
    sdk,
    /"plugin\.tool-name"\(args: \{ value: number; "invalid-key"\?: boolean; \}\)/u,
  );
  assert.match(sdk, /default\(args: \{ \}\)/u);
  assert.match(sdk, /malformed\(args: unknown\)/u);
});

test("code presentation requires the registered run_code execution capability", () => {
  assert.throws(
    () => buildToolPresentation(ordinaryTools, "code"),
    /requires a registered run_code provider/u,
  );
  assert.throws(
    () => buildToolPresentation(ordinaryTools, "both"),
    /requires a registered run_code provider/u,
  );
});
