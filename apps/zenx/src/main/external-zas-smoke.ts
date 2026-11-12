import type { BrowserWindow } from "electron";
import { readFile, rename, writeFile } from "node:fs/promises";

import type { AppServerManager } from "./app-server-manager.js";

const ACCEPTANCE_PREFIX = "--zenx-external-zas-acceptance=";

interface ExternalZasAcceptanceConfig {
  controlPath: string;
  resultPath: string;
}

interface ExternalZasControl {
  phase: "turn-started" | "quit";
  threadId: string;
  turnId?: string;
}

export function externalZasAcceptanceConfigPath(
  arguments_: readonly string[],
  environmentValue?: string,
): string | null {
  const values = arguments_
    .filter((argument) => argument.startsWith(ACCEPTANCE_PREFIX))
    .map((argument) => argument.slice(ACCEPTANCE_PREFIX.length));
  if (environmentValue !== undefined) values.push(environmentValue);
  return values.length === 1 && values[0]!.length > 0 ? values[0]! : null;
}

export async function runExternalZasAcceptance(options: {
  configPath: string;
  manager: AppServerManager;
  window: BrowserWindow;
  createWindow(): BrowserWindow;
}): Promise<void> {
  const config = readConfig(
    JSON.parse(await readFile(options.configPath, "utf8")) as unknown,
  );
  const originalHostProcessId = options.manager.processId;
  if (originalHostProcessId === undefined) {
    throw new Error("Packaged ZenX App Server host did not start");
  }
  const started = await waitForControl(config.controlPath, "turn-started");
  if (started.turnId === undefined) {
    throw new Error("External ZAS acceptance omitted its active Turn id");
  }

  options.window.close();
  await waitFor(() => options.window.isDestroyed(), "last UI window to close");
  if (options.manager.processId !== originalHostProcessId) {
    throw new Error("Closing the last UI window replaced the App Server host");
  }
  await writeResult(config.resultPath, {
    ok: true,
    phase: "window-closed",
    threadId: started.threadId,
    turnId: started.turnId,
  });

  await waitForTurnCompletion(
    options.manager,
    started.threadId,
    started.turnId,
  );
  const reopened = options.createWindow();
  await waitForLoad(reopened);
  const rendererRead = (await reopened.webContents.executeJavaScript(
    `window.zenx.protocol.request("thread/read", ${JSON.stringify({
      threadId: started.threadId,
      includeTurns: true,
    })})`,
    true,
  )) as { thread?: { id?: string; turns?: Array<{ id?: string }> } };
  if (
    rendererRead.thread?.id !== started.threadId ||
    !rendererRead.thread.turns?.some((turn) => turn.id === started.turnId)
  ) {
    throw new Error(
      "Reopened renderer did not read the external client's Turn",
    );
  }
  if (options.manager.processId !== originalHostProcessId) {
    throw new Error("Reopening the UI replaced the App Server host");
  }
  await writeResult(config.resultPath, {
    ok: true,
    phase: "renderer-read",
    threadId: started.threadId,
    turnId: started.turnId,
  });

  const quit = await waitForControl(config.controlPath, "quit");
  if (quit.threadId !== started.threadId) {
    throw new Error("External ZAS acceptance changed Thread before Quit");
  }
}

async function waitForTurnCompletion(
  manager: AppServerManager,
  threadId: string,
  turnId: string,
): Promise<void> {
  await waitFor(async () => {
    const read = await manager.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    return read.thread.turns.some(
      (turn) => turn.id === turnId && turn.status === "completed",
    );
  }, "windowless Turn completion");
}

async function waitForControl(
  controlPath: string,
  phase: ExternalZasControl["phase"],
): Promise<ExternalZasControl> {
  let matching: ExternalZasControl | undefined;
  await waitFor(async () => {
    try {
      const value = JSON.parse(await readFile(controlPath, "utf8")) as unknown;
      const control = readControl(value);
      if (control.phase !== phase) return false;
      matching = control;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }, `external control phase ${phase}`);
  return matching!;
}

async function waitForLoad(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) return;
  await new Promise<void>((resolve, reject) => {
    window.webContents.once("did-finish-load", () => resolve());
    window.webContents.once("did-fail-load", (_event, code, description) =>
      reject(
        new Error(`Renderer failed to load (${String(code)}): ${description}`),
      ),
    );
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function readConfig(value: unknown): ExternalZasAcceptanceConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid external ZAS acceptance config");
  }
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).some(
      (key) => key !== "controlPath" && key !== "resultPath",
    ) ||
    typeof config["controlPath"] !== "string" ||
    config["controlPath"].length === 0 ||
    typeof config["resultPath"] !== "string" ||
    config["resultPath"].length === 0
  ) {
    throw new Error("Invalid external ZAS acceptance config");
  }
  return config as unknown as ExternalZasAcceptanceConfig;
}

function readControl(value: unknown): ExternalZasControl {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid external ZAS acceptance control");
  }
  const control = value as Record<string, unknown>;
  if (
    (control["phase"] !== "turn-started" && control["phase"] !== "quit") ||
    typeof control["threadId"] !== "string" ||
    control["threadId"].length === 0 ||
    (control["turnId"] !== undefined && typeof control["turnId"] !== "string")
  ) {
    throw new Error("Invalid external ZAS acceptance control");
  }
  return control as unknown as ExternalZasControl;
}

async function writeResult(
  resultPath: string,
  result: Record<string, unknown>,
): Promise<void> {
  const temporary = `${resultPath}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result)}\n`, "utf8");
  await rename(temporary, resultPath);
}
