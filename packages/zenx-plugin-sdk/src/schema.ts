import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { ZenXPluginManifestV2 } from "./types.js";

export interface ValidatedPluginPackage {
  packageRoot: string;
  packageName: string;
  packageVersion: string;
  manifestPath: string;
  manifest: ZenXPluginManifestV2;
}

export async function validatePluginPackage(
  directory: string,
): Promise<ValidatedPluginPackage> {
  const packageRoot = await realpath(path.resolve(directory));
  const packageJson = parseJson(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
    "package.json",
  );
  assertRecord(packageJson, "package.json must be an object");
  const packageName = requireString(packageJson.name, "package.json#name");
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageName)
  ) {
    throw new Error("package.json#name is not a valid npm package name");
  }
  const packageVersion = requireString(
    packageJson.version,
    "package.json#version",
  );
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      packageVersion,
    )
  ) {
    throw new Error("package.json#version is not a stable semantic version");
  }
  if (!isRecord(packageJson.zenx)) {
    throw new Error("package.json#zenx must be an object");
  }
  const locator = requireString(
    packageJson.zenx.plugin,
    "package.json#zenx.plugin",
  );
  const manifestFile = await resolvePackageFile(
    packageRoot,
    locator,
    "manifest",
  );
  const manifest = validatePluginManifest(
    parseJson(await readFile(manifestFile, "utf8"), locator),
  );
  if (manifest.version !== packageVersion) {
    throw new Error(
      `Plugin manifest version ${manifest.version} does not match package version ${packageVersion}`,
    );
  }
  if (manifest.runtime.type !== "http") {
    await resolvePackageFile(
      packageRoot,
      manifest.runtime.entry,
      "runtime entry",
    );
  }
  return {
    packageRoot,
    packageName,
    packageVersion,
    manifestPath: packageRelative(packageRoot, manifestFile),
    manifest,
  };
}

export function validatePluginManifest(value: unknown): ZenXPluginManifestV2 {
  assertRecord(value, "Plugin manifest must be an object");
  if (value.schemaVersion !== 2)
    throw new Error("Plugin schemaVersion must be 2");
  const id = requireString(value.id, "Plugin id");
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(id))
    throw new Error(`Invalid plugin id: ${id}`);
  requireString(value.name, "Plugin name");
  requireString(value.version, "Plugin version");
  requireString(value.description, "Plugin description");
  requireString(value.mainDocument, "Plugin mainDocument");
  assertRecord(value.compatibility, "Plugin compatibility must be an object");
  if (value.compatibility.zenx !== ">=0.1.0 <0.2.0") {
    throw new Error(`Plugin ${id} is incompatible with ZenX Host SDK v1`);
  }
  validateRuntime(value.runtime, id);
  validateProvider(value.provider, id);
  const permissions = requireArray(value.permissions, "Plugin permissions");
  const permissionIds = new Set<string>();
  for (const permission of permissions) {
    assertRecord(permission, `Plugin ${id} permission must be an object`);
    const permissionId = requireString(permission.id, "permission id");
    if (permissionIds.has(permissionId))
      throw new Error(`Duplicate permission: ${permissionId}`);
    requireString(permission.title, `Permission ${permissionId} title`);
    requireString(
      permission.description,
      `Permission ${permissionId} description`,
    );
    if (
      !isOneOf(permission.scope, [
        "browser-session",
        "local-device",
        "workspace",
      ])
    ) {
      throw new Error(`Permission ${permissionId} has invalid scope`);
    }
    permissionIds.add(permissionId);
  }
  const tools = requireArray(value.tools, "Plugin tools");
  if (tools.length === 0) throw new Error(`Plugin ${id} declares no tools`);
  const toolNames = new Set<string>();
  const toolPrefix = `${id.replaceAll("-", "_")}_`;
  for (const tool of tools) {
    assertRecord(tool, `Plugin ${id} tool must be an object`);
    const name = requireString(tool.name, "Plugin tool name");
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(name) ||
      (!name.startsWith(toolPrefix) && !isHistoricalSelfControlTool(id, name))
    ) {
      throw new Error(
        `Plugin tool ${name} must be namespaced with ${toolPrefix}`,
      );
    }
    if (toolNames.has(name)) throw new Error(`Duplicate plugin tool: ${name}`);
    requireString(tool.description, `Plugin tool ${name} description`);
    if (!isRecord(tool.inputSchema))
      throw new Error(`Plugin tool ${name} has invalid input schema`);
    if (
      tool.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(tool.maxOutputBytes) ||
        Number(tool.maxOutputBytes) < 1024 ||
        Number(tool.maxOutputBytes) > 1024 * 1024)
    ) {
      throw new Error(
        `Plugin tool ${name} maxOutputBytes must be an integer between 1024 and 1048576`,
      );
    }
    if (
      !isOneOf(tool.interactionMode, [
        "background_safe",
        "foreground_required",
        "isolated",
      ])
    ) {
      throw new Error(`Plugin tool ${name} has invalid interaction mode`);
    }
    const capabilities = requireStringArray(
      tool.capabilities,
      `Plugin tool ${name} capabilities`,
    );
    if (capabilities.length === 0)
      throw new Error(`Plugin tool ${name} declares no capabilities`);
    for (const permissionId of requireStringArray(
      tool.permissions,
      `Plugin tool ${name} permissions`,
    )) {
      if (!permissionIds.has(permissionId))
        throw new Error(
          `Plugin tool ${name} requests unknown permission ${permissionId}`,
        );
    }
    toolNames.add(name);
  }
  for (const resource of requireArray(value.resources, "Plugin resources")) {
    assertRecord(resource, `Plugin ${id} resource must be an object`);
    requireString(resource.id, `Plugin ${id} resource id`);
    if (!isOneOf(resource.kind, ["skill", "prompt"]))
      throw new Error(`Plugin ${id} resource has invalid kind`);
    requireString(resource.title, `Plugin ${id} resource title`);
    requireString(resource.description, `Plugin ${id} resource description`);
    if (typeof resource.content !== "string")
      throw new Error(`Plugin ${id} resource content must be a string`);
  }
  if (value.settings !== undefined && !isRecord(value.settings))
    throw new Error(`Plugin ${id} settings must be an object`);
  if (
    value.storageVersion !== undefined &&
    (!Number.isSafeInteger(value.storageVersion) ||
      Number(value.storageVersion) < 1 ||
      Number(value.storageVersion) > 1000)
  ) {
    throw new Error(`Plugin ${id} has an invalid storage version`);
  }
  validateUi(value.ui, value.contributions, id, toolNames);
  return structuredClone(value) as unknown as ZenXPluginManifestV2;
}

const HISTORICAL_SELF_CONTROL_TOOLS = new Set([
  "zenx_projects_list",
  "zenx_threads_list",
  "zenx_threads_create",
  "zenx_threads_read",
  "zenx_threads_status",
  "zenx_threads_rename",
  "zenx_threads_archive",
  "zenx_threads_unarchive",
  "zenx_threads_send",
]);

function isHistoricalSelfControlTool(id: string, name: string): boolean {
  // Package-shape compatibility only. Host admission still restricts this
  // historical namespace to the exact bundled first-party identity/source.
  return id === "zenx-self-control" && HISTORICAL_SELF_CONTROL_TOOLS.has(name);
}

async function resolvePackageFile(
  root: string,
  locator: string,
  label: string,
): Promise<string> {
  if (
    locator.includes("\0") ||
    path.isAbsolute(locator) ||
    path.win32.isAbsolute(locator)
  ) {
    throw new Error(`Plugin ${label} must be a package-relative path`);
  }
  const requested = path.resolve(root, locator);
  if (!isInside(root, requested))
    throw new Error(`Plugin ${label} escapes the package directory`);
  let resolved: string;
  try {
    resolved = await realpath(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`Plugin ${label} does not exist: ${locator}`);
    throw error;
  }
  if (!isInside(root, resolved))
    throw new Error(`Plugin ${label} resolves outside the package directory`);
  if (!(await stat(resolved)).isFile())
    throw new Error(`Plugin ${label} is not a file: ${locator}`);
  return resolved;
}

function validateRuntime(value: unknown, id: string): void {
  assertRecord(value, `Plugin ${id} runtime must be an object`);
  if (value.type === "http") {
    const url = new URL(requireString(value.url, `Plugin ${id} runtime URL`));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`Plugin ${id} runtime URL must use HTTP(S)`);
  } else if (value.type === "process" || value.type === "bundled") {
    requireString(value.entry, `Plugin ${id} runtime entry`);
    if (value.type === "process" && value.args !== undefined)
      requireStringArray(value.args, `Plugin ${id} runtime args`);
  } else {
    throw new Error(`Plugin ${id} has invalid runtime type`);
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1)
  ) {
    throw new Error(`Plugin ${id} has invalid runtime timeout`);
  }
}

function validateProvider(value: unknown, id: string): void {
  assertRecord(value, `Plugin ${id} provider must be an object`);
  requireString(value.id, `Plugin ${id} provider id`);
  if (
    requireStringArray(value.platforms, `Plugin ${id} provider platforms`)
      .length === 0
  )
    throw new Error(`Plugin ${id} provider has no platforms`);
  const modes = requireStringArray(
    value.interactionModes,
    `Plugin ${id} provider interaction modes`,
  );
  if (
    modes.length === 0 ||
    modes.some(
      (mode) =>
        !isOneOf(mode, ["background_safe", "foreground_required", "isolated"]),
    )
  ) {
    throw new Error(`Plugin ${id} provider has invalid interaction modes`);
  }
  if (
    requireStringArray(value.capabilities, `Plugin ${id} provider capabilities`)
      .length === 0
  )
    throw new Error(`Plugin ${id} provider has no capabilities`);
}

function validateUi(
  ui: unknown,
  contributions: unknown,
  id: string,
  tools: ReadonlySet<string>,
): void {
  const surfaces = new Set<string>();
  if (ui !== undefined) {
    assertRecord(ui, `Plugin ${id} UI must be an object`);
    const bundleIds = new Set<string>();
    for (const bundle of requireArray(ui.bundles, `Plugin ${id} UI bundles`)) {
      assertRecord(bundle, `Plugin ${id} UI bundle must be an object`);
      const bundleId = requireIdentifier(bundle.id, "UI bundle id");
      if (
        bundleIds.has(bundleId) ||
        bundle.apiVersion !== 1 ||
        !isOneOf(bundle.kind, ["trusted", "isolated"])
      )
        throw new Error(
          `Plugin ${id} has invalid or duplicate UI bundle ${bundleId}`,
        );
      requireString(bundle.entry, `Plugin ${id} UI bundle entry`);
      bundleIds.add(bundleId);
    }
    for (const surface of requireArray(
      ui.surfaces,
      `Plugin ${id} UI surfaces`,
    )) {
      assertRecord(surface, `Plugin ${id} UI surface must be an object`);
      const surfaceId = requireIdentifier(surface.id, "UI surface id");
      if (
        surfaces.has(surfaceId) ||
        !bundleIds.has(
          requireIdentifier(surface.bundleId, "UI surface bundleId"),
        )
      )
        throw new Error(
          `Plugin ${id} has invalid or dangling UI surface ${surfaceId}`,
        );
      requireIdentifier(surface.exportName, "UI surface exportName");
      surfaces.add(surfaceId);
    }
  }
  if (contributions === undefined) return;
  assertRecord(contributions, `Plugin ${id} contributions must be an object`);
  const pageIds = new Set<string>();
  const routes = new Set<string>();
  for (const page of optionalArray(contributions.pages, `Plugin ${id} pages`)) {
    assertRecord(page, `Plugin ${id} page must be an object`);
    const pageId = requireIdentifier(page.id, "page id");
    const route = requireString(page.route, `Plugin ${id} page route`);
    if (
      pageIds.has(pageId) ||
      routes.has(route) ||
      !new RegExp(
        `^/plugins/${id}/[a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*)*$`,
        "u",
      ).test(route)
    )
      throw new Error(`Plugin ${id} has invalid page ${pageId}`);
    requireString(page.title, `Plugin ${id} page title`);
    if (
      page.surfaceId !== undefined &&
      !surfaces.has(requireIdentifier(page.surfaceId, "page surfaceId"))
    )
      throw new Error(`Plugin ${id} page ${pageId} targets unknown UI surface`);
    pageIds.add(pageId);
    routes.add(route);
  }
  const subrouteIds = new Set<string>();
  for (const subroute of optionalArray(
    contributions.subroutes,
    `Plugin ${id} subroutes`,
  )) {
    assertRecord(subroute, `Plugin ${id} subroute must be an object`);
    const subrouteId = requireIdentifier(subroute.id, "subroute id");
    const route = requireString(subroute.route, `Plugin ${id} subroute route`);
    if (
      subrouteIds.has(subrouteId) ||
      routes.has(route) ||
      !pageIds.has(requireIdentifier(subroute.pageId, "subroute pageId")) ||
      !surfaces.has(
        requireIdentifier(subroute.surfaceId, "subroute surfaceId"),
      ) ||
      !new RegExp(
        `^/plugins/${id}/[a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*)+$`,
        "u",
      ).test(route)
    ) {
      throw new Error(
        `Plugin ${id} has invalid or dangling subroute ${subrouteId}`,
      );
    }
    requireString(subroute.title, `Plugin ${id} subroute title`);
    subrouteIds.add(subrouteId);
    routes.add(route);
  }
  const sidebarIds = new Set<string>();
  const iconNames = [
    "clock",
    "layers",
    "plug",
    "settings",
    "terminal",
    "trigger",
    "users",
  ] as const;
  for (const sidebar of optionalArray(
    contributions.sidebar,
    `Plugin ${id} sidebar`,
  )) {
    assertRecord(sidebar, `Plugin ${id} sidebar item must be an object`);
    const sidebarId = requireIdentifier(sidebar.id, "sidebar id");
    if (
      sidebarIds.has(sidebarId) ||
      !pageIds.has(requireIdentifier(sidebar.pageId, "sidebar pageId")) ||
      !isOneOf(sidebar.icon, iconNames) ||
      (sidebar.order !== undefined && !Number.isSafeInteger(sidebar.order))
    )
      throw new Error(
        `Plugin ${id} has invalid sidebar contribution ${sidebarId}`,
      );
    requireString(sidebar.label, `Plugin ${id} sidebar label`);
    sidebarIds.add(sidebarId);
  }
  const commandIds = new Set<string>();
  for (const command of optionalArray(
    contributions.commands,
    `Plugin ${id} commands`,
  )) {
    assertRecord(command, `Plugin ${id} command must be an object`);
    const commandId = requireIdentifier(command.id, "command id");
    if (
      commandIds.has(commandId) ||
      !tools.has(requireString(command.tool, "command tool"))
    )
      throw new Error(
        `Plugin ${id} has invalid or dangling command ${commandId}`,
      );
    requireString(command.title, "command title");
    commandIds.add(commandId);
  }
  const menuIds = new Set<string>();
  for (const menu of optionalArray(contributions.menus, `Plugin ${id} menus`)) {
    assertRecord(menu, `Plugin ${id} menu must be an object`);
    const menuId = requireIdentifier(menu.id, "menu id");
    if (
      menuIds.has(menuId) ||
      !commandIds.has(requireIdentifier(menu.commandId, "menu commandId")) ||
      !isOneOf(menu.location, ["page", "panel", "settings"]) ||
      (menu.order !== undefined && !Number.isSafeInteger(menu.order))
    ) {
      throw new Error(`Plugin ${id} has invalid or dangling menu ${menuId}`);
    }
    requireString(menu.label, "menu label");
    menuIds.add(menuId);
  }
  for (const collection of ["settings", "panels"] as const) {
    const contributionIds = new Set<string>();
    for (const item of optionalArray(
      contributions[collection],
      `Plugin ${id} ${collection}`,
    )) {
      assertRecord(item, `Plugin ${id} ${collection} item must be an object`);
      const contributionId = requireIdentifier(item.id, `${collection} id`);
      if (
        contributionIds.has(contributionId) ||
        !surfaces.has(
          requireIdentifier(item.surfaceId, `${collection} surfaceId`),
        ) ||
        (item.order !== undefined && !Number.isSafeInteger(item.order))
      )
        throw new Error(`Plugin ${id} has dangling ${collection} contribution`);
      requireString(item.title, `Plugin ${id} ${collection} title`);
      contributionIds.add(contributionId);
    }
  }
  const rendererIds = new Set<string>();
  const contentTypes = new Set<string>();
  for (const renderer of optionalArray(
    contributions.resultRenderers,
    `Plugin ${id} result renderers`,
  )) {
    assertRecord(renderer, `Plugin ${id} result renderer must be an object`);
    const rendererId = requireIdentifier(renderer.id, "result renderer id");
    const contentType = requireString(
      renderer.contentType,
      "result renderer contentType",
    );
    if (
      rendererIds.has(rendererId) ||
      contentTypes.has(contentType) ||
      !contentType.startsWith(`${id}/`) ||
      !/^[a-z][a-z0-9-]{1,62}\/[a-z][a-z0-9.-]{0,127}$/u.test(contentType) ||
      !surfaces.has(
        requireIdentifier(renderer.surfaceId, "result renderer surfaceId"),
      )
    )
      throw new Error(`Plugin ${id} has invalid result renderer`);
    rendererIds.add(rendererId);
    contentTypes.add(contentType);
  }
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}
function assertRecord(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}
function requireIdentifier(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(result))
    throw new Error(`${label} is invalid`);
  return result;
}
function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
function optionalArray(value: unknown, label: string): unknown[] {
  return value === undefined ? [] : requireArray(value, label);
}
function requireStringArray(value: unknown, label: string): string[] {
  const array = requireArray(value, label);
  if (!array.every((item) => typeof item === "string" && item.length > 0))
    throw new Error(`${label} must contain strings`);
  return array as string[];
}
function isOneOf<T extends string>(
  value: unknown,
  options: readonly T[],
): value is T {
  return typeof value === "string" && options.includes(value as T);
}
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}
function packageRelative(root: string, filename: string): string {
  return path.relative(root, filename).split(path.sep).join("/");
}
