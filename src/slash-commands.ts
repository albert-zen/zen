export type SlashCommand = {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "/help",
    usage: "/help",
    description: "Show available commands"
  },
  {
    name: "/status",
    usage: "/status",
    description: "Show current thread status"
  },
  {
    name: "/resume",
    usage: "/resume [query|number|thread-id]",
    description: "Find or resume saved threads"
  },
  {
    name: "/interrupt",
    usage: "/interrupt",
    description: "Cancel the active turn and clear queued input"
  },
  {
    name: "/tools",
    usage: "/tools",
    description: "Toggle expanded tool call details"
  },
  {
    name: "/new",
    usage: "/new",
    description: "Start a fresh thread"
  },
  {
    name: "/exit",
    usage: "/exit",
    description: "Exit the TUI"
  }
];

export function slashSuggestions(input: string): readonly SlashCommand[] {
  const trimmed = input.trimStart();

  if (!trimmed.startsWith("/")) {
    return [];
  }

  const token = trimmed.split(/\s+/, 1)[0] ?? "/";

  return SLASH_COMMANDS.filter((command) => command.name.startsWith(token)).slice(0, 6);
}

export function renderSlashCommandHelp(): string {
  return `Commands\n${SLASH_COMMANDS.map(
    (command) => `  ${command.usage.padEnd(28)} ${command.description}`
  ).join("\n")}`;
}
