import { AgentInteractionSession } from "./agent-interaction-session.js";
import type { AppServerClient } from "./app-server.js";
import type { ThreadSnapshot } from "./app-server-protocol.js";
import {
  renderSlashCommandHelp,
  slashSuggestions,
  type SlashCommand
} from "./slash-commands.js";
import {
  Container,
  EditorComponent,
  TextBlock,
  TuiEngine,
  type TerminalDevice
} from "./tui-engine.js";
import type { TimelineRow, WebUiState } from "./web-ui-state.js";

export type ZenTuiAppOptions = {
  readonly client: AppServerClient;
  readonly terminal: TerminalDevice;
};

export class ZenTuiApp {
  private readonly session: AgentInteractionSession;
  private readonly engine: TuiEngine;
  private readonly root = new Container();
  private readonly transcript = new TextBlock(() => this.renderLines());
  private readonly editor = new EditorComponent("Ask Zen...");
  private readonly queuedInputs: string[] = [];
  private drainingQueue = false;
  private closed = false;
  private showToolDetails = false;
  private localNotice?: string;
  private resumeChoices: readonly { readonly id: string; readonly label: string }[] = [];
  private currentInput = "";

  constructor(options: ZenTuiAppOptions) {
    this.session = new AgentInteractionSession({ client: options.client });
    this.engine = new TuiEngine(options.terminal);
    this.engine.addChild(this.root);
    this.engine.setFocus(this.editor);
    this.root.addChild(this.transcript);
    this.editor.onSubmit = (value) => {
      void this.handleSubmit(value);
    };
    this.editor.onChange = (value) => {
      this.currentInput = value;
      this.engine.requestRender();
    };
  }

  async run(): Promise<void> {
    const unsubscribe = this.session.observe(() => {
      this.engine.requestRender();
    });

    this.engine.onStop = () => {
      this.closed = true;
    };

    try {
      await this.session.start();
      this.root.addChild(this.editor);
      this.engine.start();
      this.engine.requestRender(true);
      await new Promise<void>((resolve) => {
        const check = () => {
          if (this.closed) {
            resolve();
            return;
          }
          setTimeout(check, 25);
        };
        check();
      });
    } finally {
      unsubscribe();
      this.session.dispose();
      this.engine.stop();
    }
  }

  private async handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim();

    if (trimmed === "/exit" || trimmed === "/quit") {
      this.closed = true;
      this.engine.stop();
      return;
    }

    if (trimmed === "/new") {
      await this.session.newThread();
      this.resumeChoices = [];
      this.localNotice = undefined;
      this.engine.requestRender();
      return;
    }

    if (trimmed === "/help") {
      this.setLocalNotice(renderSlashCommandHelp());
      return;
    }

    if (trimmed === "/status") {
      this.setLocalNotice(renderStatus(this.session.getSnapshot().state));
      return;
    }

    if (trimmed === "/interrupt") {
      await this.interrupt();
      return;
    }

    if (trimmed === "/tools") {
      this.showToolDetails = !this.showToolDetails;
      this.setLocalNotice(`Tool detail ${this.showToolDetails ? "expanded" : "collapsed"}`);
      return;
    }

    if (trimmed === "/resume") {
      await this.showResumeChoices();
      return;
    }

    if (trimmed.startsWith("/resume ")) {
      await this.resume(trimmed.slice("/resume ".length).trim());
      return;
    }

    this.enqueueInput(trimmed);
  }

  private enqueueInput(input: string): void {
    this.queuedInputs.push(input);
    this.localNotice = undefined;
    this.engine.requestRender();
    void this.drainQueuedInputs();
  }

  private async drainQueuedInputs(): Promise<void> {
    if (this.drainingQueue) {
      return;
    }

    this.drainingQueue = true;

    try {
      while (this.queuedInputs.length > 0) {
        const next = this.queuedInputs.shift();

        if (!next) {
          continue;
        }

        this.engine.requestRender();
        await this.session.submit(next);
      }
    } catch (cause) {
      this.setLocalNotice(`Error: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      this.drainingQueue = false;
      this.engine.requestRender();
    }
  }

  private async interrupt(): Promise<void> {
    try {
      await this.session.interrupt();
      this.queuedInputs.splice(0);
      this.setLocalNotice("Interrupted current turn");
    } catch (cause) {
      this.setLocalNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }

  private async showResumeChoices(): Promise<void> {
    const threads = await this.session.listThreads();
    this.resumeChoices = threads.map((thread, index) => ({
      id: thread.id,
      label: `${index + 1}. ${thread.id} (${thread.status}, ${thread.turns} turns, ${thread.items} items)`
    }));
    this.setLocalNotice(
      this.resumeChoices.length > 0
        ? "Select with /resume <number> or /resume <thread-id>"
        : "No saved threads"
    );
  }

  private async resume(value: string): Promise<void> {
    const numeric = Number(value);
    const selected =
      Number.isInteger(numeric) && numeric > 0
        ? this.resumeChoices[numeric - 1]?.id
        : value;

    if (!selected) {
      this.setLocalNotice("Unknown resume selection");
      return;
    }

    try {
      await this.session.resumeThread(selected);
      this.resumeChoices = [];
      this.queuedInputs.splice(0);
      this.setLocalNotice(`Resumed ${selected}`);
    } catch (cause) {
      this.setLocalNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }

  private setLocalNotice(message: string): void {
    this.localNotice = message;
    this.engine.requestRender();
  }

  private renderLines(): readonly string[] {
    const snapshot = this.session.getSnapshot();
    const state = snapshot.state;
    const lines = ["Zen Agent", renderThreadSummary(snapshot.thread, state), ""];
    const rows = state.timelineRows.filter((row) => row.type !== "trace");

    lines.push(...renderTranscript(rows, { showToolDetails: this.showToolDetails }));

    if (this.resumeChoices.length > 0) {
      lines.push("", "Resume");
      lines.push(...this.resumeChoices.map((choice) => `  ${choice.label}`));
    }

    if (this.localNotice) {
      lines.push("", `Notice: ${this.localNotice}`);
    }

    const queuedCount = this.queuedInputs.length + (this.drainingQueue ? 1 : 0);
    lines.push(
      "",
      state.currentThread?.status === "running" || this.drainingQueue
        ? `Working${queuedCount > 0 ? ` | queued ${this.queuedInputs.length}` : ""}`
        : "Ready"
    );
    const suggestions = slashSuggestions(this.currentInput);
    if (suggestions.length > 0) {
      lines.push("", ...renderSlashSuggestions(suggestions));
    }
    return lines;
  }
}

function renderThreadSummary(thread: ThreadSnapshot | undefined, state: WebUiState): string {
  if (!thread) {
    return "No thread";
  }
  return `${thread.id} | ${state.currentThread?.status ?? thread.status} | turns ${thread.turns.length} | items ${thread.items.length}`;
}

function renderStatus(state: WebUiState): string {
  const thread = state.currentThread;
  if (!thread) {
    return "thread: not started";
  }
  return `thread: ${thread.id} | status: ${thread.status} | turns: ${thread.turns.length} | items: ${state.items.length}`;
}

function renderTranscript(
  rows: readonly TimelineRow[],
  options: { readonly showToolDetails: boolean }
): readonly string[] {
  if (rows.length === 0) {
    return ["No messages yet."];
  }

  return rows.flatMap((row) => renderRow(row, options));
}

function renderRow(
  row: TimelineRow,
  options: { readonly showToolDetails: boolean }
): readonly string[] {
  if (row.type === "user") {
    return ["", `You`, indent(stringify(row.content))];
  }
  if (row.type === "assistant" || row.type === "assistant-progress") {
    return ["", `Zen`, indent(stringify(row.content))];
  }
  if (row.type === "tool-call") {
    return options.showToolDetails
      ? ["", `Tool: ${row.toolName ?? "tool"}`, indent(stringify(row.input))]
      : [`  Tool: ${row.toolName ?? "tool"} (${summarize(row.input)})`];
  }
  if (row.type === "tool-result") {
    return options.showToolDetails
      ? [`  Result: ${row.toolName ?? "tool"}`, indent(stringify(row.content))]
      : [`  Result: ${row.toolName ?? "tool"} (${summarize(row.content)})`];
  }
  if (row.type === "tool-error") {
    return [`  Tool error: ${row.toolName ?? "tool"} (${row.message ?? "failed"})`];
  }
  if (row.type === "approval-pending") {
    return [`  Approval pending: ${row.reason ?? row.approvalId ?? "approval requested"}`];
  }
  if (row.type === "approval-resolved") {
    return [`  Approval resolved: ${row.decision ?? "resolved"}`];
  }
  return [];
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value);
}

function indent(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function summarize(value: unknown): string {
  const rendered = stringify(value).replace(/\s+/g, " ").trim();
  if (rendered.length <= 80) {
    return rendered;
  }
  return `${rendered.slice(0, 77)}...`;
}

function renderSlashSuggestions(commands: readonly SlashCommand[]): readonly string[] {
  return [
    "Commands",
    ...commands.map((command) => `  ${command.usage.padEnd(28)} ${command.description}`)
  ];
}
