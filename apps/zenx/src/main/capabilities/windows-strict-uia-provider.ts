import { randomUUID } from "node:crypto";
import type { ZenXPluginManifestV2 } from "./types.js";
import {
  ComputerObservationLedger,
  selectComputerInspectionControls,
  uniqueComputerCaptureEntries,
  type ComputerControlAction,
  type ComputerControlSelector,
  type ComputerInspection,
  type ComputerKey,
  type ComputerTarget,
  type ZenXComputerBackend,
} from "./computer-provider.js";
import { OBSERVATION_CAPTURE } from "./observation-capture.js";
import {
  SpawnWinAppCliRunner,
  WinAppCliComputerBackend,
  windowsComputerCapabilityManifest,
  type WinAppCliRunner,
  type WinAppCliRunOptions,
  type WinAppCliRunResult,
} from "./windows-computer-provider.js";
import {
  parseStrictUiaReply,
  validateStrictUiaProbe,
  STRICT_UIA_PROVIDER_ID,
  STRICT_UIA_VERSION,
  type StrictUiaControl,
  type StrictUiaOperation,
  type StrictUiaRoot,
} from "./windows-strict-uia-contract.js";

export const windowsStrictUiaCapabilityManifest: ZenXPluginManifestV2 = {
  ...structuredClone(windowsComputerCapabilityManifest),
  version: "1.2.0",
  description:
    "Verified ZenX downstream UIA client with automatic focus disabled. Exact native controls support single semantic actions without requested activation; the target application may still change focus itself. Strict capture never restores or activates windows.",
  provider: {
    ...structuredClone(windowsComputerCapabilityManifest.provider),
    id: STRICT_UIA_PROVIDER_ID,
    interactionModes: ["background_safe"],
    capabilities: [
      ...windowsComputerCapabilityManifest.provider.capabilities,
      "uia.auto_set_focus_disabled",
      "native_identity_revalidated",
      "single_pattern_dispatch",
    ],
  },
  permissions: windowsComputerCapabilityManifest.permissions
    .filter((permission) => permission.id !== "computer.foreground.control")
    .map((permission) => structuredClone(permission)),
  tools: windowsComputerCapabilityManifest.tools.map((tool) => {
    if (tool.name !== "computer_press" && tool.name !== "computer_set_value")
      return structuredClone(tool);
    return {
      ...structuredClone(tool),
      interactionMode: "background_safe",
      permissions: tool.permissions.filter(
        (permission) => permission !== "computer.foreground.control",
      ),
      capabilities: tool.capabilities
        .filter((capability) => capability !== "may_activate_target")
        .concat("uia.auto_set_focus_disabled", "native_identity_revalidated"),
      description: `${tool.name === "computer_press" ? "Invoke once" : "Set and verify the exact supplied text"} on one freshly observed, uniquely identified native HWND control using the verified downstream UIA client with AutoSetFocus=false. No selector, other-pattern, activation or global-input fallback. Virtual and stale controls are refused. The target application itself can still change focus; interruption after possible dispatch has an unknown outcome and must not be retried automatically.`,
    };
  }),
};

/** A failed/aborted invocation never claims rollback or absence of app effects. */
export class StrictUiaOperationError extends Error {
  constructor(
    readonly outcome: "not_dispatched" | "unknown",
    operation: string,
    reason: string,
  ) {
    super(
      `Strict UIA ${operation} ${outcome === "unknown" ? "outcome unknown" : "not dispatched"}: ${reason}`,
    );
    this.name = "StrictUiaOperationError";
  }
}

/** App-selected direct native client; stock reads/capture keep their existing boundaries. */
export class WinAppStrictUiaComputerBackend implements ZenXComputerBackend {
  readonly #command: string;
  readonly #platform: NodeJS.Platform;
  readonly #runner: WinAppCliRunner;
  readonly #bind: () => Promise<() => Promise<void>>;
  readonly #stock: WinAppCliComputerBackend;
  readonly #observations = new ComputerObservationLedger();
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<WinAppCliRunResult>>();
  readonly #scope = randomUUID();
  constructor(options: {
    command: string;
    platform: NodeJS.Platform;
    runner?: WinAppCliRunner;
    bindBeforeSpawn: () => Promise<() => Promise<void>>;
  }) {
    this.#command = options.command;
    this.#platform = options.platform;
    this.#runner = options.runner ?? new SpawnWinAppCliRunner();
    this.#bind = options.bindBeforeSpawn;
    this.#stock = new WinAppCliComputerBackend({
      ...options,
      runner: {
        run: (command, args, runOptions) =>
          this.#run(command, args, runOptions),
      },
    });
  }
  async diagnose(signal?: AbortSignal): Promise<{
    ready: boolean;
    executable: string;
    version: string;
    message: string;
  }> {
    try {
      const result = await this.#run(this.#command, ["--zenx-uia-contract"], {
        timeoutMs: 5000,
        signal,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
      });
      validateStrictUiaProbe(result.stdout);
      return {
        ready: true,
        executable: this.#command,
        version: STRICT_UIA_VERSION,
        message:
          "Verified downstream UIA client reports live AutoSetFocus=false",
      };
    } catch (error) {
      return {
        ready: false,
        executable: this.#command,
        version: STRICT_UIA_VERSION,
        message:
          error instanceof Error
            ? error.message
            : "Strict UIA diagnostic failed",
      };
    }
  }
  async listWindows(query?: string, signal?: AbortSignal) {
    return await this.#stock.listWindows(query, this.#signal(signal));
  }
  async screenshot(target: ComputerTarget, signal?: AbortSignal) {
    return await this.#stock.screenshot(target, this.#signal(signal));
  }
  async inspect(
    target: ComputerTarget,
    signal?: AbortSignal,
  ): Promise<ComputerInspection> {
    const exact = await this.#stock.resolveWindowForStrictUia(
      target,
      this.#signal(signal),
    );
    const reply = await this.#request(
      "inspect",
      { hwnd: exact.hwnd, pid: exact.pid },
      signal,
    );
    const root = reply.root!;
    if (root.hwnd !== exact.hwnd || root.pid !== exact.pid)
      throw new Error(
        "Strict UIA inspection changed the exact window identity",
      );
    const controls = reply.controls!;
    const counts = new Map<string, number>();
    for (const control of controls)
      counts.set(control.hwnd, (counts.get(control.hwnd) ?? 0) + 1);
    const actions = (control: StrictUiaControl): ComputerControlAction[] => {
      if (
        control.hwnd === "0" ||
        counts.get(control.hwnd) !== 1 ||
        control.pid !== root.pid ||
        !control.enabled ||
        control.password ||
        control.offscreen
      )
        return [];
      return [
        ...(control.invokePattern ? ["press" as const] : []),
        ...(control.valuePattern && control.valueReadOnly === false
          ? ["set_value" as const]
          : []),
      ];
    };
    const preferred = selectComputerInspectionControls(
      controls,
      (control) => actions(control).length > 0,
    );
    const included = new Set(preferred);
    const ordered = [
      ...preferred,
      ...controls.filter((control) => !included.has(control)),
    ];
    const fingerprints = ordered.map((control) => ({
      identifier: JSON.stringify({ root, control, target: exact.target }),
      role: role(control.controlType),
      title: control.name,
      description: control.automationId,
      frame: JSON.stringify(control.bounds),
      actions: actions(control),
    }));
    const key = targetKey(target);
    const observed = this.#observations.observe(key, fingerprints);
    const publicControls = ordered.map((control, index) => ({
      selector: observed.selectors[index]!,
      role: role(control.controlType),
      title: control.name.slice(0, 256),
      enabled: control.enabled,
      actions: fingerprints[index]!.actions,
    }));
    return {
      platform: "win32",
      observationId: observed.observationId,
      target: exact.target,
      controls: publicControls.slice(0, preferred.length),
      truncated: controls.length > preferred.length,
      [OBSERVATION_CAPTURE]: {
        assertCurrent: () =>
          this.#observations.assertCurrent(key, observed.observationId),
        scopeKey: JSON.stringify([this.#scope, root]),
        entries: uniqueComputerCaptureEntries(
          publicControls,
          fingerprints.map((fingerprint) => fingerprint.identifier),
        ).map((entry, index) =>
          // An anonymous virtual row is observable, but has no continuity identity.
          ordered[index]!.runtimeId.length === 0
            ? { value: entry.value }
            : entry,
        ),
        coverage: {
          scope: "exact_window_strict_native_uia_capture",
          // Complete bounded traversal does not imply every row is identifiable.
          sourceComplete: true,
          reasons: [],
          itemTotal: publicControls.length,
        },
      },
    };
  }
  async press(
    target: ComputerTarget,
    control: ComputerControlSelector,
    signal?: AbortSignal,
    onStopping?: () => void,
  ) {
    const identity = this.#consume(target, control, "press");
    await this.#request(
      "invoke",
      { root: identity.root, control: identity.control },
      signal,
      onStopping,
    );
    return { target: identity.target, control };
  }
  async setValue(
    target: ComputerTarget,
    control: ComputerControlSelector,
    value: string,
    signal?: AbortSignal,
    onStopping?: () => void,
  ) {
    if (value.length > 4000)
      throw new Error("computer_set_value is limited to 4000 characters");
    const identity = this.#consume(target, control, "set_value");
    const result = await this.#request(
      "set_value",
      { root: identity.root, control: identity.control, value },
      signal,
      onStopping,
    );
    if (result.value !== value)
      throw new StrictUiaOperationError(
        "unknown",
        "set_value",
        "exact Unicode readback did not match",
      );
    return { target: identity.target, control, characterCount: value.length };
  }
  #consume(
    target: ComputerTarget,
    control: ComputerControlSelector,
    action: ComputerControlAction,
  ): {
    root: StrictUiaRoot;
    control: StrictUiaControl;
    target: ComputerInspection["target"];
  } {
    this.#signal();
    const fingerprint = this.#observations.consume(
      targetKey(target),
      control,
      action,
    );
    // The opaque ledger owns this bounded identity; no caller can provide native fields.
    return JSON.parse(fingerprint.identifier!);
  }
  async #request(
    operation: StrictUiaOperation,
    payload: object,
    signal?: AbortSignal,
    onStopping?: () => void,
  ) {
    let spawned = false;
    try {
      const result = await this.#run(this.#command, ["--zenx-uia-strict"], {
        stdin: JSON.stringify({ schemaVersion: 1, operation, ...payload }),
        signal,
        onStopping,
        onSpawn: () => {
          spawned = true;
        },
        timeoutMs: 15000,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 4096,
      });
      const reply = parseStrictUiaReply(result.stdout, operation);
      if (reply.outcome !== "completed")
        throw new StrictUiaOperationError(
          reply.outcome,
          operation,
          reply.error ?? "native refusal",
        );
      return reply;
    } catch (error) {
      if (error instanceof StrictUiaOperationError) throw error;
      throw new StrictUiaOperationError(
        operation !== "inspect" && spawned ? "unknown" : "not_dispatched",
        operation,
        spawned
          ? "native transport or contract did not confirm completion"
          : "provider was not started",
      );
    }
  }
  #signal(signal?: AbortSignal): AbortSignal {
    if (this.#platform !== "win32")
      throw new Error("Strict UIA provider requires Windows");
    this.#lifetime.signal.throwIfAborted();
    return signal
      ? AbortSignal.any([this.#lifetime.signal, signal])
      : this.#lifetime.signal;
  }
  async #run(
    command: string,
    args: readonly string[],
    options: WinAppCliRunOptions,
  ): Promise<WinAppCliRunResult> {
    const signal = this.#signal(options.signal);
    signal.throwIfAborted();
    const pending = this.#runner.run(command, args, {
      ...options,
      signal,
      bindBeforeSpawn: this.#bind,
    });
    this.#pending.add(pending);
    try {
      return await pending;
    } finally {
      this.#pending.delete(pending);
    }
  }
  async foregroundClick(): Promise<void> {
    throw new Error("Strict UIA provider does not support global input");
  }
  async foregroundKeyPress(_key: ComputerKey): Promise<void> {
    throw new Error("Strict UIA provider does not support global input");
  }
  async foregroundScroll(): Promise<void> {
    throw new Error("Strict UIA provider does not support global input");
  }
  async close(): Promise<void> {
    this.#lifetime.abort(
      new Error("Strict UIA provider closed; invocation revoked"),
    );
    this.#observations.clear();
    await Promise.allSettled([...this.#pending]);
    await this.#stock.close();
  }
}
function targetKey(target: ComputerTarget): string {
  return JSON.stringify([
    target.pid ?? null,
    target.applicationId ?? null,
    target.bundleId ?? null,
    target.windowTitle ?? null,
  ]);
}
function role(controlType: number): string {
  return (
    (
      {
        50000: "Button",
        50004: "Edit",
        50020: "Text",
        50032: "Window",
      } as Record<number, string>
    )[controlType] ?? `UIA ${String(controlType)}`
  );
}
