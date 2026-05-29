import type { Readable, Writable } from "node:stream";

export const CURSOR_MARKER = "\u001B_zen:cursor\u0007";

export interface TerminalDevice {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  readonly columns: number;
  readonly rows: number;
}

export interface Component {
  render(width: number, height: number): readonly string[];
  handleInput?(data: string): void;
}

export class ProcessTerminalDevice implements TerminalDevice {
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private readonly wasRaw: boolean;

  constructor(
    private readonly input: Readable & { setRawMode?: (mode: boolean) => void; isRaw?: boolean },
    private readonly output: Writable & { columns?: number; rows?: number }
  ) {
    this.wasRaw = input.isRaw ?? false;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.input.setEncoding("utf8");
    this.input.setRawMode?.(true);
    this.input.resume();
    this.input.on("data", onInput);
    this.output.on("resize", onResize);
    this.write("\u001B[?2004h\u001B[?25h");
  }

  stop(): void {
    if (this.inputHandler) {
      this.input.off("data", this.inputHandler);
    }
    if (this.resizeHandler) {
      this.output.off("resize", this.resizeHandler);
    }
    this.write("\u001B[?2004l\u001B[?25h\u001B[0m");
    this.input.setRawMode?.(this.wasRaw);
    this.input.pause();
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  write(data: string): void {
    this.output.write(data);
  }

  get columns(): number {
    return this.output.columns ?? (Number(process.env.COLUMNS) || 80);
  }

  get rows(): number {
    return this.output.rows ?? (Number(process.env.ROWS) || 24);
  }
}

export class TuiEngine {
  private previousLines: readonly string[] = [];
  private renderPending = false;
  private stopped = true;
  private focus?: Component;
  onStop?: () => void;

  constructor(private readonly terminal: TerminalDevice) {}

  readonly children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
    this.requestRender();
  }

  setFocus(component: Component): void {
    this.focus = component;
    this.requestRender();
  }

  start(): void {
    this.stopped = false;
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.requestRender(true)
    );
    this.requestRender(true);
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.terminal.stop();
    this.onStop?.();
  }

  requestRender(full = false): void {
    if (this.stopped) {
      return;
    }
    if (full) {
      this.previousLines = [];
    }
    if (this.renderPending) {
      return;
    }
    this.renderPending = true;
    setTimeout(() => {
      this.renderPending = false;
      this.render();
    }, 0);
  }

  private handleInput(data: string): void {
    if (data === "\u0003") {
      this.stop();
      return;
    }
    this.focus?.handleInput?.(data);
    this.requestRender();
  }

  private render(): void {
    if (this.stopped) {
      return;
    }

    const width = Math.max(10, this.terminal.columns);
    const height = Math.max(5, this.terminal.rows);
    const rendered = this.children.flatMap((child) => child.render(width, height));
    const clipped = rendered.slice(-height).map((line) => `${truncatePlain(line, width)}\u001B[0m`);
    const cursor = extractCursor(clipped);

    if (this.previousLines.length === 0) {
      this.terminal.write(
        `\u001B[?2026h\u001B[2J\u001B[H${clipped.join("\r\n")}\u001B[?2026l`
      );
    } else {
      this.writeDiff(clipped);
    }

    if (cursor) {
      this.terminal.write(`\u001B[${cursor.row + 1};${cursor.col + 1}H`);
    }
    this.previousLines = clipped;
  }

  private writeDiff(nextLines: readonly string[]): void {
    let buffer = "\u001B[?2026h";
    const maxLines = Math.max(this.previousLines.length, nextLines.length);
    for (let index = 0; index < maxLines; index += 1) {
      const nextLine = nextLines[index] ?? "";
      if (this.previousLines[index] === nextLine) {
        continue;
      }
      buffer += `\u001B[${index + 1};1H\u001B[2K${nextLine}`;
    }
    buffer += "\u001B[?2026l";
    this.terminal.write(buffer);
  }
}

export class Container implements Component {
  readonly children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  clear(): void {
    this.children.splice(0);
  }

  render(width: number, height: number): readonly string[] {
    return this.children.flatMap((child) => child.render(width, height));
  }
}

export class TextBlock implements Component {
  constructor(private readonly lines: readonly string[] | (() => readonly string[])) {}

  render(width: number): readonly string[] {
    const lines = typeof this.lines === "function" ? this.lines() : this.lines;
    return lines.flatMap((line) => wrapPlain(line, width));
  }
}

export type EditorSubmitHandler = (value: string) => void;

export class EditorComponent implements Component {
  private value = "";
  private cursor = 0;
  onSubmit?: EditorSubmitHandler;

  constructor(private readonly placeholder = "Type a message...") {}

  setText(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }

  getText(): string {
    return this.value;
  }

  handleInput(data: string): void {
    if (data.startsWith("\u001B[200~") && data.endsWith("\u001B[201~")) {
      this.insert(data.slice(6, -6));
      return;
    }
    if (data === "\r" || data === "\n") {
      const submitted = this.value.trim();
      if (submitted.length > 0) {
        this.value = "";
        this.cursor = 0;
        this.onSubmit?.(submitted);
      }
      return;
    }
    if (data === "\u001B\r" || data === "\u001B\n") {
      this.insert("\n");
      return;
    }
    if (data === "\u007F" || data === "\b") {
      this.deleteBackward();
      return;
    }
    if (data === "\u001B[D") {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (data === "\u001B[C") {
      this.cursor = Math.min(this.value.length, this.cursor + 1);
      return;
    }
    if (data === "\u0001") {
      this.cursor = 0;
      return;
    }
    if (data === "\u0005") {
      this.cursor = this.value.length;
      return;
    }
    if (data >= " " && !data.startsWith("\u001B")) {
      this.insert(data);
    }
  }

  render(width: number): readonly string[] {
    const prompt = "> ";
    const content = this.value.length > 0 ? this.value : this.placeholder;
    const beforeCursor = content.slice(0, this.cursor);
    const atCursor = content[this.cursor] ?? " ";
    const afterCursor = content.slice(this.cursor + atCursor.length);
    const cursorLine = `${prompt}${beforeCursor}${CURSOR_MARKER}\u001B[7m${atCursor}\u001B[27m${afterCursor}`;
    return wrapPlain(cursorLine, Math.max(1, width));
  }

  private insert(text: string): void {
    this.value = `${this.value.slice(0, this.cursor)}${text}${this.value.slice(this.cursor)}`;
    this.cursor += text.length;
  }

  private deleteBackward(): void {
    if (this.cursor <= 0) {
      return;
    }
    this.value = `${this.value.slice(0, this.cursor - 1)}${this.value.slice(this.cursor)}`;
    this.cursor -= 1;
  }
}

function extractCursor(lines: string[]): { row: number; col: number } | undefined {
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    const markerIndex = lines[row]?.indexOf(CURSOR_MARKER) ?? -1;
    if (markerIndex < 0) {
      continue;
    }
    const line = lines[row] ?? "";
    lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
    return { row, col: visiblePlainWidth(line.slice(0, markerIndex)) };
  }
  return undefined;
}

function truncatePlain(value: string, width: number): string {
  const clean = value.replaceAll(CURSOR_MARKER, "");
  return visiblePlainWidth(clean) <= width ? clean : clean.slice(0, Math.max(0, width - 1));
}

function wrapPlain(value: string, width: number): readonly string[] {
  const logicalLines = value.split(/\r?\n/);
  return logicalLines.flatMap((line) => {
    if (line.length === 0) {
      return [""];
    }
    const chunks: string[] = [];
    for (let index = 0; index < line.length; index += width) {
      chunks.push(line.slice(index, index + width));
    }
    return chunks;
  });
}

function visiblePlainWidth(value: string): number {
  return value.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "").length;
}
