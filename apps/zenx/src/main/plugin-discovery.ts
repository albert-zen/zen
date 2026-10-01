import type { CanonicalItem } from "../../../../src/item.js";
import type { ModelTool } from "../../../../src/model.js";
import type {
  ToolExecutionResult,
  ToolInvocation,
  ToolRuntime,
} from "../../../../src/tool.js";
import { ToolEnvironment } from "../../../../src/tool.js";
import type { ZenXAvailablePlugin } from "./capabilities/types.js";

export const ZENX_PLUGIN_TOOL = "zenx_plugin";

export type AvailablePlugin = ZenXAvailablePlugin;

/** Current Host-owned catalog view; lifecycle state stays outside the Thread. */
export interface PluginDiscoveryCatalog {
  availablePlugins(): readonly AvailablePlugin[];
}

/** Persistent meta-tool whose ordinary result is the durable disclosure fact. */
export class PluginDiscoveryToolRuntime implements ToolRuntime {
  readonly name = ZENX_PLUGIN_TOOL;
  readonly specification: ModelTool = {
    name: this.name,
    description:
      "Discover available ZenX plugins or read one plugin's main document and tool index.",
    inputSchema: {
      oneOf: [
        {
          type: "object",
          properties: { operation: { const: "discover" } },
          required: ["operation"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            operation: { const: "read" },
            pluginId: { type: "string" },
          },
          required: ["operation", "pluginId"],
          additionalProperties: false,
        },
      ],
    },
  };
  readonly #catalog: PluginDiscoveryCatalog;
  readonly #environment: ToolEnvironment;

  constructor(catalog: PluginDiscoveryCatalog, environment: ToolEnvironment) {
    this.#catalog = catalog;
    this.#environment = environment;
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    if (invocation.name !== ZENX_PLUGIN_TOOL) {
      throw new Error(`Unsupported tool: ${invocation.name}`);
    }
    invocation.signal.throwIfAborted();
    const plugins = currentAvailablePlugins(this.#catalog, this.#environment)
      .map(cloneAvailablePlugin)
      .sort((left, right) => left.id.localeCompare(right.id));
    const operation = readOperation(invocation.arguments);
    if (operation === "discover") {
      return {
        output: JSON.stringify({
          operation,
          plugins: plugins.map(summaryFromPlugin),
        }),
        exitCode: 0,
      };
    }
    const pluginId = readPluginId(invocation.arguments);
    const plugin = plugins.find((candidate) => candidate.id === pluginId);
    if (plugin === undefined) {
      throw new Error(`ZenX plugin is not available: ${pluginId}`);
    }
    invocation.signal.throwIfAborted();
    return {
      output: JSON.stringify({
        operation,
        plugin: {
          ...summaryFromPlugin(plugin),
          mainDocument: plugin.mainDocument,
          tools: plugin.tools.map(({ name, description }) => ({
            name,
            description,
          })),
        },
      }),
      exitCode: 0,
    };
  }
}

/**
 * Request-time schema projection. Disclosure comes only from canonical history,
 * while the current catalog and Tool Environment gate what remains callable.
 */
export class PluginDiscoveryProjection {
  readonly #environment: ToolEnvironment;
  readonly #catalog: PluginDiscoveryCatalog;

  constructor(environment: ToolEnvironment, catalog: PluginDiscoveryCatalog) {
    this.#environment = environment;
    this.#catalog = catalog;
  }

  definitions(items: readonly CanonicalItem[]): ModelTool[] {
    const disclosed = disclosedPluginIds(items);
    const entries = this.#environment.definitionEntries;
    const byName = new Map(
      entries.map((entry) => [entry.definition.name, entry.definition]),
    );
    const currentPlugins = currentAvailablePlugins(
      this.#catalog,
      this.#environment,
    );
    const allPluginTools = new Set(
      currentPlugins.flatMap((plugin) => plugin.tools.map((tool) => tool.name)),
    );
    const baseTools = entries
      .filter(
        (entry) =>
          entry.owner.kind === "builtin" ||
          (entry.owner.kind === "external" &&
            !allPluginTools.has(entry.definition.name)),
      )
      .map((entry) => structuredClone(entry.definition));
    const pluginTools = currentPlugins
      .filter((plugin) => disclosed.has(plugin.id))
      .flatMap((plugin) =>
        plugin.tools.flatMap((tool) => {
          const definition = byName.get(tool.name);
          return definition === undefined ? [] : [structuredClone(definition)];
        }),
      );
    return [...baseTools, ...pluginTools];
  }
}

function currentAvailablePlugins(
  catalog: PluginDiscoveryCatalog,
  environment: ToolEnvironment,
): readonly AvailablePlugin[] {
  const registeredNames = new Set(
    environment.definitionEntries.map((entry) => entry.definition.name),
  );
  return catalog
    .availablePlugins()
    .filter(
      (plugin) =>
        plugin.tools.length > 0 &&
        plugin.tools.every((tool) => registeredNames.has(tool.name)),
    );
}

export function disclosedPluginIds(
  items: readonly CanonicalItem[],
): ReadonlySet<string> {
  const pending = new Map<string, string>();
  const disclosed = new Set<string>();
  for (const item of items) {
    if (item.type === "tool_call") {
      pending.delete(item.callId);
      if (item.name !== ZENX_PLUGIN_TOOL) continue;
      const pluginId = validReadArguments(item.arguments);
      if (pluginId !== undefined) pending.set(item.callId, pluginId);
      continue;
    }
    if (item.type !== "tool_result") continue;
    const pluginId = pending.get(item.callId);
    pending.delete(item.callId);
    if (
      pluginId !== undefined &&
      item.exitCode === 0 &&
      isSuccessfulReadResult(item.output, pluginId)
    ) {
      disclosed.add(pluginId);
    }
  }
  return disclosed;
}

function validReadArguments(
  arguments_: Record<string, unknown>,
): string | undefined {
  if (
    Object.keys(arguments_).length !== 2 ||
    arguments_.operation !== "read" ||
    typeof arguments_.pluginId !== "string" ||
    arguments_.pluginId.length === 0
  ) {
    return undefined;
  }
  return arguments_.pluginId;
}

function isSuccessfulReadResult(output: string, pluginId: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(value) || value.operation !== "read") return false;
  const plugin = value.plugin;
  if (
    !isRecord(plugin) ||
    plugin.id !== pluginId ||
    typeof plugin.name !== "string" ||
    typeof plugin.description !== "string" ||
    plugin.status !== "enabled" ||
    typeof plugin.mainDocument !== "string" ||
    !Array.isArray(plugin.tools)
  ) {
    return false;
  }
  return plugin.tools.every(
    (tool) =>
      isRecord(tool) &&
      typeof tool.name === "string" &&
      typeof tool.description === "string",
  );
}

function readOperation(
  arguments_: Record<string, unknown>,
): "discover" | "read" {
  if (
    arguments_.operation === "discover" &&
    Object.keys(arguments_).length === 1
  ) {
    return "discover";
  }
  if (validReadArguments(arguments_) !== undefined) return "read";
  throw new Error("zenx_plugin arguments must select discover or read");
}

function readPluginId(arguments_: Record<string, unknown>): string {
  const pluginId = validReadArguments(arguments_);
  if (pluginId === undefined) {
    throw new Error("zenx_plugin.read requires a pluginId");
  }
  return pluginId;
}

function summaryFromPlugin(plugin: AvailablePlugin) {
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    status: plugin.status,
  };
}

function cloneAvailablePlugin(plugin: AvailablePlugin): AvailablePlugin {
  return {
    ...plugin,
    tools: plugin.tools.map((tool) => structuredClone(tool)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
