export type ThreadTitleStatus =
  "provisional" | "generating" | "generated" | "manual" | "failed";

export interface ThreadTitleProjection {
  threadId: string;
  title: string;
  status: ThreadTitleStatus;
  version: number;
  source: string;
  error?: string;
}

export type ThreadTitleSnapshot = Record<string, ThreadTitleProjection>;

export interface ThreadTitleInference {
  generate(input: string, model: string, signal: AbortSignal): Promise<string>;
}
