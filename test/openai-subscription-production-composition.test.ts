import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AssistantMessage, Context, Model as PiModel } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import {
  createAgentAppProductionComposition,
  OpenAISubscriptionProviderService,
  type OpenAISubscriptionOAuthCredential,
  type OpenAISubscriptionProvider,
} from './test-exports.js';

describe('OpenAI subscription production composition', () => {
  it('shares close work, re-arms a transient provider failure, and remains idempotent after success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-openai-close-retry-'));
    const provider = new SignedTextPiProvider();
    const attempts: string[] = [];
    let failuresRemaining = 2;
    const service = await authenticatedService(root, provider, [], (sessionId) => {
      attempts.push(sessionId);
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('transient provider close failure');
      }
    });
    const composition = await createAgentAppProductionComposition({
      appDataRoot: root,
      openaiSubscriptionProviderService: service,
    });

    try {
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const project = await composition.agentAppServer.request({
        method: 'project/create',
        params: {
          name: 'Close retry',
          rootPath: workspace,
          idempotencyKey: 'close-project',
        },
      });
      const projectId = nestedId(project, 'project');
      const thread = await composition.agentAppServer.request({
        method: 'thread/create',
        params: { projectId, idempotencyKey: 'close-thread' },
      });
      const threadId = nestedId(thread, 'thread');
      await startTurnAndWait(composition, provider, projectId, threadId, 'own close session', 1);
      const ownedSession = sessionForPrompt(provider, 'own close session');

      const first = composition.close();
      const concurrent = composition.close();
      expect(concurrent).toBe(first);
      await expect(first).rejects.toThrow('Production composition close failed');
      await expect(concurrent).rejects.toThrow('Production composition close failed');

      const retry = composition.close();
      await expect(retry).resolves.toBeUndefined();
      expect(composition.close()).toBe(retry);
      expect(attempts).toEqual([ownedSession, ownedSession, ownedSession]);
    } finally {
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs the default path through AgentLoop, persists and replays Item context, exposes OAuth control, and closes Pi sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-openai-production-'));
    const closedSessions: string[] = [];
    const provider = new StreamingPiProvider();
    const service = await authenticatedService(root, provider, closedSessions);
    const composition = await createAgentAppProductionComposition({
      appDataRoot: root,
      openaiSubscriptionProviderService: service,
    });

    try {
      await mkdir(join(root, 'workspace'));
      const status = await composition.agentAppServer.request({
        method: 'provider/read',
        params: {},
      });
      expect(status).toMatchObject({
        ok: true,
        result: {
          status: {
            provider: { id: 'openai-codex', auth: 'oauth' },
            transport: { preferred: 'websocket', fallback: 'http' },
            models: { defaultModel: 'gpt-5.6-terra' },
          },
        },
      });

      const project = await composition.agentAppServer.request({
        method: 'project/create',
        params: {
          name: 'Subscription',
          rootPath: join(root, 'workspace'),
          policy: projectPolicy('project-model'),
          idempotencyKey: 'project',
        },
      });
      const projectId = nestedId(project, 'project');
      const thread = await composition.agentAppServer.request({
        method: 'thread/create',
        params: {
          projectId,
          modelProfile: 'thread-model',
          idempotencyKey: 'thread',
        },
      });
      const threadId = nestedId(thread, 'thread');
      await composition.agentAppServer.request({
        method: 'turn/start',
        params: { projectId, threadId, input: 'remember this request', idempotencyKey: 'turn' },
      });
      await waitFor(
        () => provider.models.includes('thread-model') && provider.contexts.length >= 2
      );
      await waitForAsync(async () => {
        const snapshot = await composition.agentAppServer.request({
          method: 'thread/read',
          params: { projectId, threadId },
        });
        return snapshotItems(snapshot).some((item) => item.type === 'turn.completed');
      });

      const completed = await composition.agentAppServer.request({
        method: 'thread/read',
        params: { projectId, threadId },
      });
      const itemTypes = snapshotItems(completed).map((item) => item.type);
      expect(itemTypes).toEqual(
        expect.arrayContaining([
          'system.message.completed',
          'user.message.completed',
          'assistant.message.completed',
          'tool.call.started',
          'tool.result.completed',
          'turn.completed',
        ])
      );
      const threadSession = sessionForPrompt(provider, 'remember this request');
      expect(threadSession).not.toBe(threadId);
      const toolLoopAssistant = provider.contexts[1].messages.find(
        (message) => message.role === 'assistant'
      );
      expect(toolLoopAssistant?.role).toBe('assistant');
      expect(toolLoopAssistant?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'thinking',
            thinkingSignature: expect.stringContaining('opaque-tool-reasoning'),
          }),
          expect.objectContaining({ type: 'toolCall', id: 'list-threads|fc_list_threads' }),
        ])
      );

      const projectDefaultThread = await composition.agentAppServer.request({
        method: 'thread/create',
        params: { projectId, idempotencyKey: 'project-default-thread' },
      });
      await composition.agentAppServer.request({
        method: 'turn/start',
        params: {
          projectId,
          threadId: nestedId(projectDefaultThread, 'thread'),
          input: 'use the project model',
          idempotencyKey: 'project-default-turn',
        },
      });
      await waitFor(() => provider.models.at(-1) === 'project-model');

      await mkdir(join(root, 'default-workspace'));
      const providerDefaultProject = await composition.agentAppServer.request({
        method: 'project/create',
        params: {
          name: 'Provider default',
          rootPath: join(root, 'default-workspace'),
          idempotencyKey: 'provider-default-project',
        },
      });
      const providerDefaultProjectId = nestedId(providerDefaultProject, 'project');
      const providerDefaultThread = await composition.agentAppServer.request({
        method: 'thread/create',
        params: { projectId: providerDefaultProjectId, idempotencyKey: 'provider-default-thread' },
      });
      await composition.agentAppServer.request({
        method: 'turn/start',
        params: {
          projectId: providerDefaultProjectId,
          threadId: nestedId(providerDefaultThread, 'thread'),
          input: 'use the provider model',
          idempotencyKey: 'provider-default-turn',
        },
      });
      await waitFor(() => provider.models.at(-1) === 'gpt-5.6-terra');

      await composition.close();
      expect(closedSessions).toContain(threadSession);

      const replayProvider = new StreamingPiProvider();
      const replayService = await authenticatedService(root, replayProvider, closedSessions);
      const restarted = await createAgentAppProductionComposition({
        appDataRoot: root,
        openaiSubscriptionProviderService: replayService,
      });
      try {
        const replay = await restarted.agentAppServer.request({
          method: 'thread/read',
          params: { projectId, threadId },
        });
        expect(snapshotItems(replay).map((item) => item.type)).toContain('tool.result.completed');
        await restarted.agentAppServer.request({
          method: 'turn/start',
          params: { projectId, threadId, input: 'continue', idempotencyKey: 'replay-turn' },
        });
        await waitFor(() => replayProvider.contexts.length > 0);
        expect(JSON.stringify(replayProvider.contexts[0])).toContain('remember this request');
        expect(providerSignatures(replayProvider.contexts[0])).toEqual([]);
      } finally {
        await restarted.close();
      }
    } finally {
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caches continuation per thread and effective model, then invalidates it atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-openai-model-cache-'));
    const closedSessions: string[] = [];
    const provider = new SignedTextPiProvider();
    const service = await authenticatedService(root, provider, closedSessions);
    const composition = await createAgentAppProductionComposition({
      appDataRoot: root,
      openaiSubscriptionProviderService: service,
    });

    try {
      await mkdir(join(root, 'workspace'));
      const project = await composition.agentAppServer.request({
        method: 'project/create',
        params: {
          name: 'Model cache',
          rootPath: join(root, 'workspace'),
          policy: projectPolicy('project-model'),
          idempotencyKey: 'project',
        },
      });
      const projectId = nestedId(project, 'project');
      const thread = await composition.agentAppServer.request({
        method: 'thread/create',
        params: { projectId, idempotencyKey: 'thread' },
      });
      const threadId = nestedId(thread, 'thread');

      await startTurnAndWait(composition, provider, projectId, threadId, 'first', 1);
      await startTurnAndWait(composition, provider, projectId, threadId, 'second', 2);
      const providerSession = sessionForPrompt(provider, 'first');
      expect(provider.models.slice(0, 2)).toEqual(['project-model', 'project-model']);
      expect(providerSignatures(provider.contexts[1])).toContain('msg_signed_1');
      expect(closedSessions).toEqual([]);

      await composition.agentAppServer.request({
        method: 'project/update',
        params: {
          projectId,
          policy: projectPolicy('thread-model'),
          idempotencyKey: 'switch-model',
        },
      });
      await startTurnAndWait(composition, provider, projectId, threadId, 'third', 3);

      expect(provider.models[2]).toBe('thread-model');
      expect(providerSignatures(provider.contexts[2])).toEqual([]);
      expect(closedSessions).toEqual([providerSession]);

      await composition.close();
      expect(closedSessions).toEqual([providerSession, providerSession]);
    } finally {
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('isolates project-local thread ids in provider sessions and lifecycle changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-openai-project-sessions-'));
    const closedSessions: string[] = [];
    const closeAttempts: string[] = [];
    let failOnceFor: string | undefined;
    let failedOnce = false;
    const provider = new SignedTextPiProvider();
    const service = await authenticatedService(root, provider, closedSessions, (sessionId) => {
      closeAttempts.push(sessionId);
      if (sessionId === failOnceFor && !failedOnce) {
        failedOnce = true;
        throw new Error('simulated Pi session close failure');
      }
      closedSessions.push(sessionId);
    });
    const composition = await createAgentAppProductionComposition({
      appDataRoot: root,
      openaiSubscriptionProviderService: service,
    });

    try {
      const projects = await Promise.all(
        ['alpha', 'beta'].map(async (name) => {
          const workspace = join(root, name);
          await mkdir(workspace);
          const created = await composition.agentAppServer.request({
            method: 'project/create',
            params: {
              name,
              rootPath: workspace,
              policy: projectPolicy('project-model'),
              idempotencyKey: `project-${name}`,
            },
          });
          return nestedId(created, 'project');
        })
      );
      const threads = await Promise.all(
        projects.map(async (projectId, index) => {
          const created = await composition.agentAppServer.request({
            method: 'thread/create',
            params: { projectId, idempotencyKey: `thread-${index}` },
          });
          return nestedId(created, 'thread');
        })
      );
      expect(threads).toEqual(['thread-1', 'thread-1']);

      await Promise.all(
        projects.map(
          async (projectId, index) =>
            await composition.agentAppServer.request({
              method: 'turn/start',
              params: {
                projectId,
                threadId: threads[index],
                input: `project-${index}`,
                idempotencyKey: `turn-${index}`,
              },
            })
        )
      );
      await waitFor(() => provider.contexts.length >= 2);
      await Promise.all(
        projects.map(
          async (projectId, index) =>
            await waitForCompletedTurns(composition, projectId, threads[index], 1)
        )
      );
      const alphaSession = sessionForPrompt(provider, 'project-0');
      const betaSession = sessionForPrompt(provider, 'project-1');
      expect(alphaSession).not.toBe(betaSession);

      await composition.agentAppServer.request({
        method: 'project/update',
        params: {
          projectId: projects[0],
          policy: projectPolicy('thread-model'),
          idempotencyKey: 'alpha-model-switch',
        },
      });
      failOnceFor = alphaSession;
      await composition.agentAppServer.request({
        method: 'turn/start',
        params: {
          projectId: projects[0],
          threadId: threads[0],
          input: 'alpha close fails once',
          idempotencyKey: 'alpha-close-fails',
        },
      });
      await waitForAsync(async () => {
        const snapshot = await composition.agentAppServer.request({
          method: 'thread/read',
          params: { projectId: projects[0], threadId: threads[0] },
        });
        return snapshotItems(snapshot).some((item) => item.type === 'turn.failed');
      });
      expect(provider.contexts).toHaveLength(2);
      expect(closedSessions).toEqual([]);

      await startTurnAndWait(
        composition,
        provider,
        projects[0],
        threads[0],
        'alpha switched after retry',
        3,
        2
      );
      expect(closedSessions).toEqual([alphaSession]);
      expect(closeAttempts.filter((sessionId) => sessionId === alphaSession)).toHaveLength(2);
      expect(provider.sessionIds.filter((sessionId) => sessionId === alphaSession)).toHaveLength(2);

      await composition.agentAppServer.request({
        method: 'project/archive',
        params: { projectId: projects[0], idempotencyKey: 'archive-alpha' },
      });
      expect(closedSessions).toEqual([alphaSession, alphaSession]);

      await startTurnAndWait(
        composition,
        provider,
        projects[1],
        threads[1],
        'beta continues',
        4,
        2
      );
      expect(provider.sessionIds.at(-1)).toBe(betaSession);
      expect(closedSessions).not.toContain(betaSession);
    } finally {
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('contains no Codex process or provider-turn route in production composition', async () => {
    const sources = await Promise.all(
      [
        'packages/framework/src/adapters/node/agent-app-production.ts',
        'packages/framework/src/adapters/node/agent-app-runtime.ts',
      ].map(async (path) => await readFile(path, 'utf8'))
    );
    expect(sources.join('\n')).not.toMatch(
      /CodexTurnExecutor|CodexProviderService|codex-app-server|codex\.exe|node:child_process/i
    );
  });
});

class StreamingPiProvider implements OpenAISubscriptionProvider {
  readonly id = 'openai-codex';
  readonly models: string[] = [];
  readonly contexts: Context[] = [];
  readonly sessionIds: string[] = [];
  private toolCallPending = true;
  private responseIndex = 0;
  readonly auth = {
    oauth: {
      login: async () => validCredential(),
      refresh: async (credential: OpenAISubscriptionOAuthCredential) => credential,
    },
  };

  getModels() {
    return [piModel('gpt-5.6-terra'), piModel('project-model'), piModel('thread-model')];
  }

  readonly stream = ((
    model: PiModel<'openai-codex-responses'>,
    context: Context,
    options: unknown
  ) =>
    this.streamEvents(model, context, options)) as unknown as OpenAISubscriptionProvider['stream'];

  private async *streamEvents(
    model: PiModel<'openai-codex-responses'>,
    context: Context,
    options: unknown
  ) {
    this.models.push(model.id);
    this.contexts.push(context);
    const sessionId = (options as { readonly sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string') this.sessionIds.push(sessionId);
    if (this.toolCallPending) {
      this.toolCallPending = false;
      const threadListName = context.tools?.find((tool) =>
        tool.description.includes('thread.list')
      )?.name;
      if (!threadListName) throw new Error('Missing provider-safe thread.list definition');
      yield {
        type: 'done' as const,
        message: assistantMessage('tool', threadListName, ++this.responseIndex, model.id),
      };
      return;
    }
    yield {
      type: 'done' as const,
      message: assistantMessage('complete', '', ++this.responseIndex, model.id),
    };
  }
}

class SignedTextPiProvider implements OpenAISubscriptionProvider {
  readonly id = 'openai-codex';
  readonly models: string[] = [];
  readonly contexts: Context[] = [];
  readonly sessionIds: string[] = [];
  private responseIndex = 0;
  readonly auth = {
    oauth: {
      login: async () => validCredential(),
      refresh: async (credential: OpenAISubscriptionOAuthCredential) => credential,
    },
  };

  getModels() {
    return [piModel('gpt-5.6-terra'), piModel('project-model'), piModel('thread-model')];
  }

  readonly stream = ((
    model: PiModel<'openai-codex-responses'>,
    context: Context,
    options: unknown
  ) =>
    this.streamEvents(model, context, options)) as unknown as OpenAISubscriptionProvider['stream'];

  private async *streamEvents(
    model: PiModel<'openai-codex-responses'>,
    context: Context,
    options: unknown
  ) {
    this.models.push(model.id);
    this.contexts.push(context);
    const sessionId = (options as { readonly sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string') this.sessionIds.push(sessionId);
    yield {
      type: 'done' as const,
      message: assistantMessage('complete', '', ++this.responseIndex, model.id),
    };
  }
}

async function authenticatedService(
  root: string,
  provider: OpenAISubscriptionProvider,
  closedSessions: string[],
  closeSession: (sessionId: string) => void = (sessionId) => closedSessions.push(sessionId)
): Promise<OpenAISubscriptionProviderService> {
  const service = new OpenAISubscriptionProviderService({
    appDataRoot: root,
    provider,
    refreshCredential: async (credential, signal) =>
      await provider.auth.oauth!.refresh(credential, signal),
    closeSession,
  });
  await writeFile(
    service.credentialPath,
    JSON.stringify({
      version: 1,
      provider: 'openai-codex',
      credential: validCredential(),
      updatedAt: '2026-07-22T00:00:00.000Z',
    })
  );
  return service;
}

function validCredential(): OpenAISubscriptionOAuthCredential {
  return {
    type: 'oauth',
    access: 'subscription-access',
    refresh: 'subscription-refresh',
    expires: Date.now() + 60 * 60_000,
  };
}

function projectPolicy(defaultModelProfile: string) {
  return {
    maxActiveExecutions: 2,
    maxThreadDepth: 4,
    maxThreads: 100,
    maxQueuedMessages: 100,
    maxWaitTargets: 16,
    maxMessageBytes: 16_384,
    idempotencyRetention: 1_000,
    agentCanCreateThreads: true,
    agentCanMessagePeers: true,
    defaultModelProfile,
  };
}

function piModel(id: string): PiModel<'openai-codex-responses'> {
  return {
    id,
    name: id,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
  } as PiModel<'openai-codex-responses'>;
}

function assistantMessage(
  kind: 'tool' | 'complete',
  toolName = 'thread.list',
  responseIndex = 1,
  modelId = 'gpt-5.6-terra'
): AssistantMessage {
  return {
    role: 'assistant',
    content:
      kind === 'tool'
        ? [
            {
              type: 'thinking',
              thinking: '',
              thinkingSignature: JSON.stringify({
                type: 'reasoning',
                id: 'rs_tool',
                summary: [],
                encrypted_content: 'opaque-tool-reasoning',
              }),
            },
            {
              type: 'toolCall',
              id: 'list-threads|fc_list_threads',
              name: toolName,
              arguments: {},
            },
          ]
        : [
            {
              type: 'text',
              text: 'complete',
              textSignature: JSON.stringify({ v: 1, id: `msg_signed_${responseIndex}` }),
            },
          ],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: kind === 'tool' ? 'toolUse' : 'stop',
    responseId: `resp_signed_${responseIndex}`,
    timestamp: 0,
  };
}

function providerSignatures(context: Context): readonly string[] {
  return context.messages.flatMap((message) =>
    message.role === 'assistant'
      ? message.content.flatMap((block) =>
          block.type === 'text' && block.textSignature
            ? [JSON.parse(block.textSignature).id as string]
            : block.type === 'thinking' && block.thinkingSignature
              ? [block.thinkingSignature]
              : []
        )
      : []
  );
}

function sessionForPrompt(
  provider: Readonly<{ contexts: readonly Context[]; sessionIds: readonly string[] }>,
  prompt: string
): string {
  const index = provider.contexts.findIndex((context) => JSON.stringify(context).includes(prompt));
  const sessionId = provider.sessionIds[index];
  if (!sessionId) throw new Error(`Missing provider session for ${prompt}`);
  return sessionId;
}

async function startTurnAndWait(
  composition: Awaited<ReturnType<typeof createAgentAppProductionComposition>>,
  provider: SignedTextPiProvider,
  projectId: string,
  threadId: string,
  input: string,
  expectedRequestCount: number,
  expectedTurnCount = expectedRequestCount
): Promise<void> {
  await composition.agentAppServer.request({
    method: 'turn/start',
    params: {
      projectId,
      threadId,
      input,
      idempotencyKey: `turn-${expectedRequestCount}`,
    },
  });
  await waitFor(() => provider.contexts.length >= expectedRequestCount);
  await waitForAsync(async () => {
    const snapshot = await composition.agentAppServer.request({
      method: 'thread/read',
      params: { projectId, threadId },
    });
    return (
      snapshotItems(snapshot).filter((item) => item.type === 'turn.completed').length >=
      expectedTurnCount
    );
  });
}

async function waitForCompletedTurns(
  composition: Awaited<ReturnType<typeof createAgentAppProductionComposition>>,
  projectId: string,
  threadId: string,
  expected: number
): Promise<void> {
  await waitForAsync(async () => {
    const snapshot = await composition.agentAppServer.request({
      method: 'thread/read',
      params: { projectId, threadId },
    });
    return (
      snapshotItems(snapshot).filter((item) => item.type === 'turn.completed').length >= expected
    );
  });
}

function nestedId(value: unknown, key: string): string {
  const object = value as { readonly result?: Record<string, Record<string, unknown>> };
  const id = object.result?.[key]?.id;
  if (typeof id !== 'string') throw new Error(`Missing ${key} id`);
  return id;
}

function snapshotItems(value: unknown): readonly { readonly type: string }[] {
  const object = value as { readonly result?: { readonly thread?: { readonly items?: unknown } } };
  const items = object.result?.thread?.items;
  if (!Array.isArray(items)) throw new Error('Missing thread items');
  return items as readonly { readonly type: string }[];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for subscription execution');
}

async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for subscription execution');
}
