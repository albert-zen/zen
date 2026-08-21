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

export interface ZenHostOptions {
  cwd: string;
  dataDirectory: string;
  model: string;
  models?: readonly string[];
  approvalPolicy: "always" | "never";
  provider: HostProvider;
  transport?: ProviderTransport;
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
  const fetch = createProviderFetch(options.transport);
  const model = createModel(options.provider, fetch);
  const modelIds = uniqueModels(options.models ?? [options.model]);
  if (!modelIds.includes(options.model)) {
    throw new Error(
      `Default model ${options.model} is absent from the configured model list`,
    );
  }
  const appServer = new ZenAppServer({
    journal:
      options.journal ??
      new JsonlThreadJournal(path.join(options.dataDirectory, "threads")),
    runtime: new AgentRuntime({
      model,
      tools:
        options.tools ??
        new ShellToolExecutor({
          blockedEnvironmentVariables: options.secretEnvironmentVariables ?? [],
          redactedValues:
            options.provider.type === "openai-compatible"
              ? [options.provider.apiKey]
              : [],
        }),
    }),
    modelCatalog: new StaticModelCatalog(
      modelIds.map((id) => ({ id, isDefault: id === options.model })),
    ),
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
      model: options.model,
      sandbox: "danger-full-access",
      approvalPolicy: options.approvalPolicy,
    },
  });
  return Object.assign(appServer, {
    closeProviderTransport: async () => await fetch.close?.(),
  });
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
