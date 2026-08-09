import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ComputerControlSelector,
  ComputerInspection,
  ComputerKey,
  ComputerTarget,
  ZenXComputerBackend,
} from "./computer-provider.js";
import {
  COMPUTER_ACTION_PRESS,
  COMPUTER_ACTION_SET_VALUE,
  type ComputerControlAction,
} from "./computer-provider.js";
import {
  type ExternalProviderProcessRunner,
  parseExternalJson,
} from "./external-provider.js";

const PEEKABOO_TIMEOUT_MS = 25_000;
const MAX_PEEKABOO_CONTROLS = 32;

interface PeekabooElement {
  id: string;
  role: string;
  title?: string;
  label?: string;
  description?: string;
  identifier?: string;
  is_actionable: boolean;
}

interface PeekabooObservedTarget {
  rawElementId: string;
  snapshotId: string;
  actions: ComputerControlAction[];
  secure: boolean;
  fingerprint: string;
}

interface PeekabooObservation {
  observationId: string;
  targetKey: string;
  snapshotId: string;
  targets: Map<string, PeekabooObservedTarget>;
}

export class PeekabooComputerBackend implements ZenXComputerBackend {
  readonly #executable: string;
  readonly #runner: ExternalProviderProcessRunner;
  readonly #artifactDirectory: string;
  readonly #observations = new Map<string, PeekabooObservation>();
  readonly #snapshotIds = new Set<string>();

  constructor(options: {
    executable: string;
    runner: ExternalProviderProcessRunner;
    artifactDirectory?: string;
  }) {
    this.#executable = options.executable;
    this.#runner = options.runner;
    this.#artifactDirectory =
      options.artifactDirectory ??
      path.join(os.tmpdir(), `zenx-peekaboo-${String(process.pid)}`);
  }

  async inspect(
    target: ComputerTarget,
    signal?: AbortSignal,
  ): Promise<ComputerInspection> {
    const response = await this.#run(
      [
        "see",
        ...peekabooTargetArguments(target),
        "--max-elements",
        "128",
        "--timeout-seconds",
        "20",
      ],
      signal,
    );
    const data = requirePeekabooData(response, "see");
    const snapshotId = requiredString(data, "snapshot_id", "see.data");
    this.#snapshotIds.add(snapshotId);
    const elements = requiredArray(data, "ui_elements", "see.data").map(
      requirePeekabooElement,
    );
    const selected = elements.slice(0, MAX_PEEKABOO_CONTROLS);
    const observationId = randomUUID();
    const targets = new Map<string, PeekabooObservedTarget>();
    const controls = selected.map((element) => {
      const targetId = randomUUID();
      const secure = isSecurePeekabooElement(element);
      const actions = peekabooElementActions(element, secure);
      targets.set(targetId, {
        rawElementId: element.id,
        snapshotId,
        actions,
        secure,
        fingerprint: peekabooElementFingerprint(element),
      });
      return {
        selector: { observationId, targetId },
        role: element.role,
        title: element.label ?? element.title ?? element.description ?? "",
        enabled: element.is_actionable,
        actions,
        ...(secure ? { secure: true as const } : {}),
      };
    });
    const key = computerTargetKey(target);
    const prior = this.#observations.get(key);
    if (prior !== undefined) {
      await this.#cleanSnapshot(prior.snapshotId);
    }
    this.#observations.set(key, {
      observationId,
      targetKey: key,
      snapshotId,
      targets,
    });
    return {
      platform: "darwin",
      observationId,
      target: targetSummary(target, data),
      controls,
      truncated: elements.length > selected.length || data.truncation != null,
    };
  }

  async press(
    target: ComputerTarget,
    control: ComputerControlSelector,
    signal?: AbortSignal,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
  }> {
    const observed = this.#consume(target, control, COMPUTER_ACTION_PRESS);
    let fresh: { rawElementId: string; snapshotId: string } | undefined;
    try {
      fresh = await this.#revalidate(target, observed, signal);
      await this.#run(
        [
          "click",
          "--on",
          fresh.rawElementId,
          "--snapshot",
          fresh.snapshotId,
          ...peekabooTargetArguments(target),
        ],
        signal,
      );
    } finally {
      await this.#cleanSnapshot(observed.snapshotId);
      if (fresh !== undefined) await this.#cleanSnapshot(fresh.snapshotId);
    }
    return { target: targetSummary(target), control };
  }

  async setValue(
    target: ComputerTarget,
    control: ComputerControlSelector,
    value: string,
    signal?: AbortSignal,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
    characterCount: number;
  }> {
    const observed = this.#consume(target, control, COMPUTER_ACTION_SET_VALUE);
    let fresh: { rawElementId: string; snapshotId: string } | undefined;
    try {
      fresh = await this.#revalidate(target, observed, signal);
      await this.#run(
        [
          "set-value",
          value,
          "--on",
          fresh.rawElementId,
          "--snapshot",
          fresh.snapshotId,
        ],
        signal,
      );
    } finally {
      await this.#cleanSnapshot(observed.snapshotId);
      if (fresh !== undefined) await this.#cleanSnapshot(fresh.snapshotId);
    }
    return {
      target: targetSummary(target),
      control,
      characterCount: value.length,
    };
  }

  async screenshot(
    target: ComputerTarget,
    signal?: AbortSignal,
  ): Promise<{
    artifactPath: string;
    target: ComputerInspection["target"];
    width: number;
    height: number;
    bytes: number;
    expiresAt: string;
  }> {
    await mkdir(this.#artifactDirectory, { recursive: true, mode: 0o700 });
    const artifactPath = path.join(
      this.#artifactDirectory,
      `${randomUUID()}.png`,
    );
    const response = await this.#run(
      [
        "image",
        ...peekabooTargetArguments(target),
        "--capture-focus",
        "background",
        "--format",
        "png",
        "--path",
        artifactPath,
      ],
      signal,
    );
    requirePeekabooData(response, "image");
    const file = await readFile(artifactPath);
    const dimensions = pngDimensions(file);
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const timer = setTimeout(
      () => void rm(artifactPath, { force: true }),
      5 * 60_000,
    );
    timer.unref();
    return {
      artifactPath,
      target: targetSummary(target),
      width: dimensions.width,
      height: dimensions.height,
      bytes: (await stat(artifactPath)).size,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async foregroundClick(
    x: number,
    y: number,
    button: "left" | "right",
    signal: AbortSignal,
  ): Promise<void> {
    await this.#run(
      [
        "click",
        "--coords",
        `${String(Math.round(x))},${String(Math.round(y))}`,
        "--global-coords",
        "--foreground",
        ...(button === "right" ? ["--right"] : []),
      ],
      signal,
    );
  }

  async foregroundKeyPress(
    key: ComputerKey,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#run(["press", peekabooKey(key), "--foreground"], signal);
  }

  async foregroundScroll(deltaY: number, signal: AbortSignal): Promise<void> {
    await this.#run(
      [
        "scroll",
        "--direction",
        deltaY > 0 ? "down" : "up",
        "--amount",
        String(Math.max(1, Math.min(100, Math.round(Math.abs(deltaY) / 100)))),
        "--foreground",
      ],
      signal,
    );
  }

  async close(): Promise<void> {
    this.#observations.clear();
    for (const snapshotId of [...this.#snapshotIds]) {
      await this.#cleanSnapshot(snapshotId);
    }
    await rm(this.#artifactDirectory, { recursive: true, force: true });
  }

  #consume(
    target: ComputerTarget,
    control: ComputerControlSelector,
    action: ComputerControlAction,
  ): PeekabooObservedTarget {
    const key = computerTargetKey(target);
    const observation = this.#observations.get(key);
    if (
      observation === undefined ||
      observation.targetKey !== key ||
      observation.observationId !== control.observationId
    ) {
      throw new Error(
        "Computer observation is stale, unknown, or scoped to another target; inspect again",
      );
    }
    const selected = observation.targets.get(control.targetId);
    if (selected === undefined) {
      throw new Error("Computer target ID is forged, stale, or unknown");
    }
    if (!selected.actions.includes(action)) {
      throw new Error(`Computer target does not support ${action}`);
    }
    if (action === COMPUTER_ACTION_SET_VALUE && selected.secure) {
      throw new Error(
        "computer_set_value rejects password or secure controls because supplied text is journaled",
      );
    }
    this.#observations.delete(key);
    return selected;
  }

  async #revalidate(
    target: ComputerTarget,
    observed: PeekabooObservedTarget,
    signal?: AbortSignal,
  ): Promise<{ rawElementId: string; snapshotId: string }> {
    const response = await this.#run(
      [
        "see",
        ...peekabooTargetArguments(target),
        "--max-elements",
        "128",
        "--timeout-seconds",
        "20",
      ],
      signal,
    );
    const data = requirePeekabooData(response, "see");
    const snapshotId = requiredString(data, "snapshot_id", "see.data");
    this.#snapshotIds.add(snapshotId);
    const matches = requiredArray(data, "ui_elements", "see.data")
      .map(requirePeekabooElement)
      .filter(
        (element) =>
          peekabooElementFingerprint(element) === observed.fingerprint &&
          isSecurePeekabooElement(element) === observed.secure &&
          sameActions(
            peekabooElementActions(element, observed.secure),
            observed.actions,
          ),
      );
    if (matches.length !== 1) {
      throw new Error(
        "Peekaboo target identity changed, disappeared, or became ambiguous; inspect again",
      );
    }
    return { rawElementId: matches[0]!.id, snapshotId };
  }

  async #cleanSnapshot(snapshotId: string): Promise<void> {
    if (snapshotId.length === 0) return;
    if (!this.#snapshotIds.delete(snapshotId)) return;
    await this.#runner
      .run(this.#executable, ["clean", "--snapshot", snapshotId, "--json"], {
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      })
      .catch(() => undefined);
  }

  async #run(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await this.#runner.run(
      this.#executable,
      [...args, "--json"],
      {
        timeoutMs: PEEKABOO_TIMEOUT_MS,
        signal,
        maxOutputBytes: 512 * 1024,
      },
    );
    const response = parseExternalJson("peekaboo", result.stdout);
    if (response.success !== true) {
      const error = asRecord(response.error);
      throw new Error(
        `peekaboo: ${String(error?.message ?? "unknown provider error")}`,
      );
    }
    return response;
  }
}

function requirePeekabooData(
  response: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  const data = asRecord(response.data);
  if (data === undefined) {
    throw new Error(
      `Unsupported Peekaboo 3.x JSON schema: ${operation}.data must be an object`,
    );
  }
  return data;
}

function requirePeekabooElement(value: unknown): PeekabooElement {
  const element = asRecord(value);
  if (
    element === undefined ||
    typeof element.id !== "string" ||
    typeof element.role !== "string" ||
    typeof element.is_actionable !== "boolean"
  ) {
    throw new Error(
      "Unsupported Peekaboo 3.x JSON schema: invalid ui_elements entry",
    );
  }
  return {
    id: element.id,
    role: element.role,
    is_actionable: element.is_actionable,
    ...optionalTextProperties(element, [
      "title",
      "label",
      "description",
      "identifier",
    ]),
  };
}

function optionalTextProperties(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) =>
      typeof value[key] === "string" ? [[key, value[key]]] : [],
    ),
  );
}

function peekabooTargetArguments(target: ComputerTarget): string[] {
  const application = target.bundleId ?? target.applicationId;
  if (target.pid === undefined && application === undefined) {
    throw new Error("Peekaboo target requires pid, bundleId, or applicationId");
  }
  const selector =
    target.pid === undefined && application !== undefined
      ? ["--app", application]
      : ["--pid", String(target.pid)];
  return [
    ...selector,
    ...(target.windowTitle === undefined
      ? []
      : ["--window-title", target.windowTitle]),
  ];
}

function computerTargetKey(target: ComputerTarget): string {
  return JSON.stringify({
    pid: target.pid ?? null,
    applicationId: target.applicationId ?? null,
    bundleId: target.bundleId ?? null,
    windowTitle: target.windowTitle ?? null,
  });
}

function targetSummary(
  target: ComputerTarget,
  data: Record<string, unknown> = {},
): ComputerInspection["target"] {
  return {
    pid: target.pid ?? 0,
    ...(target.applicationId === undefined
      ? {}
      : { applicationId: target.applicationId }),
    ...(target.bundleId === undefined ? {} : { bundleId: target.bundleId }),
    applicationName:
      typeof data.application_name === "string"
        ? data.application_name
        : (target.bundleId ??
          target.applicationId ??
          `PID ${String(target.pid ?? "unknown")}`),
    ...(target.windowTitle === undefined
      ? {}
      : { windowTitle: target.windowTitle }),
  };
}

function isSecurePeekabooElement(element: PeekabooElement): boolean {
  return /secure|password/iu.test(
    `${element.role} ${element.title ?? ""} ${element.label ?? ""} ${element.description ?? ""}`,
  );
}

function peekabooElementActions(
  element: PeekabooElement,
  secure: boolean,
): ComputerControlAction[] {
  const editable = /text|search|combo/iu.test(element.role);
  const actions: ComputerControlAction[] = [];
  if (element.is_actionable) actions.push(COMPUTER_ACTION_PRESS);
  if (editable && !secure) actions.push(COMPUTER_ACTION_SET_VALUE);
  return actions;
}

function peekabooElementFingerprint(element: PeekabooElement): string {
  return JSON.stringify({
    role: element.role,
    identifier: element.identifier ?? null,
    title: element.title ?? null,
    label: element.label ?? null,
    description: element.description ?? null,
  });
}

function sameActions(
  left: readonly ComputerControlAction[],
  right: readonly ComputerControlAction[],
): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function peekabooKey(key: ComputerKey): string {
  return (
    {
      enter: "return",
      escape: "escape",
      tab: "tab",
      backspace: "delete",
      space: "space",
      arrowUp: "up",
      arrowDown: "down",
      arrowLeft: "left",
      arrowRight: "right",
    } as const
  )[key];
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (
    buffer.length < 24 ||
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("Peekaboo screenshot is not a valid PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  owner: string,
): string {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(
      `Unsupported Peekaboo 3.x JSON schema: ${owner}.${key} must be a string`,
    );
  }
  return value[key];
}

function requiredArray(
  value: Record<string, unknown>,
  key: string,
  owner: string,
): unknown[] {
  if (!Array.isArray(value[key])) {
    throw new Error(
      `Unsupported Peekaboo 3.x JSON schema: ${owner}.${key} must be an array`,
    );
  }
  return value[key];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
