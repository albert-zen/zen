import path from "node:path";
import {
  ZenXTriggerProgramRunner,
  type TriggerProgramRunner,
} from "./trigger-program-runner.js";

export class ImRuntimeSetupOwnershipError extends Error {
  constructor(detail?: string) {
    super(
      ["IM runtime setup process termination could not be confirmed", detail]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

/** Reuse Host process-tree ownership, without creating a Trigger or transcript. */
export async function runTrustedImRuntimeSetup(
  projectDirectory: string,
  signal: AbortSignal,
  options: { runner?: TriggerProgramRunner; timeoutMs?: number } = {},
): Promise<void> {
  signal.throwIfAborted();
  const env: Record<string, string> = {
    UV_PROJECT_ENVIRONMENT: path.join(projectDirectory, ".venv"),
    UV_CACHE_DIR: path.join(projectDirectory, ".uv-cache"),
    UV_PYTHON_INSTALL_DIR: path.join(projectDirectory, ".python"),
    UV_NO_CONFIG: "1",
    UV_NO_PROGRESS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  // Existing local Git/SSH authentication may satisfy the private dependency.
  // Never pass bot credentials. Installer diagnostics belong to the local owner.
  for (const key of [
    "SSH_AUTH_SOCK",
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  const result = await (options.runner ?? new ZenXTriggerProgramRunner()).run(
    {
      command: "uv",
      args: [
        "sync",
        "--locked",
        "--project",
        projectDirectory,
        "--no-dev",
        "--extra",
        "feishu",
        "--python",
        "3.13",
      ],
      cwd: projectDirectory,
      env,
      timeoutMs: options.timeoutMs ?? 300_000,
    },
    { invocationId: "imzenx-runtime-setup", stage: "action", event: {} },
    signal,
  );
  if (result.error?.includes("process-tree containment was not proven"))
    throw new ImRuntimeSetupOwnershipError(result.error);
  // uv's success is its exit status, not the runner's optional JSON action
  // protocol. Preserve available bounded diagnostics on failure for local inspection.
  if (
    result.exitCode === 0 &&
    ["completed", "malformed_output"].includes(result.status)
  )
    return;
  throw new Error(
    [
      `IM runtime preparation ${result.status} (exit code: ${String(result.exitCode)})`,
      result.error,
      result.output,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
