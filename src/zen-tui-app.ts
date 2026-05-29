import { AgentInteractionSession } from "./agent-interaction-session.js";
import type { AppServerClient } from "./app-server.js";
import type { ThreadSnapshot } from "./app-server-protocol.js";
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
  private pending = Promise.resolve();
  private closed = false;

  constructor(options: ZenTuiAppOptions) {
    this.session = new AgentInteractionSession({ client: options.client });
    this.engine = new TuiEngine(options.terminal);
    this.engine.addChild(this.root);
    this.engine.setFocus(this.editor);
    this.root.addChild(this.transcript);
    this.editor.onSubmit = (value) => {
      void this.handleSubmit(value);
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
      this.engine.requestRender();
      return;
    }

    if (trimmed === "/help") {
      this.appendLocalNotice("Commands: /help, /status, /new, /exit");
      return;
    }

    if (trimmed === "/status") {
      this.appendLocalNotice(renderStatus(this.session.getSnapshot().state));
      return;
    }

    this.pending = this.pending
      .then(async () => {
        await this.session.submit(trimmed);
      })
      .catch((cause) => {
        this.appendLocalNotice(
          `Error: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      });
  }

  private appendLocalNotice(message: string): void {
    const snapshot = this.session.getSnapshot();
    const synthetic: TimelineRow = {
      type: "trace",
      itemId: `local-${Date.now()}`,
      seq: Number.MAX_SAFE_INTEGER,
      turnId: snapshot.thread?.turns.at(-1)?.id ?? "local",
      event: message
    };
    this.localRows.push(synthetic);
    this.engine.requestRender();
  }

  private readonly localRows: TimelineRow[] = [];

  private renderLines(): readonly string[] {
    const snapshot = this.session.getSnapshot();
    const state = snapshot.state;
    const lines = [
      "Zen Agent",
      renderThreadSummary(snapshot.thread, state),
      ""
    ];
    const rows = [...state.timelineRows, ...this.localRows];
    lines.push(...rows.flatMap(renderRow));
    lines.push("", state.currentThread?.status === "running" ? "Working..." : "Ready");
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

function renderRow(row: TimelineRow): readonly string[] {
  if (row.type === "user") {
    return [`You: ${stringify(row.content)}`];
  }
  if (row.type === "assistant" || row.type === "assistant-progress") {
    return [`Zen: ${stringify(row.content)}`];
  }
  if (row.type === "tool-call") {
    return [`Tool ${row.toolName ?? "tool"}: ${stringify(row.input)}`];
  }
  if (row.type === "tool-result") {
    return [`Tool result ${row.toolName ?? "tool"}: ${stringify(row.content)}`];
  }
  if (row.type === "tool-error") {
    return [`Tool error ${row.toolName ?? "tool"}: ${row.message ?? "failed"}`];
  }
  if (row.type === "approval-pending") {
    return [`Approval pending: ${row.reason ?? row.approvalId ?? "approval requested"}`];
  }
  if (row.type === "approval-resolved") {
    return [`Approval resolved: ${row.decision ?? "resolved"}`];
  }
  return [`Notice: ${row.event}`];
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
