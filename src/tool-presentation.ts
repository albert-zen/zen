import type { ModelTool } from "./model.js";

export type ToolPresentation = "direct" | "code" | "both";

export interface ToolPresentationSnapshot {
  readonly modelTools: readonly ModelTool[];
  /** Frozen metadata from this exact disclosed sample for ALL_TOOLS. */
  readonly codeTools: readonly {
    readonly name: string;
    readonly description: string;
  }[];
  /** Names a model response may submit directly for this sample. */
  readonly modelToolNames: ReadonlySet<string>;
  /** Names the run_code Worker may invoke for this sample. */
  readonly nestedToolNames: ReadonlySet<string>;
}

const RUN_CODE_NAME = "run_code";
export const COMPACT_CONTEXT_NAME = "compact_context";

/** Build both model entry points from one immutable definition snapshot. */
export function buildToolPresentation(
  definitions: readonly ModelTool[],
  mode: ToolPresentation,
): ToolPresentationSnapshot {
  const snapshot = definitions.map((definition) => structuredClone(definition));
  const runCodeCount = snapshot.filter(
    (definition) => definition.name === RUN_CODE_NAME,
  ).length;
  const compactContextTools = snapshot.filter(
    (definition) => definition.name === COMPACT_CONTEXT_NAME,
  );
  if (
    compactContextTools.length > 1 ||
    compactContextTools.some(
      (definition) =>
        typeof definition.description !== "string" ||
        definition.description.trim().length === 0 ||
        !isRecord(definition.inputSchema),
    )
  ) {
    throw new Error(
      "Tool presentation accepts at most one valid compact_context definition",
    );
  }
  const ordinaryTools = snapshot.filter(
    (definition) =>
      definition.name !== RUN_CODE_NAME &&
      definition.name !== COMPACT_CONTEXT_NAME,
  );
  if (mode !== "direct" && runCodeCount !== 1) {
    throw new Error(
      "Tool presentation code requires a registered run_code runtime",
    );
  }

  const modelTools =
    mode === "direct"
      ? [...ordinaryTools, ...compactContextTools]
      : mode === "code"
        ? [createRunCodeModelTool(ordinaryTools), ...compactContextTools]
        : [
            ...ordinaryTools,
            ...compactContextTools,
            createRunCodeModelTool(ordinaryTools),
          ];
  return Object.freeze({
    codeTools: Object.freeze(
      generateToolCatalog(ordinaryTools).map((tool) => Object.freeze(tool)),
    ),
    modelTools: Object.freeze(
      modelTools.map((definition) => deepFreeze(definition)),
    ),
    modelToolNames: new Set(modelTools.map((definition) => definition.name)),
    nestedToolNames: new Set(
      ordinaryTools.map((definition) => definition.name),
    ),
  });
}

export function createRunCodeModelTool(
  ordinaryTools: readonly ModelTool[],
): ModelTool {
  const sdk = generateToolSdk(ordinaryTools);
  return {
    name: RUN_CODE_NAME,
    rawSource: { language: "javascript", argument: "code" },
    description: [
      "Run a fresh JavaScript async module with top-level await.",
      "Use pure JavaScript, not TypeScript syntax. No Node.js, filesystem, network, process, require, or package imports; use tools.* for external actions.",
      "In-memory helpers: atob/btoa, TextEncoder/TextDecoder, URL/URLSearchParams, crypto.randomUUID(). import.meta is unavailable.",
      "Only the tools declared below are available through tools.*. Select output with text/image/audio; the last expression is not returned automatically.",
      'Optional first line: // @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000, "timeout_ms": 600000}. Controls observation wait, preview budget, and execution deadline respectively.',
      "Awaited tools return their final result. A running outer program returns a task_id; use tools.wait with that task_id to observe new output or completion.",
      "Tools marked [parallel_safe] can overlap in Promise.all within the host limit; unmarked tools serialize. Await dependent operations sequentially.",
      "Check exitCode before using tool output: tool failures, invalid parameters and unknown names return nonzero codes. Serialization and bridge errors can throw.",
      "Await every tool call; unfinished or unobserved calls fail the program. await yield_control() yields output while execution continues. Timers alone do not keep a finished program alive.",
      'image/audio accept base64 data URIs, MCP blocks (e.g. image({type:"image", mimeType:"image/png", data:"<base64>"})), or current-thread attachment refs. Local paths use tools.view_image; its images return automatically. Unsupported modalities become text references.',
      "store/load retain bounded JSON values within this thread: keys 1–160 characters, 256 KiB per value, 128 keys/2 MiB total. Ordinary variables are fresh each run; missing keys return undefined. Writes already committed survive later program failure.",
      "Use ALL_TOOLS (name/description) to check tool availability; the tools Proxy also returns functions for unknown names.",
      "Available tool signatures (TypeScript reference notation only; submitted code must be JavaScript):",
      "```ts",
      sdk,
      "```",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "The JavaScript async module source, optionally beginning with // @exec: JSON.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  };
}

/** Metadata for the same disclosed definitions used by the tool SDK. */
export function generateToolCatalog(
  tools: readonly ModelTool[],
): Array<{ name: string; description: string }> {
  return tools
    .filter(
      (tool) =>
        tool.name !== RUN_CODE_NAME && tool.name !== COMPACT_CONTEXT_NAME,
    )
    .map(({ name, description }) => ({ name, description }));
}

export function generateToolSdk(tools: readonly ModelTool[]): string {
  const declarations = tools
    .filter(
      (tool) =>
        tool.name !== RUN_CODE_NAME && tool.name !== COMPACT_CONTEXT_NAME,
    )
    .flatMap((tool) => {
      const declaration = `  ${typescriptProperty(tool.name)}(args: ${schemaType(tool.inputSchema)}): Promise<ToolResult>;`;
      return [
        ...docComment(tool.description, "  "),
        ...(isIdentifierName(tool.name)
          ? []
          : [`  // Invoke as tools[${JSON.stringify(tool.name)}](...).`]),
        declaration,
      ];
    });
  return [
    "type ToolResult = {",
    "  output: string;",
    "  exitCode: number;",
    "  contentType?: string;",
    "  structuredContent?: unknown;",
    "};",
    "",
    "declare const tools: {",
    ...declarations,
    "};",
    "",
    "/** Append one intentionally selected value to the outer model-visible result. */",
    "declare function text(value: unknown): void;",
    "declare function image(value: unknown): void;",
    "declare function audio(value: unknown): void;",
    "declare function exit(): never;",
    "declare function store(key: string, value: unknown): void;",
    "declare function load(key: string): unknown;",
    "declare function yield_control(): Promise<void>;",
    "declare function setTimeout(callback: (...args: unknown[]) => unknown, delayMs?: number, ...args: unknown[]): number;",
    "declare function clearTimeout(id: number): void;",
    "declare const ALL_TOOLS: ReadonlyArray<{ name: string; description: string }>;",
  ].join("\n");
}

function schemaType(schema: unknown, depth = 0): string {
  if (depth > 12 || !isRecord(schema)) return "unknown";
  if ("const" in schema) return literalType(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const variants = schema.enum.map(literalType);
    return variants.includes("unknown") ? "unknown" : variants.join(" | ");
  }
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (variants !== undefined && variants.length > 0) {
    const rendered = variants.map((entry) => schemaType(entry, depth + 1));
    return rendered.every((entry) => entry !== "unknown")
      ? rendered.join(" | ")
      : "unknown";
  }
  if (Array.isArray(schema.type)) {
    const rendered = schema.type.map((type) =>
      schemaType({ ...schema, type }, depth + 1),
    );
    return rendered.every((entry) => entry !== "unknown")
      ? rendered.join(" | ")
      : "unknown";
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${schemaType(schema.items, depth + 1)}>`;
    case "object":
      return objectSchemaType(schema, depth + 1);
    default:
      return "unknown";
  }
}

function objectSchemaType(
  schema: Record<string, unknown>,
  depth: number,
): string {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
  );
  const entries = Object.entries(properties).map(([name, propertySchema]) => {
    const description =
      isRecord(propertySchema) && typeof propertySchema.description === "string"
        ? `${inlineDocComment(propertySchema.description)} `
        : "";
    return `${description}${typescriptProperty(name)}${required.has(name) ? "" : "?"}: ${schemaType(propertySchema, depth)};`;
  });
  if (schema.additionalProperties === true) {
    entries.push("[key: string]: unknown;");
  } else if (isRecord(schema.additionalProperties)) {
    entries.push(
      `[key: string]: ${schemaType(schema.additionalProperties, depth)};`,
    );
  }
  return entries.length === 0 ? "{ }" : `{ ${entries.join(" ")} }`;
}

function docComment(description: string, indent: string): string[] {
  const lines = description.replace(/\*\//gu, "*\\/").split(/\r?\n/u);
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line}`),
    `${indent} */`,
  ];
}

function inlineDocComment(description: string): string {
  return `/** ${description.replace(/\*\//gu, "*\\/").replace(/\r?\n/gu, " ")} */`;
}

function literalType(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  return "unknown";
}

function typescriptProperty(name: string): string {
  return isIdentifierName(name) ? name : JSON.stringify(name);
}

function isIdentifierName(name: string): boolean {
  return /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}
