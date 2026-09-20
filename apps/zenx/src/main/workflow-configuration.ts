export interface WorkflowCommand {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly enabled: boolean;
}

export const DEFAULT_TITLE_PROMPT =
  "Create a concise title of at most 64 characters in the same language as this request. Return only the title.\n\nRequest:\n{{request}}";

export const RESERVED_WORKFLOW_COMMAND_NAMES = ["compact"] as const;

const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const MAX_COMMANDS = 64;
const MAX_DESCRIPTION_LENGTH = 256;
const MAX_PROMPT_LENGTH = 32_768;

export function normalizeWorkflowCommands(value: unknown): WorkflowCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_COMMANDS)
    throw new Error("Workflow commands must be an array of at most 64 entries");
  const commands = value.map((entry, index) => normalizeCommand(entry, index));
  const names = commands.map((command) => command.name);
  if (new Set(names).size !== names.length)
    throw new Error("Workflow command names must be unique");
  const reserved = names.find((name) =>
    RESERVED_WORKFLOW_COMMAND_NAMES.includes(
      name as (typeof RESERVED_WORKFLOW_COMMAND_NAMES)[number],
    ),
  );
  if (reserved !== undefined)
    throw new Error(
      `Workflow command /${reserved} is built in and cannot be replaced`,
    );
  return commands;
}

export function normalizeTitlePrompt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Title prompt must be text");
  const prompt = value.trim();
  if (prompt.length === 0) return undefined;
  if (prompt.length > MAX_PROMPT_LENGTH)
    throw new Error("Title prompt is too long");
  const placeholders = [...prompt.matchAll(/\{\{([^{}]+)\}\}/gu)].map(
    (match) => match[1],
  );
  if (!placeholders.includes("request"))
    throw new Error("Title prompt must include {{request}}");
  const unknown = placeholders.find((placeholder) => placeholder !== "request");
  if (unknown !== undefined)
    throw new Error(`Unknown title prompt placeholder {{${unknown}}}`);
  return prompt;
}

export function renderTitlePrompt(
  template: string | undefined,
  input: string,
): string {
  return (template ?? DEFAULT_TITLE_PROMPT).replaceAll(
    "{{request}}",
    () => input,
  );
}

function normalizeCommand(value: unknown, index: number): WorkflowCommand {
  if (!isRecord(value))
    throw new Error(`Workflow command ${index + 1} is invalid`);
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!COMMAND_NAME.test(name))
    throw new Error(
      `Workflow command ${index + 1} name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens`,
    );
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH)
    throw new Error(`Workflow command /${name} description is invalid`);
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH)
    throw new Error(`Workflow command /${name} prompt is invalid`);
  const placeholders = [...prompt.matchAll(/\{\{([^{}]+)\}\}/gu)].map(
    (match) => match[1],
  );
  const unknown = placeholders.find((placeholder) => placeholder !== "args");
  if (unknown !== undefined)
    throw new Error(`Unknown workflow prompt placeholder {{${unknown}}}`);
  if (typeof value.enabled !== "boolean")
    throw new Error(`Workflow command /${name} enabled must be a boolean`);
  return { name, description, prompt, enabled: value.enabled };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
