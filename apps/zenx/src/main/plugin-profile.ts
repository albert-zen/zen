import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validatePluginPackage } from "@zenx/plugin-sdk";

import type { ToolInvocation } from "../../../../src/tool.js";
import type { ZenXPluginHostSdkV1 } from "./plugin-host-sdk.js";
import { ProcessPluginRuntime } from "./plugin-runtime.js";
import type {
  ZenXCapabilityPackage,
  ZenXPluginPackageSource,
  ZenXPluginProfileSource,
  ZenXPluginManifestV2,
} from "./capabilities/types.js";

export const BUNDLED_PNPM_VERSION = "10.34.0";
const MAX_PNPM_OUTPUT_BYTES = 1024 * 1024;
const MAX_UI_BUNDLE_BYTES = 1024 * 1024;

export interface ZenXPluginProfilePaths {
  root: string;
  generations: string;
  store: string;
}

export interface StagedProfilePlugin {
  generation: string;
  generationDirectory: string;
  packageName: string;
  source: ZenXPluginProfileSource;
  capabilityPackage: ZenXCapabilityPackage;
}

export interface StagedProfileRemoval {
  generation: string;
  generationDirectory: string;
}

export interface ZenXTrustedProfilePluginRuntime {
  readonly storage?: ZenXCapabilityPackage["storage"];
  start?(sdk: ZenXPluginHostSdkV1): Promise<void> | void;
  invoke(
    toolName: string,
    invocation: Omit<ToolInvocation, "name">,
  ): Promise<unknown>;
  close?(): Promise<void> | void;
}

export type ZenXTrustedProfilePluginLoader = (
  module: Readonly<Record<string, unknown>>,
) => ZenXTrustedProfilePluginRuntime;

export function pluginProfilePaths(
  userDataDirectory: string,
): ZenXPluginProfilePaths {
  const root = path.join(userDataDirectory, "plugin-profile");
  return {
    root,
    generations: path.join(root, "generations"),
    store: path.join(root, "pnpm-store"),
  };
}

export async function resolveBundledPnpmCli(options: {
  resourcesDirectory?: string;
  overridePath?: string;
}): Promise<string> {
  const requested =
    options.overridePath ??
    (options.resourcesDirectory === undefined
      ? undefined
      : path.join(options.resourcesDirectory, "pnpm", "bin", "pnpm.cjs"));
  if (requested === undefined) {
    throw new Error("ZenX bundled pnpm resource directory is not configured");
  }
  const cli = await realpath(path.resolve(requested));
  const packageFile = path.join(
    path.dirname(path.dirname(cli)),
    "package.json",
  );
  const packageManifest = JSON.parse(await readFile(packageFile, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    packageManifest.name !== "pnpm" ||
    packageManifest.version !== BUNDLED_PNPM_VERSION
  ) {
    throw new Error(
      `ZenX requires bundled pnpm ${BUNDLED_PNPM_VERSION}; found ${String(packageManifest.version)}`,
    );
  }
  return cli;
}

export async function stagePluginTarball(options: {
  userDataDirectory: string;
  tarballPath: string;
  pnpmCliPath: string;
  pnpmEnvironment?: NodeJS.ProcessEnv;
  currentGeneration?: string;
  allowBuilds?: Readonly<Record<string, boolean>>;
  removeGeneration?: (directory: string) => Promise<void>;
}): Promise<StagedProfilePlugin> {
  return await stagePluginPackage({
    ...options,
    source: { mode: "tarball", packageSpec: options.tarballPath },
  });
}

/** The single bundled-pnpm generation transaction for every package source. */
export async function stagePluginPackage(options: {
  userDataDirectory: string;
  source: ZenXPluginPackageSource;
  pnpmCliPath: string;
  pnpmEnvironment?: NodeJS.ProcessEnv;
  currentGeneration?: string;
  expectedPackageName?: string;
  allowBuilds?: Readonly<Record<string, boolean>>;
  removeGeneration?: (directory: string) => Promise<void>;
  trustedLoaders?: Readonly<Record<string, ZenXTrustedProfilePluginLoader>>;
}): Promise<StagedProfilePlugin> {
  const paths = pluginProfilePaths(options.userDataDirectory);
  const generation = randomUUID();
  const generationDirectory = path.join(paths.generations, generation);
  await mkdir(paths.generations, { recursive: true, mode: 0o700 });
  try {
    if (options.currentGeneration === undefined) {
      await mkdir(generationDirectory, { mode: 0o700 });
      await writeProfilePackageJson(
        generationDirectory,
        {},
        options.allowBuilds ?? {},
      );
    } else {
      const current = generationPath(paths, options.currentGeneration);
      await cp(current, generationDirectory, { recursive: true });
      const currentPackage = await readProfilePackageJson(generationDirectory);
      await writeProfilePackageJson(
        generationDirectory,
        currentPackage.dependencies,
        options.allowBuilds ?? currentPackage.pnpm?.allowBuilds ?? {},
      );
    }

    const before = (await readProfilePackageJson(generationDirectory))
      .dependencies;
    const installSpec = await prepareInstallSpec(
      options.source,
      generationDirectory,
    );
    const pnpmArguments =
      options.source.mode === "npm" &&
      options.expectedPackageName !== undefined &&
      (options.source.packageSpec === options.expectedPackageName ||
        options.source.packageSpec === `${options.expectedPackageName}@latest`)
        ? ["update", "--latest", options.expectedPackageName]
        : ["add", "--save-exact", installSpec];
    await runBundledPnpm({
      cliPath: options.pnpmCliPath,
      cwd: generationDirectory,
      environment: options.pnpmEnvironment,
      arguments: [
        ...pnpmArguments,
        "--ignore-workspace",
        "--store-dir",
        paths.store,
      ],
    });
    const profile = await readProfilePackageJson(generationDirectory);
    const changed = Object.keys(profile.dependencies).filter(
      (packageName) =>
        before[packageName] !== profile.dependencies[packageName],
    );
    const packageName = options.expectedPackageName ?? changed[0];
    if (
      packageName === undefined ||
      profile.dependencies[packageName] === undefined ||
      (options.expectedPackageName === undefined && changed.length !== 1)
    ) {
      throw new Error(
        "Plugin package mutation must resolve exactly one direct profile dependency",
      );
    }
    const capabilityPackage = await loadProfilePluginPackage(
      generationDirectory,
      packageName,
      {
        allowExternalLink: options.source.mode === "dev-link",
        sourceMode: options.source.mode,
        trustedLoaders: options.trustedLoaders,
      },
    );
    const packageVersion = capabilityPackage.manifest.version;
    return {
      generation,
      generationDirectory,
      packageName,
      source: {
        ...options.source,
        packageSpec: canonicalSourceSpec(options.source),
        resolvedSpec: profile.dependencies[packageName]!,
        packageName,
        packageVersion,
      },
      capabilityPackage,
    };
  } catch (error) {
    await discardStagedProfileGeneration(
      generationDirectory,
      options.removeGeneration,
    );
    throw error;
  }
}

export async function stagePluginRemoval(options: {
  userDataDirectory: string;
  packageName: string;
  pnpmCliPath: string;
  pnpmEnvironment?: NodeJS.ProcessEnv;
  currentGeneration: string;
  removeGeneration?: (directory: string) => Promise<void>;
}): Promise<StagedProfileRemoval> {
  const paths = pluginProfilePaths(options.userDataDirectory);
  const generation = randomUUID();
  const generationDirectory = path.join(paths.generations, generation);
  await mkdir(paths.generations, { recursive: true, mode: 0o700 });
  try {
    await cp(
      generationPath(paths, options.currentGeneration),
      generationDirectory,
      { recursive: true },
    );
    const before = await readProfilePackageJson(generationDirectory);
    if (before.dependencies[options.packageName] === undefined) {
      throw new Error(
        `Profile dependency ${options.packageName} is not installed`,
      );
    }
    await runBundledPnpm({
      cliPath: options.pnpmCliPath,
      cwd: generationDirectory,
      environment: options.pnpmEnvironment,
      arguments: [
        "remove",
        "--ignore-workspace",
        "--store-dir",
        paths.store,
        options.packageName,
      ],
    });
    const after = await readProfilePackageJson(generationDirectory);
    if (after.dependencies[options.packageName] !== undefined) {
      throw new Error(
        `Profile dependency ${options.packageName} was not removed`,
      );
    }
    return { generation, generationDirectory };
  } catch (error) {
    await discardStagedProfileGeneration(
      generationDirectory,
      options.removeGeneration,
    );
    throw error;
  }
}

export async function loadProfilePluginPackage(
  generationDirectory: string,
  packageName: string,
  options: {
    allowExternalLink?: boolean;
    sourceMode?: ZenXPluginPackageSource["mode"];
    trustedLoaders?: Readonly<Record<string, ZenXTrustedProfilePluginLoader>>;
  } = {},
): Promise<ZenXCapabilityPackage> {
  const generationRoot = await realpath(generationDirectory);
  const packagePath = path.join(
    generationRoot,
    "node_modules",
    ...packageName.split("/"),
  );
  const packageRoot = options.allowExternalLink
    ? await realpath(packagePath)
    : await containedRealpath(
        generationRoot,
        packagePath,
        `Profile dependency ${packageName}`,
      );
  const validated = await validatePluginPackage(packageRoot);
  if (validated.packageName !== packageName) {
    throw new Error(
      `Profile dependency ${packageName} has invalid package metadata`,
    );
  }
  const manifest = structuredClone(
    validated.manifest,
  ) as unknown as ZenXPluginManifestV2;
  if (
    manifest.runtime?.type !== "process" &&
    manifest.runtime?.type !== "bundled"
  ) {
    throw new Error(
      `Profile plugin ${packageName} runtime must be process-backed or an admitted bundled runtime`,
    );
  }
  const runtimeEntry = await containedRealpath(
    packageRoot,
    path.resolve(packageRoot, manifest.runtime.entry),
    `Plugin runtime for ${packageName}`,
  );
  const bundles = (manifest.ui?.bundles ?? []).map((bundle) => {
    if (
      bundle.kind !== "isolated" &&
      !(
        bundle.kind === "trusted" &&
        manifest.runtime.type === "bundled" &&
        options.sourceMode === "bundled" &&
        options.trustedLoaders?.[manifest.id] !== undefined
      )
    ) {
      throw new Error(
        `Profile plugin ${packageName} UI must use the isolated host`,
      );
    }
    if (Buffer.byteLength(bundle.entry, "utf8") > MAX_UI_BUNDLE_BYTES) {
      throw new Error(`Plugin UI bundle ${bundle.id} exceeded 1 MiB`);
    }
    return bundle;
  });
  if (manifest.ui !== undefined) manifest.ui = { ...manifest.ui, bundles };
  if (manifest.runtime.type === "process") {
    return new ProfileProcessPluginPackage(manifest, packageRoot, runtimeEntry);
  }
  const trustedLoader = options.trustedLoaders?.[manifest.id];
  if (options.sourceMode !== "bundled" || trustedLoader === undefined) {
    throw new Error(
      `Profile plugin ${packageName} bundled runtime is not admitted by App Resources`,
    );
  }
  const module = (await import(
    `${pathToFileURL(runtimeEntry).href}?generation=${encodeURIComponent(path.basename(generationDirectory))}`
  )) as Readonly<Record<string, unknown>>;
  return new ProfileTrustedPluginPackage(manifest, trustedLoader(module));
}

async function prepareInstallSpec(
  source: ZenXPluginPackageSource,
  generationDirectory: string,
): Promise<string> {
  const packageSpec = source.packageSpec.trim();
  if (packageSpec.length === 0) throw new Error("Plugin package spec is empty");
  if (source.mode === "git") {
    if (!/#(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(packageSpec)) {
      throw new Error("Git plugin package spec must pin an exact commit");
    }
    return packageSpec;
  }
  if (source.mode === "tarball" || source.mode === "bundled") {
    return await realpath(path.resolve(packageSpec));
  }
  if (source.mode === "local-copy" || source.mode === "dev-link") {
    const requested = packageSpec.startsWith("link:")
      ? packageSpec.slice("link:".length)
      : packageSpec.startsWith("file:")
        ? packageSpec.slice("file:".length)
        : packageSpec;
    const sourceDirectory = await realpath(path.resolve(requested));
    if (source.mode === "dev-link") return `link:${sourceDirectory}`;
    const snapshot = path.join(
      generationDirectory,
      ".zenx-sources",
      randomUUID(),
    );
    await mkdir(path.dirname(snapshot), { recursive: true, mode: 0o700 });
    await cp(sourceDirectory, snapshot, { recursive: true });
    return `file:${snapshot}`;
  }
  if (
    packageSpec.startsWith("file:") ||
    packageSpec.startsWith("link:") ||
    packageSpec.startsWith("git")
  ) {
    throw new Error(`npm plugin package spec is invalid: ${packageSpec}`);
  }
  return packageSpec;
}

function canonicalSourceSpec(source: ZenXPluginPackageSource): string {
  const packageSpec = source.packageSpec.trim();
  if (source.mode !== "dev-link") return packageSpec;
  return packageSpec.startsWith("link:") ? packageSpec : `link:${packageSpec}`;
}

export async function cleanupUnreferencedProfileGenerations(options: {
  userDataDirectory: string;
  committedGeneration?: string;
  removeGeneration?: (directory: string) => Promise<void>;
}): Promise<void> {
  const paths = pluginProfilePaths(options.userDataDirectory);
  let entries;
  try {
    entries = await readdir(paths.generations, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const removeGeneration =
    options.removeGeneration ??
    (async (directory: string) =>
      await rm(directory, { recursive: true, force: true }));
  await Promise.allSettled(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name !== options.committedGeneration,
      )
      .map(
        async (entry) =>
          await removeGeneration(path.join(paths.generations, entry.name)),
      ),
  );
}

export async function discardStagedProfileGeneration(
  generationDirectory: string,
  removeGeneration?: (directory: string) => Promise<void>,
): Promise<void> {
  try {
    await (
      removeGeneration ??
      (async (directory: string) =>
        await rm(directory, { recursive: true, force: true }))
    )(generationDirectory);
  } catch {
    // Unreferenced staging is disk garbage and never changes published state.
  }
}

class ProfileProcessPluginPackage implements ZenXCapabilityPackage {
  readonly manifest: ZenXPluginManifestV2;
  readonly #packageRoot: string;
  readonly #runtimeEntry: string;
  #runtime: ProcessPluginRuntime | undefined;

  constructor(
    manifest: ZenXPluginManifestV2,
    packageRoot: string,
    runtimeEntry: string,
  ) {
    this.manifest = manifest;
    this.#packageRoot = packageRoot;
    this.#runtimeEntry = runtimeEntry;
  }

  async start(hostSdk: ZenXPluginHostSdkV1): Promise<void> {
    if (this.#runtime !== undefined) {
      throw new Error(`Plugin runtime is already started: ${this.manifest.id}`);
    }
    const runtime = this.manifest.runtime;
    if (runtime.type !== "process") {
      throw new Error(
        `Plugin runtime is not process-backed: ${this.manifest.id}`,
      );
    }
    this.#runtime = await ProcessPluginRuntime.start(
      { pluginId: this.manifest.id, packageVersion: this.manifest.version },
      {
        command: process.execPath,
        args: [this.#runtimeEntry, ...(runtime.args ?? [])],
        cwd: this.#packageRoot,
        environment: {
          ...minimalEnvironment(process.env),
          ELECTRON_RUN_AS_NODE: "1",
        },
        startTimeoutMs: runtime.timeoutMs,
        requestTimeoutMs: runtime.timeoutMs,
        hostSdk,
      },
    );
  }

  async invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    const runtime = this.#runtime;
    if (runtime === undefined) {
      throw new Error(`Plugin runtime is not started: ${this.manifest.id}`);
    }
    return await runtime.invoke({
      invocationId: invocation.callId,
      tool: toolName,
      arguments: invocation.arguments,
      context: { callId: invocation.callId, cwd: invocation.cwd },
      signal: invocation.signal,
    });
  }

  async close(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    await runtime?.close();
  }
}

class ProfileTrustedPluginPackage implements ZenXCapabilityPackage {
  readonly manifest: ZenXPluginManifestV2;
  readonly storage?: ZenXCapabilityPackage["storage"];
  readonly #runtime: ZenXTrustedProfilePluginRuntime;

  constructor(
    manifest: ZenXPluginManifestV2,
    runtime: ZenXTrustedProfilePluginRuntime,
  ) {
    this.manifest = manifest;
    this.#runtime = runtime;
    if (runtime.storage !== undefined) this.storage = runtime.storage;
  }

  async start(hostSdk: ZenXPluginHostSdkV1): Promise<void> {
    await this.#runtime.start?.(hostSdk);
  }

  async invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    return await this.#runtime.invoke(toolName, {
      callId: invocation.callId,
      arguments: invocation.arguments,
      cwd: invocation.cwd,
      signal: invocation.signal,
    });
  }

  async close(): Promise<void> {
    await this.#runtime.close?.();
  }
}

async function writeProfilePackageJson(
  directory: string,
  dependencies: Readonly<Record<string, string>>,
  allowBuilds: Readonly<Record<string, boolean>>,
): Promise<void> {
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "zenx-plugin-profile",
        private: true,
        version: "0.0.0",
        packageManager: `pnpm@${BUNDLED_PNPM_VERSION}`,
        dependencies,
        pnpm: { allowBuilds },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function readProfilePackageJson(directory: string): Promise<{
  dependencies: Record<string, string>;
  pnpm?: { allowBuilds?: Record<string, boolean> };
}> {
  const parsed = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  ) as unknown;
  if (
    !isRecord(parsed) ||
    (parsed.dependencies !== undefined && !isStringRecord(parsed.dependencies))
  ) {
    throw new Error("ZenX plugin profile package.json is invalid");
  }
  const pnpm = isRecord(parsed.pnpm) ? parsed.pnpm : undefined;
  return {
    dependencies:
      parsed.dependencies === undefined ? {} : { ...parsed.dependencies },
    ...(pnpm !== undefined && isBooleanRecord(pnpm.allowBuilds)
      ? { pnpm: { allowBuilds: { ...pnpm.allowBuilds } } }
      : {}),
  };
}

async function containedRealpath(
  root: string,
  requested: string,
  label: string,
): Promise<string> {
  await access(requested);
  const resolved = await realpath(requested);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes its package generation`);
  }
  return resolved;
}

function generationPath(
  paths: ZenXPluginProfilePaths,
  generation: string,
): string {
  if (!/^[0-9a-f-]{36}$/u.test(generation)) {
    throw new Error(`Invalid plugin profile generation: ${generation}`);
  }
  return path.join(paths.generations, generation);
}

async function runBundledPnpm(options: {
  cliPath: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  arguments: readonly string[];
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [options.cliPath, ...options.arguments],
      {
        cwd: options.cwd,
        env: {
          ...(options.environment ?? process.env),
          ELECTRON_RUN_AS_NODE: "1",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [];
    let bytes = 0;
    const append = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_PNPM_OUTPUT_BYTES) output.push(chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `Bundled pnpm failed (${signal ?? String(code)}): ${Buffer.concat(output).toString("utf8").slice(0, 4096)}`,
          ),
        );
      }
    });
  });
}

function minimalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "LANG", "PATH", "SHELL", "TMPDIR"]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}
