import { createModelDiagnosticWriter } from "./model-diagnostics.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";

import {
  FileAttachmentStore,
  type AttachmentStore,
} from "../../../src/attachment.js";
import { ApplyPatchToolRuntime } from "../../../src/apply-patch.js";
import { ZenAppServer } from "../../../src/app-server.js";
import {
  CodeRuntime,
  RunCodeToolRuntime,
  type CodeRuntimeLimits,
} from "../../../src/code-runtime.js";
import type { ContextCompactionConfig } from "../../../src/context-compaction.js";
import {
  JsonlThreadJournal,
  type ThreadJournal,
} from "../../../src/journal.js";
import {
  StaticModelCatalog,
  type ModelCatalogEntryInput,
} from "../../../src/model-catalog.js";
import { FakeModel, type ModelAdapter } from "../../../src/model.js";
import { OpenAiCompatibleModel } from "../../../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../../../src/model/openai-subscription.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import {
  AgentRuntime,
  type ToolDefinitionProjection,
} from "../../../src/runtime.js";
import {
  JsonlThreadMetadataStore,
  type ThreadMetadataStore,
} from "../../../src/thread-metadata.js";
import {
  JsonThreadSummaryProjection,
  type ThreadSummaryProjection,
} from "../../../src/thread-summary.js";
import { ShellToolRuntime, ToolEnvironment } from "../../../src/tool.js";
import {
  ToolOutputSpool,
  type ToolOutputSpoolOptions,
} from "../../../src/tool-output-spool.js";
import type { ToolPresentation } from "../../../src/tool-presentation.js";
import { ViewImageToolRuntime } from "../../../src/view-image.js";
import { OpenAiSubscriptionAuthProfile } from "./subscription-auth.js";
import { legacyModelCatalogEntries } from "./model-presets.js";

export type HostProvider =
  | { type: "fake" }
  | {
      type: "openai-subscription";
      profilePath: string;
    }
  | {
      type: "openai-compatible";
      baseUrl: string;
      apiKey: string;
      name?: string;
      defaultParams?: Readonly<Record<string, unknown>>;
    };

export interface HostProviderProfile {
  providerProfileId: string;
  provider: HostProvider;
  model: string;
  modelCatalog?: readonly ModelCatalogEntryInput[];
  /** Compatibility input for existing string-only host callers. */
  models?: readonly string[];
  transport?: ProviderTransport;
}

export interface HostModelSelection {
  providerProfileId: string;
  modelId: string;
}

export interface ZenHostOptions {
  cwd: string;
  dataDirectory: string;
  /** Durable configuration revision already committed before Host startup. */
  configurationRevision?: number;
  /** Compatibility input for existing single-provider CLI callers. */
  model?: string;
  modelCatalog?: readonly ModelCatalogEntryInput[];
  models?: readonly string[];
  approvalPolicy: "always" | "never";
  /** Compatibility input for existing single-provider CLI callers. */
  provider?: HostProvider;
  transport?: ProviderTransport;
  providers?: readonly HostProviderProfile[];
  defaultSelection?: HostModelSelection;
  secretEnvironmentVariables?: readonly string[];
  journal?: ThreadJournal;
  threadMetadata?: ThreadMetadataStore;
  threadSummaryProjection?: ThreadSummaryProjection;
  toolEnvironment?: ToolEnvironment;
  toolDefinitionProjection?: ToolDefinitionProjection;
  /** Omit to allow the model to use as many tool rounds as the Turn needs. */
  maxToolRounds?: number;
  /** Host-owned model-facing tool entry points; defaults to both. */
  toolPresentation?: ToolPresentation;
  /** Host-owned containment limits and exact packaged Worker entry. */
  codeRuntimeOptions?: Partial<CodeRuntimeLimits> & { workerUrl?: URL };
  /** Host-owned tool body limit shared by direct and nested calls. */
  maxConcurrentToolBodies?: number;
  /** Product warning sink used when both degrades to direct. */
  onToolPresentationWarning?: (warning: string) => void;
  /** Host-owned context compaction behavior; omitted fields use Core defaults. */
  contextCompaction?: ContextCompactionConfig;
  attachments?: AttachmentStore;
  /** Host-local owner injection, primarily for composition and lifecycle tests. */
  toolOutputSpool?: ToolOutputSpool;
  toolOutputSpoolOptions?: ToolOutputSpoolOptions;
}

export interface ProviderTransport {
  proxyUrl: string;
}

export type ProviderFetch = typeof globalThis.fetch & {
  close?(): Promise<void>;
};

export type HostedZenAppServer = ZenAppServer & {
  readonly processEpoch: string;
  prepareConfiguration(
    options: ZenHostOptions,
    revision: number,
    candidateToken?: string,
  ): Promise<HostConfigurationCandidate>;
  publishConfiguration(
    candidate: HostConfigurationCandidate,
  ): HostConfigurationCurrent;
  discardConfiguration(candidate: HostConfigurationCandidate): Promise<void>;
  currentConfiguration(): HostConfigurationCurrent;
  closeProviderTransport(): Promise<void>;
  closeHostResources(): Promise<void>;
};

export interface HostConfigurationCandidate {
  processEpoch: string;
  candidateToken: string;
  revision: number;
  pendingRestart: string[];
}

export interface HostConfigurationCurrent {
  processEpoch: string;
  revision: number;
  pendingRestart: string[];
}

export function createHostedAppServer(
  options: ZenHostOptions,
): HostedZenAppServer {
  const reservedTool = options.toolEnvironment?.definitions.find(
    (definition) =>
      definition.name === "apply_patch" || definition.name === "view_image",
  );
  if (reservedTool !== undefined) {
    throw new Error(
      `Tool name ${reservedTool.name} is reserved for the builtin runtime`,
    );
  }
  const attachments =
    options.attachments ??
    new FileAttachmentStore(path.join(options.dataDirectory, "attachments"));
  const journal =
    options.journal ??
    new JsonlThreadJournal(path.join(options.dataDirectory, "threads"));
  const normalizedProfiles = normalizePreparedProviderProfiles(
    options,
    attachments,
  );
  const providerPreparation = createProviderProfiles(
    normalizedProfiles,
    attachments,
    createModelDiagnosticWriter(
      path.join(options.dataDirectory, "diagnostics"),
    ),
  );
  const preparedProfiles = providerPreparation.profiles;
  const defaultSelection = normalizeDefaultSelection(options, preparedProfiles);
  const configuredDefault = preparedProfiles
    .find(
      (profile) =>
        profile.providerProfileId === defaultSelection.providerProfileId,
    )
    ?.catalog.get(defaultSelection.modelId);
  if (configuredDefault === undefined) {
    throw new Error(
      `Default model ${defaultSelection.modelId} is absent from provider profile ${defaultSelection.providerProfileId}`,
    );
  }
  const requestedPresentation = options.toolPresentation ?? "both";
  const codeRuntime = prepareCodeRuntime({
    existingDefinitions: options.toolEnvironment?.definitions ?? [],
    requestedPresentation,
    codeRuntimeOptions: options.codeRuntimeOptions,
    warning: options.onToolPresentationWarning,
  });
  const toolOutputSpool =
    options.toolOutputSpool ??
    new ToolOutputSpool(options.toolOutputSpoolOptions);
  const shellRuntime =
    options.toolEnvironment === undefined
      ? new ShellToolRuntime({
          blockedEnvironmentVariables: options.secretEnvironmentVariables ?? [],
          toolOutputSpool,
        })
      : undefined;
  const toolEnvironment =
    options.toolEnvironment ??
    new ToolEnvironment({
      runtimes: [shellRuntime!],
      toolOutputSpool,
      ...(options.maxConcurrentToolBodies === undefined
        ? {}
        : {
            taskOptions: { maxRunningTasks: options.maxConcurrentToolBodies },
          }),
    });
  toolEnvironment.registerRuntime(new ApplyPatchToolRuntime(), {
    kind: "builtin",
    id: "apply-patch",
  });
  toolEnvironment.registerRuntime(
    new ViewImageToolRuntime({ attachments, journal }),
    { kind: "builtin", id: "view-image" },
  );
  if (codeRuntime.runtime !== undefined) {
    toolEnvironment.registerRuntime(codeRuntime.runtime, {
      kind: "builtin",
      id: "run-code",
    });
  }
  const profiles = preparedProfiles.map((profile) => profile.registryProfile);
  const appServer = new ZenAppServer({
    journal,
    attachments,
    runtime: new AgentRuntime({
      toolEnvironment,
      toolPresentation: codeRuntime.presentation,
      ...(options.toolDefinitionProjection === undefined
        ? {}
        : { toolDefinitionProjection: options.toolDefinitionProjection }),
      ...(options.maxToolRounds === undefined
        ? {}
        : { maxToolRounds: options.maxToolRounds }),
      ...(options.maxConcurrentToolBodies === undefined
        ? {}
        : { maxConcurrentToolBodies: options.maxConcurrentToolBodies }),
      toolOutputSpool,
    }),
    providerRegistry: new ProviderRegistry(profiles, {
      revision: options.configurationRevision ?? 0,
      onRetirementError: (error) =>
        console.error(
          `[provider retirement] ${error instanceof Error ? error.message : String(error)}`,
        ),
    }),
    threadMetadata:
      options.threadMetadata ??
      new JsonlThreadMetadataStore(
        path.join(options.dataDirectory, "thread-metadata.jsonl"),
      ),
    threadSummaryProjection:
      options.threadSummaryProjection ??
      new JsonThreadSummaryProjection(
        path.join(options.dataDirectory, "thread-summaries.json"),
      ),
    defaults: {
      cwd: path.resolve(options.cwd),
      providerProfileId: defaultSelection.providerProfileId,
      modelId: defaultSelection.modelId,
      reasoningEffort: defaultReasoningEffort(
        configuredDefault,
        defaultSelection,
      ),
      sandbox: "danger-full-access",
      approvalPolicy: options.approvalPolicy,
    },
    ...(options.contextCompaction === undefined
      ? {}
      : { contextCompaction: options.contextCompaction }),
  });
  const configuration = new HostRuntimeConfiguration({
    appServer,
    processEpoch: randomUUID(),
    initialOptions: options,
    initialRevision: options.configurationRevision ?? 0,
    initialResources: providerPreparation.resources,
    attachments,
  });
  let closeTransportPromise: Promise<void> | undefined;
  const closeProviderTransport = async () => {
    closeTransportPromise ??= (async () => {
      const toolResults = await Promise.allSettled([toolEnvironment.close()]);
      const results = [
        ...toolResults,
        ...(await Promise.allSettled([
          configuration.close(),
          toolOutputSpool.close(),
        ])),
      ];
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Could not close Host resources");
      }
    })();
    await closeTransportPromise;
  };
  return Object.assign(appServer, {
    processEpoch: configuration.processEpoch,
    prepareConfiguration: async (
      nextOptions: ZenHostOptions,
      revision: number,
      candidateToken?: string,
    ) => await configuration.prepare(nextOptions, revision, candidateToken),
    publishConfiguration: (candidate: HostConfigurationCandidate) =>
      configuration.publish(candidate),
    discardConfiguration: async (candidate: HostConfigurationCandidate) =>
      await configuration.discard(candidate),
    currentConfiguration: () => configuration.current(),
    closeProviderTransport,
    closeHostResources: closeProviderTransport,
  });
}

interface NormalizedProviderProfile extends HostProviderProfile {
  providerProfileId: string;
  catalog: StaticModelCatalog;
}

interface ProviderResource {
  readonly providerProfileId: string;
  readonly provider: HostProvider;
  readonly transport: ProviderTransport | undefined;
  readonly adapter: ModelAdapter;
  close(): Promise<void>;
}

interface PreparedProviderProfile extends NormalizedProviderProfile {
  registryProfile: {
    providerProfileId: string;
    adapter: ModelAdapter;
    modelCatalog: StaticModelCatalog;
    close(): Promise<void>;
  };
}

function normalizePreparedProviderProfiles(
  options: ZenHostOptions,
  attachments: AttachmentStore,
): readonly NormalizedProviderProfile[] {
  const configuredProfiles = normalizeProviderProfiles(options);
  const seenProfileIds = new Set<string>();
  return configuredProfiles.map((profile) => {
    const providerProfileId = profile.providerProfileId.trim();
    if (providerProfileId.length === 0) {
      throw new Error("Provider profile ids must not be empty");
    }
    if (seenProfileIds.has(providerProfileId)) {
      throw new Error(`Duplicate provider profile id: ${providerProfileId}`);
    }
    seenProfileIds.add(providerProfileId);
    const configuredModels = profile.models ?? [profile.model];
    const modelEntries =
      profile.modelCatalog ??
      legacyModelCatalogEntries(
        profile.provider.type,
        options.providers === undefined
          ? uniqueModels(configuredModels)
          : configuredModels,
      );
    const modelIds = modelEntries.map((entry) => entry.id.trim());
    if (
      profile.modelCatalog === undefined &&
      options.providers !== undefined &&
      (modelIds.some((id) => id.length === 0) ||
        new Set(modelIds).size !== modelIds.length)
    ) {
      throw new Error(
        `Model ids must be non-empty and unique in provider profile ${providerProfileId}`,
      );
    }
    if (!modelIds.includes(profile.model)) {
      throw new Error(
        `Default model ${profile.model} is absent from provider profile ${providerProfileId}`,
      );
    }
    if (profile.transport !== undefined)
      safeProxyUrl(profile.transport.proxyUrl);
    // Constructors are side-effect free. Validate every profile before any
    // closeable transport is allocated.
    createModel(profile.provider, globalThis.fetch, attachments);
    return {
      ...profile,
      providerProfileId,
      catalog: new StaticModelCatalog(
        modelEntries.map((entry) => ({
          ...entry,
          isDefault: entry.id.trim() === profile.model,
        })),
      ),
    };
  });
}

function createProviderProfiles(
  profiles: readonly NormalizedProviderProfile[],
  attachments: AttachmentStore,
  onStreamFailure: ReturnType<typeof createModelDiagnosticWriter>,
  reusable: ReadonlyMap<string, ProviderResource> = new Map(),
): {
  profiles: PreparedProviderProfile[];
  resources: Map<string, ProviderResource>;
  created: ProviderResource[];
} {
  const resources = new Map<string, ProviderResource>();
  const created: ProviderResource[] = [];
  const output: PreparedProviderProfile[] = [];
  try {
    for (const profile of profiles) {
      const existing = reusable.get(profile.providerProfileId);
      const resource =
        existing !== undefined &&
        isDeepStrictEqual(existing.provider, profile.provider) &&
        isDeepStrictEqual(existing.transport, profile.transport)
          ? existing
          : createProviderResource(profile, attachments, onStreamFailure);
      if (resource !== existing) created.push(resource);
      resources.set(profile.providerProfileId, resource);
      output.push({
        ...profile,
        registryProfile: {
          providerProfileId: profile.providerProfileId,
          adapter: resource.adapter,
          modelCatalog: profile.catalog,
          close: async () => await resource.close(),
        },
      });
    }
  } catch (error) {
    for (const resource of created)
      void resource.close().catch(() => undefined);
    throw error;
  }
  return { profiles: output, resources, created };
}

function createProviderResource(
  profile: NormalizedProviderProfile,
  attachments: AttachmentStore,
  onStreamFailure: ReturnType<typeof createModelDiagnosticWriter>,
): ProviderResource {
  const fetch = createProviderFetch(profile.transport);
  let closePromise: Promise<void> | undefined;
  try {
    const adapter = createModel(
      profile.provider,
      fetch,
      attachments,
      onStreamFailure,
    );
    return {
      providerProfileId: profile.providerProfileId,
      provider: profile.provider,
      transport: profile.transport,
      adapter,
      close: async () => {
        closePromise ??= Promise.resolve(fetch.close?.()).then(() => undefined);
        await closePromise;
      },
    };
  } catch (error) {
    void fetch.close?.().catch(() => undefined);
    throw error;
  }
}

type PreparedRuntimeConfiguration = ReturnType<
  ZenAppServer["prepareRuntimeConfiguration"]
>;

interface InternalConfigurationCandidate {
  readonly public: HostConfigurationCandidate;
  readonly options: ZenHostOptions;
  readonly resources: Map<string, ProviderResource>;
  readonly prepared: PreparedRuntimeConfiguration;
}

class HostRuntimeConfiguration {
  readonly processEpoch: string;
  readonly #appServer: ZenAppServer;
  readonly #processOptions: ZenHostOptions;
  readonly #attachments: AttachmentStore;
  readonly #onStreamFailure: ReturnType<typeof createModelDiagnosticWriter>;
  readonly #published = new Map<
    string,
    {
      candidate: HostConfigurationCandidate;
      current: HostConfigurationCurrent;
    }
  >();
  #currentOptions: ZenHostOptions;
  #currentResources: Map<string, ProviderResource>;
  #current: HostConfigurationCurrent;
  #pending: InternalConfigurationCandidate | undefined;
  #closed = false;

  constructor(options: {
    appServer: ZenAppServer;
    processEpoch: string;
    initialOptions: ZenHostOptions;
    initialRevision: number;
    initialResources: Map<string, ProviderResource>;
    attachments: AttachmentStore;
  }) {
    this.#appServer = options.appServer;
    this.processEpoch = options.processEpoch;
    this.#processOptions = options.initialOptions;
    this.#currentOptions = options.initialOptions;
    this.#currentResources = options.initialResources;
    this.#attachments = options.attachments;
    this.#onStreamFailure = createModelDiagnosticWriter(
      path.join(options.initialOptions.dataDirectory, "diagnostics"),
    );
    this.#current = Object.freeze({
      processEpoch: this.processEpoch,
      revision: options.initialRevision,
      pendingRestart: [],
    });
  }

  async prepare(
    nextOptions: ZenHostOptions,
    revision: number,
    candidateToken: string = randomUUID(),
  ): Promise<HostConfigurationCandidate> {
    this.#assertOpen();
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(
        "Configuration revision must be a non-negative safe integer",
      );
    }
    if (revision < this.#current.revision) {
      throw new Error(
        `Configuration revision ${String(revision)} is older than applied revision ${String(this.#current.revision)}`,
      );
    }
    if (this.#pending !== undefined) {
      throw new Error("Another Host configuration candidate is still pending");
    }
    const normalized = normalizePreparedProviderProfiles(
      nextOptions,
      this.#attachments,
    );
    const providerPreparation = createProviderProfiles(
      normalized,
      this.#attachments,
      this.#onStreamFailure,
      this.#currentResources,
    );
    try {
      const runtime = runtimeConfiguration(
        nextOptions,
        providerPreparation.profiles,
        revision,
      );
      const prepared = this.#appServer.prepareRuntimeConfiguration(runtime);
      const publicCandidate = Object.freeze({
        processEpoch: this.processEpoch,
        candidateToken,
        revision,
        pendingRestart: pendingRestartDomains(
          this.#processOptions,
          nextOptions,
        ),
      });
      this.#pending = {
        public: publicCandidate,
        options: nextOptions,
        resources: providerPreparation.resources,
        prepared,
      };
      return structuredClone(publicCandidate);
    } catch (error) {
      await Promise.allSettled(
        providerPreparation.created.map(
          async (resource) => await resource.close(),
        ),
      );
      throw error;
    }
  }

  publish(candidate: HostConfigurationCandidate): HostConfigurationCurrent {
    this.#assertOpen();
    this.#assertEpoch(candidate.processEpoch);
    const previous = this.#published.get(candidate.candidateToken);
    if (previous !== undefined) {
      if (previous.candidate.revision !== candidate.revision) {
        throw new Error(
          "Published Host configuration candidate does not match",
        );
      }
      return structuredClone(previous.current);
    }
    const pending = this.#requirePending(candidate);
    const previousOptions = this.#currentOptions;
    const previousResources = this.#currentResources;
    const previousCurrent = this.#current;
    this.#currentOptions = pending.options;
    this.#currentResources = pending.resources;
    this.#current = Object.freeze({
      processEpoch: this.processEpoch,
      revision: pending.public.revision,
      pendingRestart: [...pending.public.pendingRestart],
    });
    try {
      this.#appServer.publishRuntimeConfiguration(pending.prepared);
    } catch (error) {
      this.#currentOptions = previousOptions;
      this.#currentResources = previousResources;
      this.#current = previousCurrent;
      throw error;
    }
    this.#published.set(candidate.candidateToken, {
      candidate: structuredClone(pending.public),
      current: this.#current,
    });
    this.#pending = undefined;
    return structuredClone(this.#current);
  }

  async discard(candidate: HostConfigurationCandidate): Promise<void> {
    this.#assertOpen();
    this.#assertEpoch(candidate.processEpoch);
    const published = this.#published.get(candidate.candidateToken);
    if (published !== undefined) {
      if (published.candidate.revision !== candidate.revision) {
        throw new Error(
          "Published Host configuration candidate does not match",
        );
      }
      return;
    }
    const pending = this.#requirePending(candidate);
    this.#pending = undefined;
    await this.#appServer.discardRuntimeConfiguration(pending.prepared);
  }

  current(): HostConfigurationCurrent {
    this.#assertOpen();
    return structuredClone(this.#current);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pending = this.#pending;
    this.#pending = undefined;
    const failures: unknown[] = [];
    if (pending !== undefined) {
      try {
        await this.#appServer.discardRuntimeConfiguration(pending.prepared);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.#appServer.closeRuntimeConfiguration();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Could not close provider resources");
    }
  }

  #requirePending(
    candidate: HostConfigurationCandidate,
  ): InternalConfigurationCandidate {
    const pending = this.#pending;
    if (
      pending === undefined ||
      pending.public.candidateToken !== candidate.candidateToken ||
      pending.public.revision !== candidate.revision
    ) {
      throw new Error("Unknown or stale Host configuration candidate");
    }
    return pending;
  }

  #assertEpoch(epoch: string): void {
    if (epoch !== this.processEpoch) {
      throw new Error(
        "Host configuration candidate belongs to another process epoch",
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new Error("Host configuration resources are closed");
  }
}

function runtimeConfiguration(
  options: ZenHostOptions,
  profiles: readonly PreparedProviderProfile[],
  revision: number,
): Parameters<ZenAppServer["prepareRuntimeConfiguration"]>[0] {
  const defaultSelection = normalizeDefaultSelection(options, profiles);
  const configuredDefault = profiles
    .find(
      (profile) =>
        profile.providerProfileId === defaultSelection.providerProfileId,
    )
    ?.catalog.get(defaultSelection.modelId);
  if (configuredDefault === undefined) {
    throw new Error(
      `Default model ${defaultSelection.modelId} is absent from provider profile ${defaultSelection.providerProfileId}`,
    );
  }
  return {
    revision,
    providerProfiles: profiles.map((profile) => profile.registryProfile),
    defaults: {
      cwd: path.resolve(options.cwd),
      providerProfileId: defaultSelection.providerProfileId,
      modelId: defaultSelection.modelId,
      reasoningEffort: defaultReasoningEffort(
        configuredDefault,
        defaultSelection,
      ),
      sandbox: "danger-full-access",
      approvalPolicy: options.approvalPolicy,
    },
    ...(options.contextCompaction === undefined
      ? {}
      : { contextCompaction: options.contextCompaction }),
    ...(options.maxToolRounds === undefined
      ? {}
      : { maxToolRounds: options.maxToolRounds }),
    ...(options.maxConcurrentToolBodies === undefined
      ? {}
      : { maxConcurrentToolBodies: options.maxConcurrentToolBodies }),
  };
}

const RESTART_CONFIGURATION_DOMAINS = [
  "dataDirectory",
  "secretEnvironmentVariables",
  "toolPresentation",
  "codeRuntimeOptions",
  "toolOutputSpoolOptions",
] as const;

function pendingRestartDomains(
  running: ZenHostOptions,
  configured: ZenHostOptions,
): string[] {
  return RESTART_CONFIGURATION_DOMAINS.filter(
    (domain) =>
      !isDeepStrictEqual(
        restartDomainValue(running, domain),
        restartDomainValue(configured, domain),
      ),
  );
}

function restartDomainValue(
  options: ZenHostOptions,
  domain: (typeof RESTART_CONFIGURATION_DOMAINS)[number],
): unknown {
  if (domain !== "codeRuntimeOptions") return options[domain];
  const codeRuntimeOptions = options.codeRuntimeOptions;
  if (codeRuntimeOptions === undefined) return undefined;
  const { workerUrl: _workerUrl, ...serializableLimits } = codeRuntimeOptions;
  return Object.keys(serializableLimits).length === 0
    ? undefined
    : serializableLimits;
}

function prepareCodeRuntime(options: {
  existingDefinitions: readonly { name: string }[];
  requestedPresentation: ToolPresentation;
  codeRuntimeOptions:
    (Partial<CodeRuntimeLimits> & { workerUrl?: URL }) | undefined;
  warning: ((warning: string) => void) | undefined;
}): {
  presentation: ToolPresentation;
  runtime?: RunCodeToolRuntime;
} {
  if (options.requestedPresentation === "direct") {
    return { presentation: "direct" };
  }
  try {
    if (
      options.existingDefinitions.some(
        (definition) => definition.name === "run_code",
      )
    ) {
      throw new Error("Tool name run_code is reserved for the Code Runtime");
    }
    const runtime = new CodeRuntime(options.codeRuntimeOptions);
    runtime.assertReady();
    return {
      presentation: options.requestedPresentation,
      runtime: new RunCodeToolRuntime(runtime),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (options.requestedPresentation === "code") {
      throw new Error(`Code Runtime initialization failed: ${detail}`, {
        cause: error,
      });
    }
    const warning = `Code Runtime initialization failed; falling back to direct tools: ${detail}`;
    if (options.warning !== undefined) options.warning(warning);
    else process.stderr.write(`Zen warning: ${warning}\n`);
    return { presentation: "direct" };
  }
}

function normalizeProviderProfiles(
  options: ZenHostOptions,
): readonly HostProviderProfile[] {
  if (options.providers !== undefined) {
    if (options.providers.length === 0) {
      throw new Error("At least one provider profile is required");
    }
    return options.providers;
  }
  if (options.provider === undefined || options.model === undefined) {
    throw new Error("A provider and model are required");
  }
  const adapterIdentity = providerRuntimeIdentity(options.provider);
  return [
    {
      providerProfileId: adapterIdentity,
      provider: options.provider,
      model: options.model,
      ...(options.modelCatalog === undefined
        ? {}
        : { modelCatalog: options.modelCatalog }),
      ...(options.models === undefined ? {} : { models: options.models }),
      ...(options.transport === undefined
        ? {}
        : { transport: options.transport }),
    },
  ];
}

function defaultReasoningEffort(
  model: ReturnType<StaticModelCatalog["defaultModel"]>,
  selection: HostModelSelection,
): string | null {
  if (model.supportedReasoningEfforts === null) {
    throw new Error(
      `Supported reasoning efforts are unknown for default model ${selection.modelId} from provider profile ${selection.providerProfileId}; configure a manual capability override`,
    );
  }
  if (
    model.inputModalities === null ||
    !model.inputModalities.includes("text")
  ) {
    throw new Error(
      `Input modalities for default model ${selection.modelId} from provider profile ${selection.providerProfileId} do not confirm text support; configure a manual capability override`,
    );
  }
  if (model.defaultReasoningEffort !== null) {
    return model.defaultReasoningEffort;
  }
  if (model.supportedReasoningEfforts.length === 0) {
    return null;
  }
  throw new Error(
    `Default reasoning effort is unknown for model ${selection.modelId} from provider profile ${selection.providerProfileId}; configure a manual capability override`,
  );
}

function normalizeDefaultSelection(
  options: ZenHostOptions,
  profiles: readonly Pick<HostProviderProfile, "providerProfileId" | "model">[],
): HostModelSelection {
  if (options.defaultSelection !== undefined) return options.defaultSelection;
  const profile = profiles[0]!;
  return {
    providerProfileId: profile.providerProfileId,
    modelId: profile.model,
  };
}

function providerRuntimeIdentity(provider: HostProvider): string {
  if (provider.type === "fake") return "fake";
  if (provider.type === "openai-subscription") return "openai-codex";
  return provider.name?.trim() || "openai-compatible";
}

function uniqueModels(models: readonly string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const rawModel of models) {
    const model = rawModel.trim();
    if (model.length === 0 || seen.has(model)) {
      continue;
    }
    seen.add(model);
    output.push(model);
  }
  if (output.length === 0) {
    throw new Error("At least one configured model is required");
  }
  return output;
}

function createModel(
  provider: HostProvider,
  fetch: typeof globalThis.fetch,
  attachments: AttachmentStore,
  onStreamFailure?: ReturnType<typeof createModelDiagnosticWriter>,
): ModelAdapter {
  if (provider.type === "fake") {
    return new FakeModel();
  }
  if (provider.type === "openai-subscription") {
    const profile = new OpenAiSubscriptionAuthProfile(provider.profilePath, {
      fetch,
    });
    return new OpenAiSubscriptionModel({
      acquireAccessLease: async (signal) =>
        await profile.acquireAccessLease(signal),
      renewAccessLease: async (rejectedAccessToken, signal) =>
        await profile.renewAccessLease(rejectedAccessToken, signal),
      fetch,
      attachments,
    });
  }
  return new OpenAiCompatibleModel({
    ...(onStreamFailure === undefined ? {} : { onStreamFailure }),
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.name === undefined ? {} : { provider: provider.name }),
    ...(provider.defaultParams === undefined
      ? {}
      : { defaultParams: provider.defaultParams }),
    fetch,
    attachments,
  });
}

export function createProviderFetch(
  transport: ProviderTransport | undefined,
): ProviderFetch {
  if (transport === undefined) return globalThis.fetch;
  const proxyUrl = safeProxyUrl(transport.proxyUrl);
  const dispatcher = new ProxyAgent(proxyUrl);
  const fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    try {
      return (await undiciFetch(
        input as never,
        {
          ...init,
          dispatcher,
        } as never,
      )) as unknown as Response;
    } catch {
      const signal = init?.signal;
      if (signal?.aborted === true) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      throw new Error("Provider proxy transport request failed");
    }
  };
  return Object.assign(fetch, {
    close: async () => await dispatcher.close(),
  }) as ProviderFetch;
}

export function safeProxyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provider proxy URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider proxy URL must use http or https");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "Provider proxy URL cannot contain credentials, path, query, or fragment",
    );
  }
  return url.toString();
}
