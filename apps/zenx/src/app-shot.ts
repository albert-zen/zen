import type { AppShotSource } from "./main/app-shot.js";
import type { ZenXImageDraft } from "./main/image-attachments.js";

/** Fixed physical pairs only; these values never carry native masks or key codes. */
export const APP_SHOT_MODIFIER_SHORTCUTS = {
  "both-shift": "shift",
  "both-control": "control",
  "both-alt": "alt",
  "both-meta": "meta",
} as const;

export type AppShotModifier =
  (typeof APP_SHOT_MODIFIER_SHORTCUTS)[keyof typeof APP_SHOT_MODIFIER_SHORTCUTS];
export type AppShotShortcutKind =
  keyof typeof APP_SHOT_MODIFIER_SHORTCUTS | "chord";

export function isAppShotModifier(value: unknown): value is AppShotModifier {
  return (
    value === "shift" ||
    value === "control" ||
    value === "alt" ||
    value === "meta"
  );
}

export function isAppShotShortcutKind(
  value: unknown,
): value is AppShotShortcutKind {
  return (
    value === "chord" ||
    (typeof value === "string" &&
      Object.hasOwn(APP_SHOT_MODIFIER_SHORTCUTS, value))
  );
}

export interface AppShotShortcutState {
  registered: boolean;
  /** An available Hyprland action does not establish a physical key binding. */
  actionRegistered?: boolean;
  shortcutDescription?: string;
  canConfigure: boolean;
}

export interface AppShotEvent {
  token: string;
  image?: ZenXImageDraft;
  error?: string;
  disarmed?: true;
  openPicker?: true;
  shortcutState?: AppShotShortcutState;
}

export interface AppShotConfiguration {
  nativeForeground: boolean;
  niriBinding?: string;
  hyprlandBinding?: { legacy: string; lua: string };
  kdeSupport?: "ready" | "manual-setup-required" | "unavailable" | "error";
  hyprlandSupport?:
    | "ready"
    | "unsupported-session"
    | "not-installed"
    | "update-required"
    | "error";
  nativeCaptureError?: string;
  portalShortcut?: true;
  gnomeSupport?:
    | "ready"
    | "unsupported-session"
    | "extension-unavailable"
    | "incompatible-version";
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
  ): Promise<string | AppShotShortcutState>;
  configureShortcut?(token: string): Promise<AppShotShortcutState>;
  disarm(token: string): Promise<void>;
  onCapture(listener: (event: AppShotEvent) => void): () => void;
}
