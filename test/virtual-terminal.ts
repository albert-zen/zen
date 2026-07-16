import type { TerminalDevice } from "./test-exports.js";

export class VirtualTerminalDevice implements TerminalDevice {
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private output = "";

  constructor(
    private width = 80,
    private height = 24
  ) {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
  }

  stop(): void {
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  write(data: string): void {
    this.output += data;
  }

  sendInput(data: string): void {
    this.inputHandler?.(data);
  }

  resize(columns: number, rows: number): void {
    this.width = columns;
    this.height = rows;
    this.resizeHandler?.();
  }

  textOutput(): string {
    return stripAnsi(this.output);
  }

  rawOutput(): string {
    return this.output;
  }

  clearOutput(): void {
    this.output = "";
  }

  get columns(): number {
    return this.width;
  }

  get rows(): number {
    return this.height;
  }
}

export async function waitForRender(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B_[^\u0007]*\u0007/g, "");
}
