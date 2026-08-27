import type { BrowserWindow } from "electron";
import { readFile, writeFile } from "node:fs/promises";

const ACCEPTANCE_PREFIX = "--zenx-project-acceptance=";

interface ProjectWorkspaceAcceptanceConfig {
  fixture: string;
  mode: "mutate" | "restart";
  projectA: string;
  projectB: string;
  resultPath: string;
}

interface AcceptanceOptions {
  applicationMenuAbsent: boolean;
  configPath: string;
  window: BrowserWindow;
}

export function projectWorkspaceAcceptanceConfigPath(
  arguments_: readonly string[],
  environmentValue?: string,
): string | null {
  const values = arguments_
    .filter((argument) => argument.startsWith(ACCEPTANCE_PREFIX))
    .map((argument) => argument.slice(ACCEPTANCE_PREFIX.length));
  if (environmentValue !== undefined) values.push(environmentValue);
  return values.length === 1 && values[0]!.length > 0 ? values[0]! : null;
}

export async function runProjectWorkspaceAcceptance(
  options: AcceptanceOptions,
): Promise<void> {
  console.info(
    `Packaged Project workspace acceptance activated: ${options.configPath}`,
  );
  const config = await readProjectWorkspaceAcceptanceConfig(options.configPath);
  console.info(
    `Packaged Project workspace acceptance config read: ${config.mode}`,
  );
  try {
    if (!options.applicationMenuAbsent) {
      throw new Error("Packaged ZenX exposed an unexpected application menu");
    }
    await waitForLoad(options.window);
    console.info("Packaged Project workspace acceptance renderer loaded");
    if (config.mode === "mutate") {
      await clickButton(options.window, "Add project");
      await clickButton(options.window, config.fixture);
      await clickButton(options.window, config.projectA);
      await clickButton(options.window, "Add folder");
      await clickButton(options.window, `More actions for ${config.projectA}`);
      await waitForButton(options.window, "Remove from ZenX");
      await clickButton(options.window, `More actions for ${config.projectA}`);

      await clickButton(options.window, "Add project");
      await clickButton(options.window, config.fixture);
      await clickButton(options.window, config.projectB);
      await clickButton(options.window, "Add folder");
      await clickButton(options.window, `More actions for ${config.projectB}`);
      await waitForButton(options.window, "Remove from ZenX");

      await clickButton(options.window, `New thread in ${config.projectB}`);
      await waitForProjectThread(options.window, config.projectB);

      await clickButton(options.window, "Set as default");
      await clickButton(options.window, `More actions for ${config.projectA}`);
      await clickButton(options.window, "Remove from ZenX");
      await waitForProjectState(options.window, config, false);
    } else {
      await waitForProjectState(options.window, config, true);
    }
    await writeResult(config.resultPath, {
      ok: true,
      mode: config.mode,
      applicationMenuAbsent: true,
    });
  } catch (error) {
    await writeResult(config.resultPath, {
      ok: false,
      mode: config.mode,
      applicationMenuAbsent: options.applicationMenuAbsent,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function readProjectWorkspaceAcceptanceConfig(
  configPath: string,
): Promise<ProjectWorkspaceAcceptanceConfig> {
  const source = await readFile(configPath, "utf8");
  return readConfig(JSON.parse(source.replace(/^\uFEFF/u, "")) as unknown);
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

async function clickButton(
  window: BrowserWindow,
  title: string,
): Promise<void> {
  await waitForRenderer(
    window,
    buttonExpression(title, true),
    `pressable control ${title}`,
  );
}

async function waitForButton(
  window: BrowserWindow,
  title: string,
): Promise<void> {
  await waitForRenderer(
    window,
    buttonExpression(title, false),
    `control ${title}`,
  );
}

async function waitForProjectState(
  window: BrowserWindow,
  config: ProjectWorkspaceAcceptanceConfig,
  restarted: boolean,
): Promise<void> {
  const present = `More actions for ${config.projectB}`;
  const absent = `More actions for ${config.projectA}`;
  await waitForRenderer(
    window,
    `(() => ${buttonLookup(present)} !== undefined && ${buttonLookup(absent)} === undefined)()`,
    restarted
      ? "persisted Project state after restart"
      : "Project removal to settle",
  );
}

async function waitForProjectThread(
  window: BrowserWindow,
  project: string,
): Promise<void> {
  try {
    await waitForRenderer(
      window,
      `(() => {
        const action = ${buttonLookup(`New thread in ${project}`)};
        return action instanceof HTMLButtonElement &&
          action.closest(".project-group")?.querySelector(".thread-row-shell") instanceof HTMLElement;
      })()`,
      `Thread created inside Project ${project}`,
    );
  } catch (error) {
    const diagnostics = await window.webContents.executeJavaScript(
      `Promise.all([
        window.zenx.threads.list({ archived: false }),
        window.zenx.projects.get({ archived: false }),
      ]).then(([threads, projects]) => ({
        threads,
        projects,
        groups: Array.from(document.querySelectorAll(".project-group")).map((group) => ({
          text: group.textContent?.trim().replace(/\\s+/gu, " "),
          actions: Array.from(group.querySelectorAll("button")).map((button) => button.getAttribute("aria-label")),
          rows: group.querySelectorAll(".thread-row-shell").length,
        })),
        error: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
      }))`,
      true,
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}`,
    );
  }
}

async function waitForRenderer(
  window: BrowserWindow,
  expression: string,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (window.isDestroyed()) throw new Error("Packaged ZenX window closed");
    if (
      (await window.webContents.executeJavaScript(expression, true)) === true
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for renderer ${label}`);
}

function buttonExpression(title: string, click: boolean): string {
  return `(() => {
    const button = ${buttonLookup(title)};
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    ${click ? "button.click();" : ""}
    return true;
  })()`;
}

function buttonLookup(title: string): string {
  return `Array.from(document.querySelectorAll("button")).find((candidate) =>
    candidate.getAttribute("aria-label") === ${JSON.stringify(title)} ||
    candidate.textContent?.trim().replace(/\\s+/gu, " ") === ${JSON.stringify(title)}
  )`;
}

function readConfig(value: unknown): ProjectWorkspaceAcceptanceConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid packaged Project acceptance config");
  }
  const config = value as Record<string, unknown>;
  const allowed = new Set([
    "fixture",
    "mode",
    "projectA",
    "projectB",
    "resultPath",
  ]);
  if (Object.keys(config).some((key) => !allowed.has(key))) {
    throw new Error("Unknown packaged Project acceptance config field");
  }
  for (const key of [
    "fixture",
    "projectA",
    "projectB",
    "resultPath",
  ] as const) {
    if (typeof config[key] !== "string" || config[key].length === 0) {
      throw new Error(`Invalid packaged Project acceptance ${key}`);
    }
  }
  if (config.mode !== "mutate" && config.mode !== "restart") {
    throw new Error("Invalid packaged Project acceptance mode");
  }
  return config as unknown as ProjectWorkspaceAcceptanceConfig;
}

async function writeResult(
  resultPath: string,
  result: Record<string, unknown>,
): Promise<void> {
  await writeFile(resultPath, `${JSON.stringify(result)}\n`, "utf8");
}
