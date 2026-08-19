import type { ComputerInspection } from "./capabilities/computer-provider.js";
import { WinAppCliComputerBackend } from "./capabilities/windows-computer-provider.js";

const arguments_ = parseArguments(process.argv.slice(2));
const target = {
  pid: requiredPositiveInteger(arguments_.pid, "--pid"),
  windowTitle: requiredString(arguments_.title, "--title"),
};
const projectA = requiredString(arguments_["project-a"], "--project-a");
const projectB = requiredString(arguments_["project-b"], "--project-b");
const fixture = requiredString(arguments_.fixture, "--fixture");
const mode = arguments_.mode ?? "mutate";
if (mode !== "mutate" && mode !== "restart") {
  throw new Error("--mode must be mutate or restart");
}

const controller = new AbortController();
const timeout = setTimeout(() => {
  controller.abort(
    new DOMException(
      "Project workspace packaged smoke timed out",
      "AbortError",
    ),
  );
}, 120_000);
timeout.unref();
const backend = new WinAppCliComputerBackend({ platform: "win32" });

try {
  const diagnostic = await backend.diagnose(controller.signal);
  if (!diagnostic.ready) throw new Error(diagnostic.message);
  if (mode === "mutate") {
    await assertNoApplicationMenu();
    await pressNamed("Add project");
    await pressNamed(fixture);
    await pressNamed(projectA);
    await pressNamed("Add folder");
    await waitForNamed(`Remove ${projectA} from ZenX`);

    await pressNamed("Add project");
    await pressNamed(fixture);
    await pressNamed(projectB);
    await pressNamed("Add folder");
    await waitForNamed(`Remove ${projectB} from ZenX`);

    await pressNamed(`Make ${projectB} the default project`);
    await pressNamed(`Remove ${projectA} from ZenX`);
    await waitForInspection(
      (inspection) =>
        hasNamedControl(inspection, `Remove ${projectB} from ZenX`) &&
        !hasNamedControl(inspection, `Remove ${projectA} from ZenX`),
      "Project removal to settle",
    );
  } else {
    const inspection = await waitForInspection(
      (candidate) =>
        hasNamedControl(candidate, `Remove ${projectB} from ZenX`) &&
        !hasNamedControl(candidate, `Remove ${projectA} from ZenX`),
      "persisted Project state after restart",
    );
    assertNoMenuControls(inspection);
  }
  console.log(
    `ZenX packaged Project workspace smoke ${mode} phase passed with WinApp CLI ${diagnostic.version}.`,
  );
} finally {
  clearTimeout(timeout);
  await backend.close();
}

async function assertNoApplicationMenu(): Promise<void> {
  const inspection = await waitForInspection(
    (candidate) => candidate.controls.length > 0,
    "ZenX renderer controls",
  );
  assertNoMenuControls(inspection);
}

function assertNoMenuControls(inspection: ComputerInspection): void {
  const menu = inspection.controls.find((control) =>
    /menu(?:bar|item)?/iu.test(control.role),
  );
  if (menu !== undefined) {
    throw new Error(
      `Packaged ZenX exposed an unexpected native menu control: ${menu.role} ${menu.title}`,
    );
  }
}

async function pressNamed(title: string): Promise<void> {
  const inspection = await waitForInspection(
    (candidate) =>
      candidate.controls.some(
        (control) =>
          control.title === title &&
          control.enabled &&
          control.actions.includes("press"),
      ),
    `pressable control ${title}`,
  );
  assertNoMenuControls(inspection);
  const control = inspection.controls.find(
    (candidate) =>
      candidate.title === title &&
      candidate.enabled &&
      candidate.actions.includes("press"),
  );
  if (control === undefined) throw new Error(`Control disappeared: ${title}`);
  await backend.press(target, control.selector, controller.signal);
}

async function waitForNamed(title: string): Promise<ComputerInspection> {
  return await waitForInspection(
    (inspection) => hasNamedControl(inspection, title),
    `control ${title}`,
  );
}

function hasNamedControl(
  inspection: ComputerInspection,
  title: string,
): boolean {
  return inspection.controls.some((control) => control.title === title);
}

async function waitForInspection(
  accept: (inspection: ComputerInspection) => boolean,
  label: string,
): Promise<ComputerInspection> {
  let lastTitles: string[] = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (controller.signal.aborted) throw controller.signal.reason;
    try {
      const inspection = await backend.inspect(target, controller.signal);
      lastTitles = inspection.controls.map(
        (control) => `${control.role}:${control.title}`,
      );
      if (accept(inspection)) return inspection;
    } catch (error) {
      if (controller.signal.aborted) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${label}; last controls: ${lastTitles.join(", ")}`,
  );
}

function parseArguments(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new Error(
        "Expected --pid <number> --title <title> --fixture <name> --project-a <name> --project-b <name> --mode <mutate|restart>",
      );
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function requiredString(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function requiredPositiveInteger(
  value: string | undefined,
  flag: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}
