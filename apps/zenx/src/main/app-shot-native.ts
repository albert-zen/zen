import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isAppShotBounds,
  type AppShotBounds,
} from "./app-shot-native-contract.js";

export interface AppShotActiveWindow {
  windowId: number;
  windowTitle: string;
  pid: number;
  applicationName?: string;
  bounds?: AppShotBounds;
}

/** CoreGraphics window rows are front-to-back. This only reads metadata, never input. */
export const MAC_ACTIVE_WINDOW_JXA = `ObjC.import('AppKit');
ObjC.import('CoreGraphics');
const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
if (!app) throw Error('No foreground application');
const pid = Number(app.processIdentifier);
const rows = $.CGWindowListCopyWindowInfo(1 | 16, 0);
$.CFMakeCollectable(rows);
let row = null;
for (let i = 0; i < $.CFArrayGetCount(rows); i++) {
  const candidate = ObjC.castRefToObject($.CFArrayGetValueAtIndex(rows, i));
  if (Number(ObjC.unwrap(candidate.objectForKey('kCGWindowOwnerPID'))) === pid && Number(ObjC.unwrap(candidate.objectForKey('kCGWindowLayer'))) === 0) { row = candidate; break; }
}
if (!row) throw Error('No foreground window');
const bounds = ObjC.deepUnwrap(row.objectForKey('kCGWindowBounds'));
JSON.stringify({bounds: {x: Number(bounds.X), y: Number(bounds.Y), width: Number(bounds.Width), height: Number(bounds.Height)}, windowId: Number(ObjC.unwrap(row.objectForKey('kCGWindowNumber'))), windowTitle: String(ObjC.unwrap(row.objectForKey('kCGWindowName')) || ''), pid: pid, applicationName: String(ObjC.unwrap(app.localizedName) || '')});`;

const execFileAsync = promisify(execFile);
type Runner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; encoding: "utf8" },
) => Promise<{ stdout: string }>;

export async function readMacActiveWindow(
  run: Runner = async (file, args, options) =>
    await execFileAsync(file, [...args], options),
): Promise<AppShotActiveWindow> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MAC_ACTIVE_WINDOW_JXA],
      { timeout: 2000, maxBuffer: 4096, encoding: "utf8" },
    ));
  } catch {
    throw new Error(
      "Foreground window could not be identified; choose a window instead",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(
      "Foreground window returned invalid metadata; choose a window instead",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(
      "Foreground window returned invalid metadata; choose a window instead",
    );
  const row = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row.windowId) ||
    Number(row.windowId) <= 0 ||
    !Number.isSafeInteger(row.pid) ||
    Number(row.pid) <= 0 ||
    typeof row.windowTitle !== "string" ||
    !row.windowTitle.trim()
  )
    throw new Error(
      "Foreground window has no exact identity; choose a window instead",
    );
  return {
    windowId: Number(row.windowId),
    windowTitle: row.windowTitle,
    pid: Number(row.pid),
    ...(isAppShotBounds(row.bounds) ? { bounds: row.bounds } : {}),
    ...(typeof row.applicationName === "string"
      ? { applicationName: row.applicationName }
      : {}),
  };
}

export const MAC_WINDOW_METADATA_JXA = `ObjC.import('AppKit');
ObjC.import('CoreGraphics');
const wanted = __WINDOW_ID__;
const rows = $.CGWindowListCopyWindowInfo(1 | 16, 0);
$.CFMakeCollectable(rows);
let row = null;
for (let i = 0; i < $.CFArrayGetCount(rows); i++) {
  const candidate = ObjC.castRefToObject($.CFArrayGetValueAtIndex(rows, i));
  if (Number(ObjC.unwrap(candidate.objectForKey('kCGWindowNumber'))) === wanted && Number(ObjC.unwrap(candidate.objectForKey('kCGWindowLayer'))) === 0) { row = candidate; break; }
}
if (!row) throw Error('Window not found');
const pid = Number(ObjC.unwrap(row.objectForKey('kCGWindowOwnerPID')));
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
const bounds = ObjC.deepUnwrap(row.objectForKey('kCGWindowBounds'));
JSON.stringify({bounds: {x: Number(bounds.X), y: Number(bounds.Y), width: Number(bounds.Width), height: Number(bounds.Height)}, windowId: wanted, windowTitle: String(ObjC.unwrap(row.objectForKey('kCGWindowName')) || ''), pid: pid, applicationName: app ? String(ObjC.unwrap(app.localizedName) || '') : ''});`;

/** Read app/window metadata for an explicit CG window ID; never infers a target. */
export async function readMacWindowMetadata(
  windowId: number,
  run: Runner = async (file, args, options) =>
    await execFileAsync(file, [...args], options),
): Promise<AppShotActiveWindow> {
  if (!Number.isSafeInteger(windowId) || windowId <= 0)
    throw new Error("Invalid App Shot window identity");
  let stdout: string;
  try {
    ({ stdout } = await run(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        MAC_WINDOW_METADATA_JXA.replace("__WINDOW_ID__", String(windowId)),
      ],
      { timeout: 2000, maxBuffer: 4096, encoding: "utf8" },
    ));
  } catch {
    throw new Error("Selected window metadata is unavailable");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Selected window returned invalid metadata");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Selected window returned invalid metadata");
  const row = value as Record<string, unknown>;
  if (
    row.windowId !== windowId ||
    !Number.isSafeInteger(row.pid) ||
    Number(row.pid) <= 0 ||
    typeof row.windowTitle !== "string" ||
    !row.windowTitle.trim()
  )
    throw new Error(
      "Selected window metadata does not match the requested window",
    );
  return {
    windowId,
    windowTitle: row.windowTitle,
    pid: Number(row.pid),
    ...(isAppShotBounds(row.bounds) ? { bounds: row.bounds } : {}),
    ...(typeof row.applicationName === "string"
      ? { applicationName: row.applicationName }
      : {}),
  };
}
