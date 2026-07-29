import path from "node:path";

import { ZenAppServer } from "../../../src/app-server.js";
import {
  JsonlThreadJournal,
  type ThreadJournal,
} from "../../../src/journal.js";
import { FakeModel, type ModelAdapter } from "../../../src/model.js";
import { OpenAiCompatibleModel } from "../../../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../../../src/model/openai-subscription.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { ShellToolExecutor } from "../../../src/tool.js";
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
  approvalPolicy: "always" | "never";
  provider: HostProvider;
  secretEnvironmentVariables?: readonly string[];
  journal?: ThreadJournal;
}

export function createHostedAppServer(options: ZenHostOptions): ZenAppServer {
  const model = createModel(options.provider);
  return new ZenAppServer({
    journal:
      options.journal ??
      new JsonlThreadJournal(path.join(options.dataDirectory, "threads")),
    runtime: new AgentRuntime({
      model,
      tools: new ShellToolExecutor({
        blockedEnvironmentVariables: options.secretEnvironmentVariables ?? [],
        redactedValues:
          options.provider.type === "openai-compatible"
            ? [options.provider.apiKey]
            : [],
      }),
    }),
    defaults: {
      cwd: path.resolve(options.cwd),
      model: options.model,
      sandbox: "danger-full-access",
      approvalPolicy: options.approvalPolicy,
    },
  });
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
