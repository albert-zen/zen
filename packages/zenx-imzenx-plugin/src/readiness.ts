import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Configuration } from "./configuration.js";
import type { ManagedChannelInspection } from "./channel-schema.js";

export interface ReadinessCheck {
  id: string;
  status: "ready" | "blocked" | "warning";
  message: string;
  action?: string;
}

const checks: Readonly<Record<string, ReadinessCheck>> = {
  python_ready: {
    id: "python",
    status: "ready",
    message: "Selected Python is version 3.13 or newer.",
  },
  python_unsupported: {
    id: "python",
    status: "blocked",
    message: "Selected Python is older than 3.13.",
    action:
      "Choose the Python 3.13+ executable from the prepared IMZen environment.",
  },
  sdk_ready: {
    id: "sdk",
    status: "ready",
    message:
      "The selected Python environment has the pinned private IM Agent SDK revision.",
  },
  sdk_missing: {
    id: "sdk",
    status: "blocked",
    message:
      "The private IM Agent SDK is missing from the selected Python environment.",
  },
  sdk_unverified: {
    id: "sdk",
    status: "blocked",
    message:
      "The installed IM Agent SDK cannot be verified against the pinned Git revision.",
  },
  workspace_ready: {
    id: "workspace",
    status: "ready",
    message: "The selected workspace is an existing directory.",
  },
  workspace_missing: {
    id: "workspace",
    status: "blocked",
    message: "The selected workspace is unavailable or is not a directory.",
    action: "Choose an existing local workspace directory.",
  },
  shared_filesystem_ready: {
    id: "shared-filesystem",
    status: "ready",
    message: "The selected shared filesystem root is an existing directory.",
  },
  shared_filesystem_missing: {
    id: "shared-filesystem",
    status: "blocked",
    message:
      "The selected shared filesystem root is unavailable or is not a directory.",
    action:
      "Choose an existing shared directory or leave this optional setting empty.",
  },
  channels_ready: {
    id: "channels",
    status: "ready",
    message:
      "The selected IMZen-format file contains enabled supported channels.",
  },
  channels_none: {
    id: "channels",
    status: "blocked",
    message: "The selected channel file has no enabled channels.",
    action:
      "Enable at least one channel in your own private IMZen configuration.",
  },
  channels_invalid: {
    id: "channels",
    status: "blocked",
    message:
      "The selected channel file is unreadable or does not match the IMZen configuration contract.",
    action:
      "Use your own IMZen-format JSON file with qq, telegram, feishu or weixin channel objects.",
  },
  allowlist_ready: {
    id: "allowlist",
    status: "ready",
    message:
      "Every enabled channel has an explicit user or conversation access restriction.",
  },
  allowlist_required: {
    id: "allowlist",
    status: "blocked",
    message:
      "Unrestricted Full Access is blocked without an explicit deployment opt-in.",
    action:
      "Set allowed_user_ids or allowed_conversation_ids in your own channel file. A wildcard alone is unrestricted.",
  },
  allowlist_unrestricted: {
    id: "allowlist",
    status: "warning",
    message: "An enabled channel has no effective access restriction.",
    action:
      "Set allowed_user_ids or allowed_conversation_ids before exposing the bot to other users.",
  },
  credentials_ready: {
    id: "credentials",
    status: "ready",
    message:
      "The explicitly configured QQ credentials match the existing IMZen contract. No values are returned.",
  },
  credentials_invalid: {
    id: "credentials",
    status: "blocked",
    message:
      "The explicitly configured QQ credentials are unavailable or invalid.",
    action:
      "In your private QQ file, use only decimal appid and nonempty appsecret; reference it with credentials_file. Never enter secrets in tools or chat.",
  },
  credentials_private_file_required: {
    id: "credentials",
    status: "blocked",
    message:
      "The declared QQ credentials file is not a private regular file owned by this user.",
    action:
      "Use a non-symlink credential file; on POSIX, make it user-owned with mode 600.",
  },
  other_credentials_deferred: {
    id: "channel-credentials",
    status: "warning",
    message:
      "Non-QQ credential schemas are owned by the SDK and are checked only during explicit connection.",
  },
  feishu_ready: {
    id: "feishu",
    status: "ready",
    message:
      "The Feishu extra is installed in the selected Python environment.",
  },
  feishu_missing: {
    id: "feishu",
    status: "blocked",
    message: "An enabled Feishu channel requires the Feishu extra.",
  },
  managed_credentials_ready: {
    id: "credentials",
    status: "ready",
    message:
      "The managed channel's required fields and private credentials are configured. No credential values are returned.",
  },
  managed_credentials_missing: {
    id: "credentials",
    status: "blocked",
    message:
      "The managed channel is missing required fields or private credentials.",
    action:
      "Complete the channel form's required fields. Enter secrets only in the local write-only credential fields.",
  },
  probe_failed: {
    id: "runtime",
    status: "blocked",
    message: "The selected Python readiness check could not complete.",
    action:
      "Choose a working Python executable from your prepared IMZen environment and check again.",
  },
};

/** Fixed vocabulary is the output boundary: never expose subprocess diagnostics. */
export async function inspectReadiness(
  config: Configuration,
  signal: AbortSignal,
  managed?: ManagedChannelInspection,
): Promise<{ checks: ReadinessCheck[]; enabledChannels: string[] }> {
  const script = fileURLToPath(
    new URL("../python/src/imzen/readiness.py", import.meta.url),
  );
  const requiredChannels =
    managed?.channels
      .filter((channel) => channel.enabled)
      .map((channel) => channel.id) ?? [];
  const result = await probe(
    config,
    script,
    signal,
    managed !== undefined,
    requiredChannels,
  );
  if (managed !== undefined) {
    const enabled = managed.channels.filter((channel) => channel.enabled);
    result.enabledChannels = enabled.map((channel) => channel.id);
    result.codes.push(enabled.length ? "channels_ready" : "channels_none");
    if (enabled.length) {
      result.codes.push(
        enabled.every((channel) => channel.accessRestricted)
          ? "allowlist_ready"
          : config.permissionMode === "full-access" &&
              !config.allowUnrestrictedFullAccess
            ? "allowlist_required"
            : "allowlist_unrestricted",
      );
      result.codes.push(
        enabled.every((channel) => channel.credentialsConfigured)
          ? "managed_credentials_ready"
          : "managed_credentials_missing",
      );
    }
  }
  const setup = `Use the explicit Prepare runtime action in IMZenX to copy the trusted locked project into a private writable runtime directory and install the pinned SDK with private repository access. Source-checkout alternative: uv sync --project apps/imzen --locked${result.enabledChannels.includes("feishu") ? " --extra feishu" : ""}. Then select that environment's .venv Python executable. This readiness check installs nothing.`;
  return {
    checks: result.codes.map((code) => {
      const check = checks[code]!;
      return {
        ...check,
        ...(["sdk_missing", "sdk_unverified", "feishu_missing"].includes(code)
          ? { action: setup }
          : {}),
      };
    }),
    enabledChannels: result.enabledChannels,
  };
}

async function probe(
  config: Configuration,
  script: string,
  signal: AbortSignal,
  skipChannelsInspection = false,
  requiredChannels: readonly string[] = [],
): Promise<{ codes: string[]; enabledChannels: string[] }> {
  signal.throwIfAborted();
  const failed: { codes: string[]; enabledChannels: string[] } = {
    codes: ["probe_failed"],
    enabledChannels: [],
  };
  return await new Promise((resolve, reject) => {
    // No shell, inherited credentials, channel factory or IM transport entrypoint.
    const env: Record<string, string> = {};
    for (const key of ["SystemRoot", "WINDIR", "LANG", "LC_ALL", "TMP", "TEMP"])
      if (process.env[key] !== undefined) env[key] = process.env[key]!;
    const child = spawn(config.pythonExecutable, ["-I", "-B", script], {
      shell: false,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (value: typeof failed, aborted = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      if (aborted)
        reject(signal.reason ?? new Error("Readiness check cancelled"));
      else resolve(value);
    };
    const abort = () => finish(failed, true);
    const timer = setTimeout(() => finish(failed), 8000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => finish(failed));
    child.once("error", () => finish(failed));
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 16000) finish(failed);
    });
    child.once("close", (code) => {
      if (code !== 0) return finish(failed);
      try {
        const value = JSON.parse(output) as {
          codes?: unknown;
          enabledChannels?: unknown;
        };
        if (
          !Array.isArray(value.codes) ||
          value.codes.length === 0 ||
          value.codes.length > 20 ||
          value.codes.some(
            (code) => typeof code !== "string" || !Object.hasOwn(checks, code),
          ) ||
          !Array.isArray(value.enabledChannels) ||
          value.enabledChannels.length > 4 ||
          value.enabledChannels.some(
            (channel) =>
              !["qq", "telegram", "feishu", "weixin"].includes(channel),
          )
        )
          return finish(failed);
        const codes = value.codes as string[];
        const ids = codes.map((code) => checks[code]!.id);
        if (
          new Set(ids).size !== ids.length ||
          (![
            "python",
            "sdk",
            "workspace",
            ...(skipChannelsInspection ? [] : ["channels"]),
          ].every((id) => ids.includes(id)) &&
            !(codes.length === 1 && codes[0] === "probe_failed")) ||
          (value.enabledChannels.length > 0 && !ids.includes("allowlist")) ||
          (value.enabledChannels.includes("qq") &&
            !ids.includes("credentials")) ||
          (config.sharedFilesystemRoot !== undefined &&
            !ids.includes("shared-filesystem")) ||
          ((value.enabledChannels.includes("feishu") ||
            requiredChannels.includes("feishu")) &&
            !ids.includes("feishu"))
        )
          return finish(failed);
        finish({ codes, enabledChannels: value.enabledChannels as string[] });
      } catch {
        finish(failed);
      }
    });
    if (signal.aborted) abort();
    else
      child.stdin.end(
        JSON.stringify({
          ...config,
          skipChannelsInspection,
          requiredChannels,
        }) + "\n",
      );
  });
}
