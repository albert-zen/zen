import type { AppShotSource } from "./main/app-shot.js";
import type { ZenXImageDraft } from "./main/image-attachments.js";

export interface AppShotEvent {
  token: string;
  image?: ZenXImageDraft;
  error?: string;
  disarmed?: true;
}

export interface AppShotApi {
  list(): Promise<AppShotSource[]>;
  capture(
    sourceId: string,
    includeAccessibility: boolean,
  ): Promise<ZenXImageDraft>;
  read(previewId: string): Promise<Uint8Array>;
  attach(previewId: string): Promise<ZenXImageDraft>;
  discard(previewId: string): Promise<void>;
  arm(token: string, includeAccessibility: boolean): Promise<string>;
  disarm(token: string): Promise<void>;
  onCapture(listener: (event: AppShotEvent) => void): () => void;
}
