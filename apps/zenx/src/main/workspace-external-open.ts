import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { resolveWorkspacePath } from "./workspace-files.js";

export const externalApplicationIds = [
  "vscode",
  "cursor",
  "editor",
  "custom",
] as const;
export type ExternalApplicationId = (typeof externalApplicationIds)[number];
export type ExternalApplications = Partial<
  Record<ExternalApplicationId, string>
>;
export type ExternalOpenRequest = {
  host: "local";
  threadId: string;
  path: string;
  application: "default" | "reveal" | ExternalApplicationId;
};
export type ExternalApplicationCatalog = {
  platform: string;
  applications: ExternalApplications;
};

export function normalizeExternalApplications(
  value: unknown,
): ExternalApplications {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid external applications");
  const result: ExternalApplications = {};
  for (const [id, target] of Object.entries(value)) {
    if (
      !externalApplicationIds.includes(id as ExternalApplicationId) ||
      typeof target !== "string" ||
      target.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(target) ||
      (!path.posix.isAbsolute(target) && !path.win32.isAbsolute(target))
    )
      throw new Error(
        "An external application must be an absolute application path, not a command",
      );
    result[id as ExternalApplicationId] = target;
  }
  return result;
}

export function externalLaunchPlan(
  platform: string,
  application: string,
  file: string,
) {
  if (platform === "darwin" && application.endsWith(".app"))
    return { executable: "/usr/bin/open", args: ["-a", application, file] };
  if (platform === "win32" && !/\.exe$/i.test(application))
    throw new Error("Choose a native .exe executable, not a shell script");
  return { executable: application, args: [file] };
}

export async function validateExternalApplication(
  application: string,
  platform = process.platform,
): Promise<void> {
  normalizeExternalApplications({ custom: application });
  const metadata = await stat(application);
  if (platform === "darwin" && application.endsWith(".app")) {
    if (!metadata.isDirectory())
      throw new Error("Choose an application bundle");
  } else {
    if (!metadata.isFile()) throw new Error("Choose an application executable");
    externalLaunchPlan(platform, application, "unused");
    await access(
      application,
      platform === "win32" ? constants.F_OK : constants.X_OK,
    );
  }
}

/** Fixed installation locations only: never search the workspace or execute detection commands. */
export async function externalApplicationCatalog(
  configured: ExternalApplications,
): Promise<ExternalApplicationCatalog> {
  const applications = { ...configured };
  const home = os.homedir();
  const candidates: Partial<Record<ExternalApplicationId, string[]>> =
    process.platform === "darwin"
      ? {
          vscode: [
            "/Applications/Visual Studio Code.app",
            path.join(home, "Applications/Visual Studio Code.app"),
          ],
          cursor: [
            "/Applications/Cursor.app",
            path.join(home, "Applications/Cursor.app"),
          ],
          editor: ["/System/Applications/TextEdit.app"],
        }
      : process.platform === "win32"
        ? {
            vscode: [
              path.join(
                process.env.LOCALAPPDATA ?? path.join(home, "AppData/Local"),
                "Programs/Microsoft VS Code/Code.exe",
              ),
            ],
            cursor: [
              path.join(
                process.env.LOCALAPPDATA ?? path.join(home, "AppData/Local"),
                "Programs/cursor/Cursor.exe",
              ),
            ],
            editor: [
              path.join(
                process.env.SystemRoot ?? "C:\\Windows",
                "System32/notepad.exe",
              ),
            ],
          }
        : {
            vscode: ["/usr/bin/code", "/usr/share/code/code"],
            cursor: ["/usr/bin/cursor", "/opt/Cursor/cursor"],
            editor: ["/usr/bin/gedit", "/usr/bin/kate", "/usr/bin/mousepad"],
          };
  for (const id of externalApplicationIds) {
    if (applications[id]) continue;
    for (const candidate of candidates[id] ?? []) {
      try {
        await validateExternalApplication(candidate);
        applications[id] = candidate;
        break;
      } catch {
        /* Not detected. Explicit configuration remains available. */
      }
    }
  }
  return { platform: process.platform, applications };
}

export interface ExternalOpenPorts {
  readLocalThread(threadId: string): Promise<{ cwd: string }>;
  applications(): Promise<ExternalApplications>;
  openPath(file: string): Promise<string>;
  reveal(file: string): void;
  launch(application: string, file: string): Promise<void>;
}

/** This endpoint is deliberately local-only. Fleet locators never become local paths. */
export async function openWorkspaceExternally(
  input: unknown,
  ports: ExternalOpenPorts,
): Promise<void> {
  if (!input || typeof input !== "object")
    throw new Error("Invalid local file request");
  const value = input as ExternalOpenRequest;
  if (
    value.host !== "local" ||
    typeof value.threadId !== "string" ||
    !value.threadId ||
    value.threadId.length > 512
  )
    throw new Error("External opening supports local Host files only");
  if (
    !["default", "reveal", ...externalApplicationIds].includes(
      value.application,
    )
  )
    throw new Error("Invalid external application");
  const thread = await ports.readLocalThread(value.threadId);
  const target = await resolveWorkspacePath(thread.cwd, value.path);
  const metadata = await stat(target.resolved);
  if (!metadata.isFile() && !metadata.isDirectory())
    throw new Error("Only regular files and directories can be opened");
  if (value.application === "reveal") {
    ports.reveal(target.resolved);
    return;
  }
  if (value.application === "default") {
    const error = await ports.openPath(target.resolved);
    if (error) throw new Error(error);
    return;
  }
  const application = (await ports.applications())[value.application];
  if (!application)
    throw new Error(
      "Application not detected. Choose its application path first.",
    );
  await validateExternalApplication(application);
  await ports.launch(application, target.resolved);
}

export async function launchExternalApplication(
  application: string,
  file: string,
): Promise<void> {
  const plan = externalLaunchPlan(process.platform, application, file);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, {
      shell: false,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    if (plan.executable === "/usr/bin/open") {
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Application open failed (${code ?? "signal"})`)),
      );
    } else
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
  });
}
