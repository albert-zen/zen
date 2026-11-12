import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Isolated discovery only: no model request, login, production registration or user config.
const root = await mkdtemp(path.join(os.tmpdir(), "zen-codex-mcp-"));
const home = path.join(root, "codex-home");
await mkdir(home);
const cwd = fileURLToPath(new URL("../../..", import.meta.url));
const fixture = fileURLToPath(
  new URL("../test/fixtures/real-user-mcp-stdio.ts", import.meta.url),
);
const codex = process.env.ZEN_CODEX_EXECUTABLE ?? "codex";
const version = execFileSync(codex, ["--version"], { encoding: "utf8" }).trim();
await writeFile(
  path.join(home, "config.toml"),
  [
    "[mcp_servers.zen_bound]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify(["--import", "tsx", fixture])}`,
    `cwd = ${JSON.stringify(cwd)}`,
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 30",
    "[mcp_servers.zen_bound.env]",
    `ZEN_MCP_FIXTURE_ROOT = ${JSON.stringify(path.join(root, "private-host"))}`,
    "",
  ].join("\n"),
);
const child = spawn(codex, ["app-server", "--stdio"], {
  cwd,
  env: { PATH: process.env.PATH!, HOME: root, CODEX_HOME: home, TMPDIR: root },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (data) => (stderr += String(data)));
let next = 1;
const pending = new Map<
  number,
  { resolve(value: any): void; reject(error: Error): void }
>();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (typeof message.id !== "number") return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  } catch {}
});
const request = (method: string, params: unknown) =>
  new Promise<any>((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out. stderr=${stderr}`));
    }, 90000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
try {
  await request("initialize", {
    clientInfo: { name: "zen-real-mcp-discovery", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const result = await request("mcpServerStatus/list", {
    serverName: "zen_bound",
    detail: "toolsAndAuthOnly",
    limit: 100,
  });
  const server = result.data.find((value: any) => value.name === "zen_bound");
  assert(server, JSON.stringify(result));
  const tools = Object.keys(server.tools).sort();
  assert.deepEqual(
    tools,
    [
      "zenx_threads_read",
      "zenx_board_read",
      "zenx_board_put",
      "zenx_self_control_sidebar_read",
      "zenx_self_control_sidebar_update",
    ].sort(),
  );
  console.log(
    JSON.stringify(
      {
        version,
        server: server.name,
        toolNames: tools,
        authStatus: server.authStatus,
        verified:
          "actual Codex app-server MCP initialize + tools discovery; no LLM turn",
      },
      null,
      2,
    ),
  );
} finally {
  child.stdin.end();
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  lines.close();
  await rm(root, { recursive: true, force: true });
}
