import type { AppShotSource } from "./main/app-shot.js";
import type { ZenXImageDraft } from "./main/image-attachments.js";

export type AppShotShortcutKind = "both-shift" | "chord";

export interface AppShotEvent {
  token: string;
  image?: ZenXImageDraft;
  error?: string;
  disarmed?: true;
  openPicker?: true;
}

export interface AppShotConfiguration {
  nativeForeground: boolean;
  niriBinding?: string;
}

export interface AppShotApi {
  configuration?(): Promise<AppShotConfiguration>;
  list(): Promise<AppShotSource[]>;
  capture(
    sourceId: string,
    includeAccessibility: boolean,
  ): Promise<ZenXImageDraft>;
  read(previewId: string): Promise<Uint8Array>;
  attach(previewId: string): Promise<ZenXImageDraft>;
  discard(previewId: string): Promise<void>;
  arm(
    token: string,
    includeAccessibility: boolean,
    kind?: AppShotShortcutKind,
  ): Promise<string>;
  disarm(token: string): Promise<void>;
  onCapture(listener: (event: AppShotEvent) => void): () => void;
}
