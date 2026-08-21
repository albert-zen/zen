import path from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";

import { ZenAppServer } from "../../../src/app-server.js";
import {
  JsonlThreadJournal,
  type ThreadJournal,
} from "../../../src/journal.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { FakeModel, type ModelAdapter } from "../../../src/model.js";
import { OpenAiCompatibleModel } from "../../../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../../../src/model/openai-subscription.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { AgentRuntime } from "../../../src/runtime.js";
import {
  JsonlThreadMetadataStore,
  type ThreadMetadataStore,
} from "../../../src/thread-metadata.js";
import {
  JsonThreadSummaryProjection,
  type ThreadSummaryProjection,
} from "../../../src/thread-summary.js";
import { ShellToolExecutor, type ToolExecutor } from "../../../src/tool.js";
import { OpenAiSubscriptionAuthProfile } from "./subscription-auth.js";

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
  /** Compatibility input for existing single-provider CLI callers. */
  model?: string;
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
  tools?: ToolExecutor;
}

export interface ProviderTransport {
  proxyUrl: string;
}

export type ProviderFetch = typeof globalThis.fetch & {
  close?(): Promise<void>;
};

export type HostedZenAppServer = ZenAppServer & {
  closeProviderTransport(): Promise<void>;
};

export function createHostedAppServer(
  options: ZenHostOptions,
): HostedZenAppServer {
  const configuredProfiles = normalizeProviderProfiles(options);
  const seenProfileIds = new Set<string>();
  const preparedProfiles = configuredProfiles.map((profile) => {
    const providerProfileId = profile.providerProfileId.trim();
    if (providerProfileId.length === 0) {
      throw new Error("Provider profile ids must not be empty");
    }
    if (seenProfileIds.has(providerProfileId)) {
      throw new Error(`Duplicate provider profile id: ${providerProfileId}`);
    }
    seenProfileIds.add(providerProfileId);
    const configuredModels = profile.models ?? [profile.model];
    const modelIds = uniqueModels(configuredModels);
    if (
      options.providers !== undefined &&
      modelIds.length !== configuredModels.length
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
    // Adapter constructors are side-effect free; preflight configuration before
    // allocating any closeable proxy transport.
    createModel(profile.provider, globalThis.fetch);
    return {
      ...profile,
      providerProfileId,
      modelCatalog: new StaticModelCatalog(
        modelIds.map((id) => ({ id, isDefault: id === profile.model })),
      ),
    };
  });
  const defaultSelection = normalizeDefaultSelection(options, preparedProfiles);
  const configuredDefault = preparedProfiles
    .find(
      (profile) =>
        profile.providerProfileId === defaultSelection.providerProfileId,
    )
    ?.modelCatalog.get(defaultSelection.modelId);
  if (configuredDefault === undefined) {
    throw new Error(
      `Default model ${defaultSelection.modelId} is absent from provider profile ${defaultSelection.providerProfileId}`,
    );
  }
  const fetches: ProviderFetch[] = [];
  const redactedValues = preparedProfiles.flatMap((profile) =>
    profile.provider.type === "openai-compatible"
      ? [profile.provider.apiKey]
      : [],
  );
  const profiles = preparedProfiles.map((profile) => {
    const fetch = createProviderFetch(profile.transport);
    fetches.push(fetch);
    const adapter = redactModelOutput(
      createModel(profile.provider, fetch),
      redactedValues,
    );
    return {
      providerProfileId: profile.providerProfileId,
      adapter,
      modelCatalog: profile.modelCatalog,
    };
  });
  const appServer = new ZenAppServer({
    journal:
      options.journal ??
      new JsonlThreadJournal(path.join(options.dataDirectory, "threads")),
    runtime: new AgentRuntime({
      tools:
        options.tools ??
        new ShellToolExecutor({
          blockedEnvironmentVariables: options.secretEnvironmentVariables ?? [],
          redactedValues,
        }),
    }),
    providerRegistry: new ProviderRegistry(profiles),
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
      reasoningEffort: configuredDefault.defaultReasoningEffort ?? "medium",
      sandbox: "danger-full-access",
      approvalPolicy: options.approvalPolicy,
    },
  });
  return Object.assign(appServer, {
    closeProviderTransport: async () => {
      const results = await Promise.allSettled(
        fetches.map(async (fetch) => await fetch.close?.()),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Could not close provider transports",
        );
      }
    },
  });
}

export function redactModelOutput(
  adapter: ModelAdapter,
  redactedValues: readonly string[],
): ModelAdapter {
  const secrets = [
    ...new Set(redactedValues.filter((value) => value.length > 0)),
  ].sort((left, right) => right.length - left.length);
  if (secrets.length === 0) return adapter;
  const carryLength = secrets[0]!.length - 1;
  const redact = (value: string): string =>
    secrets.reduce(
      (output, secret) => output.split(secret).join("[REDACTED]"),
      value,
    );
  const redactValue = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redact(key),
        redactValue(entry),
      ]),
    );
  };
  return {
    provider: adapter.provider,
    async *stream(request) {
      let carry = "";
      try {
        for await (const event of adapter.stream(request)) {
          if (event.type === "text_delta") {
            const redacted = redact(carry + event.delta);
            const emitLength = Math.max(0, redacted.length - carryLength);
            carry = redacted.slice(emitLength);
            if (emitLength > 0) {
              yield { ...event, delta: redacted.slice(0, emitLength) };
            }
            continue;
          }

          if (event.type === "reasoning") {
            yield { ...event, summary: redact(event.summary) };
          } else if (event.type === "tool_call") {
            yield {
              ...event,
              callId: redact(event.callId),
              name: redact(event.name),
              arguments: redactValue(event.arguments) as Record<
                string,
                unknown
              >,
            };
          } else {
            yield event;
          }
        }
      } catch (error) {
        carry = "";
        throw error;
      }
      if (carry.length > 0) {
        yield { type: "text_delta", delta: redact(carry) };
      }
    },
  };
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
      ...(options.models === undefined ? {} : { models: options.models }),
      ...(options.transport === undefined
        ? {}
        : { transport: options.transport }),
    },
  ];
}

function normalizeDefaultSelection(
  options: ZenHostOptions,
  profiles: readonly HostProviderProfile[],
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
    });
  }
  return new OpenAiCompatibleModel({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.name === undefined ? {} : { provider: provider.name }),
    ...(provider.defaultParams === undefined
      ? {}
      : { defaultParams: provider.defaultParams }),
    fetch,
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
