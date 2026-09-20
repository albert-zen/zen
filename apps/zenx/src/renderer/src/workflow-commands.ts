import type { WorkflowCommand } from "../../main/workflow-configuration.js";

export type WorkflowCommandCandidate =
  | {
      readonly kind: "built-in";
      readonly name: "compact";
      readonly description: string;
    }
  | ({ readonly kind: "custom" } & WorkflowCommand);

export const BUILT_IN_WORKFLOW_COMMANDS: readonly WorkflowCommandCandidate[] = [
  {
    kind: "built-in",
    name: "compact",
    description: "Compact this thread's context",
  },
];

export function commandCandidates(
  input: string,
  custom: readonly WorkflowCommand[],
): WorkflowCommandCandidate[] {
  const parsed = parseSlashInput(input);
  if (parsed === null) return [];
  if (parsed.commandComplete) {
    return custom
      .filter((command) => command.enabled && command.name === parsed.name)
      .map((command) => ({ kind: "custom" as const, ...command }));
  }
  // Preserve the established one-Enter execution path for the exact built-in
  // command. Partial built-in input still participates in completion.
  if (parsed.name === "compact") return [];
  const candidates: WorkflowCommandCandidate[] = [
    ...BUILT_IN_WORKFLOW_COMMANDS,
    ...custom
      .filter((command) => command.enabled)
      .map((command) => ({ kind: "custom" as const, ...command })),
  ];
  return candidates.filter((command) => command.name.startsWith(parsed.name));
}

export function expandWorkflowCommand(
  input: string,
  command: WorkflowCommandCandidate,
): string {
  const parsed = parseSlashInput(input);
  const args = parsed?.args ?? "";
  if (command.kind === "built-in") return `/${command.name}`;
  const expanded = command.prompt.includes("{{args}}")
    ? command.prompt.replaceAll("{{args}}", () => args)
    : args.length === 0
      ? command.prompt
      : `${command.prompt}\n\n${args}`;
  return expanded.trim();
}

function parseSlashInput(
  input: string,
): { name: string; args: string; commandComplete: boolean } | null {
  if (!input.startsWith("/") || input.startsWith("//")) return null;
  const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/u.exec(input);
  if (match === null) return null;
  return {
    name: (match[1] ?? "").toLowerCase(),
    args: match[2]?.trim() ?? "",
    commandComplete: match[2] !== undefined,
  };
}

export type { WorkflowCommand };
