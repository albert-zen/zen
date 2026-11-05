export interface FramePreparationDiagnostics {
  calls: number;
  successes: number;
  failures: number;
  observerErrors: number;
  head: Record<string, unknown>[];
  tail: Record<string, unknown>[];
}

export function observeFramePreparation(
  prototype: { prepare(rootTree?: unknown): Promise<unknown> },
  publish?: (value: Record<string, unknown>) => void,
): { receipt: FramePreparationDiagnostics; restore(): void };
