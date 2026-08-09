import path from "node:path";

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
  secretEnvironmentVariables?: readonly string[];
  journal?: ThreadJournal;
  threadMetadata?: ThreadMetadataStore;
  tools?: ToolExecutor;
}

export function createHostedAppServer(options: ZenHostOptions): ZenAppServer {
  const model = createModel(options.provider);
  const modelIds = uniqueModels(options.models ?? [options.model]);
  if (!modelIds.includes(options.model)) {
    throw new Error(
      `Default model ${options.model} is absent from the configured model list`,
    );
  }
  return new ZenAppServer({
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
    defaults: {
      cwd: path.resolve(options.cwd),
      model: options.model,
      sandbox: "danger-full-access",
      approvalPolicy: options.approvalPolicy,
    },
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

function createModel(provider: HostProvider): ModelAdapter {
  if (provider.type === "fake") {
    return new FakeModel();
  }
  if (provider.type === "openai-subscription") {
    const profile = new OpenAiSubscriptionAuthProfile(provider.profilePath);
    return new OpenAiSubscriptionModel({
      acquireAccessLease: async (signal) =>
        await profile.acquireAccessLease(signal),
    });
  }
  return new OpenAiCompatibleModel({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.name === undefined ? {} : { provider: provider.name }),
    ...(provider.defaultParams === undefined
      ? {}
      : { defaultParams: provider.defaultParams }),
  });
}
