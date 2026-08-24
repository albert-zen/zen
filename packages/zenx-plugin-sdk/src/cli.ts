#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validatePluginPackage } from "./schema.js";

const SDK_VERSION = "0.1.0";

async function main(): Promise<void> {
  const [command, targetArgument, ...arguments_] = process.argv.slice(2);
  if (targetArgument === undefined) {
    throw new Error("Usage: zenx-plugin <create|validate|pack> <directory>");
  }
  if (command === "validate") {
    const validated = await validatePluginPackage(targetArgument);
    process.stdout.write(
      `${JSON.stringify({ packageName: validated.packageName, pluginId: validated.manifest.id, manifestPath: validated.manifestPath })}\n`,
    );
    return;
  }
  if (command === "pack") {
    const validated = await validatePluginPackage(targetArgument);
    process.stdout.write(await npmPack(validated.packageRoot));
    return;
  }
  if (command !== "create")
    throw new Error(`Unknown command: ${String(command)}`);
  const packageName = option(arguments_, "--name");
  const pluginId = option(arguments_, "--id");
  validatePackageName(packageName);
  validatePluginId(pluginId);
  const target = path.resolve(targetArgument);
  await mkdir(target);

  const packageJson = {
    name: packageName,
    version: "0.1.0",
    description: `${pluginId} plugin for ZenX`,
    type: "module",
    files: ["runtime.mjs", "zenx.plugin.json", "README.md"],
    scripts: {
      validate: "zenx-plugin validate .",
      pack: "zenx-plugin pack .",
    },
    dependencies: { "@zenx/plugin-sdk": `^${SDK_VERSION}` },
    zenx: { plugin: "./zenx.plugin.json" },
  };
  const toolName = `${pluginId.replaceAll("-", "_")}_run`;
  const manifest = {
    schemaVersion: 2,
    id: pluginId,
    name: title(pluginId),
    version: "0.1.0",
    description: `${title(pluginId)} plugin`,
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    mainDocument: `Use ${toolName} to run ${title(pluginId)}.`,
    provider: {
      id: `${pluginId}-process`,
      platforms: ["darwin", "linux", "win32"],
      interactionModes: ["background_safe"],
      capabilities: [`${pluginId}.run`],
    },
    permissions: [],
    tools: [
      {
        name: toolName,
        description: `Run ${title(pluginId)}`,
        inputSchema: { type: "object", additionalProperties: true },
        permissions: [],
        interactionMode: "background_safe",
        capabilities: [`${pluginId}.run`],
      },
    ],
    resources: [],
    runtime: { type: "process", entry: "./runtime.mjs" },
  };
  await Promise.all([
    writeJson(path.join(target, "package.json"), packageJson),
    writeJson(path.join(target, "zenx.plugin.json"), manifest),
    writeFile(path.join(target, "README.md"), `# ${title(pluginId)}\n`, "utf8"),
    writeFile(
      path.join(target, "runtime.mjs"),
      runtimeSource(pluginId, toolName),
      "utf8",
    ),
  ]);
  process.stdout.write(`Created ${packageName} in ${target}\n`);
}

async function npmPack(directory: string): Promise<string> {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      ["pack", "--json"],
      { cwd: directory, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function option(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index < 0 ? undefined : arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

function validatePackageName(value: string): void {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value)) {
    throw new Error(`Invalid npm package name: ${value}`);
  }
}

function validatePluginId(value: string): void {
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(value)) {
    throw new Error(`Invalid ZenX plugin id: ${value}`);
  }
}

function title(value: string): string {
  return value
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runtimeSource(pluginId: string, toolName: string): string {
  return `import { runProcessPlugin } from "@zenx/plugin-sdk";

runProcessPlugin({
  pluginId: ${JSON.stringify(pluginId)},
  packageVersion: "0.1.0",
  tools: {
    ${JSON.stringify(toolName)}: async (input) => ({ output: JSON.stringify(input) }),
  },
});
`;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
