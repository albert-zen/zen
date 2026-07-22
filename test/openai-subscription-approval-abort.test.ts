import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model as PiModel,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { LocalToolRuntime } from '../packages/framework/src/adapters/node/local-tool-runtime.js';
import {
  OpenAiSubscriptionModelGateway,
  type OpenAiSubscriptionProvider,
} from '../packages/framework/src/adapters/node/openai-subscription-model-gateway.js';
import {
  OpenAISubscriptionProviderService,
  type OpenAISubscriptionOAuthCredential,
  type OpenAISubscriptionProvider as SubscriptionProviderServiceAdapter,
} from '../packages/framework/src/adapters/node/openai-subscription-provider-service.js';
import { createWebUiState } from '../packages/framework/src/presentation/web-ui-state.js';
import { AppServer, ApprovalBroker, type AppServerNotification } from './test-exports.js';

describe('OpenAI subscription approval termination', () => {
  it('drains and records a pending shell decline when auth generation changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-openai-approval-abort-'));
    const provider = shellProvider();
    const service = new OpenAISubscriptionProviderService({ appDataRoot: root, provider });
    await seedCredential(service);
    const broker = new ApprovalBroker({ generateId: () => 'approval-auth-1' });
    const gateway = new OpenAiSubscriptionModelGateway({
      sessionId: 'approval-thread-session',
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'Run a command.',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
              additionalProperties: false,
            },
          },
        },
      ],
      provider: gatewayProvider(service),
      acquireAccessLease: async (signal) => await service.acquireAccessLease(signal),
    });
    const server = new AppServer({
      approvalBroker: broker,
      threadManagerOptions: {
        generateThreadId: sequence('thread'),
        generateTurnId: sequence('turn'),
        generateRunId: sequence('run'),
        generateItemId: sequence('item'),
        runtimeFactory: ({ approvalBroker }) => ({
          model: gateway,
          toolRuntime: new LocalToolRuntime({ cwd: root, approvalBroker }),
        }),
      },
    });

    try {
      const started = await server.request({ method: 'thread/start' });
      if (!started.ok || started.method !== 'thread/start') throw new Error('thread start failed');
      const threadId = started.result.thread.id;
      const approval = waitForApproval(server);
      const terminal = waitForTerminal(server);
      await server.request({
        method: 'turn/start',
        params: { threadId, input: 'Run the shell command' },
      });
      const requested = await approval;

      await service.logout();
      const failed = await terminal;
      expect(failed.type).toBe('turn/failed');
      expect(broker.listPending()).toEqual([]);

      const snapshotResponse = await server.request({
        method: 'thread/read',
        params: { threadId },
      });
      if (!snapshotResponse.ok || snapshotResponse.method !== 'thread/read') {
        throw new Error('thread read failed');
      }
      const snapshot = snapshotResponse.result.thread;
      const approvalItems = snapshot.items.filter(
        (item) => item.type === 'approval.requested' || item.type === 'approval.resolved'
      );
      const toolResults = snapshot.items.filter((item) => item.type === 'tool.result.completed');

      expect(approvalItems).toEqual([
        expect.objectContaining({ type: 'approval.requested' }),
        expect.objectContaining({
          type: 'approval.resolved',
          payload: expect.objectContaining({
            approvalId: requested.approvalId,
            decision: 'decline',
            decisionReason: 'Turn failed',
          }),
        }),
      ]);
      expect(toolResults).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            toolCallId: 'shell-call-1',
            isError: true,
          }),
        }),
      ]);

      const staleResolution = await server.request({
        method: 'approval/resolve',
        params: {
          approvalId: requested.approvalId,
          threadId,
          turnId: requested.turnId,
          decision: 'approveOnce',
        },
      });
      expect(staleResolution).toEqual(expect.objectContaining({ ok: false }));

      const ui = createWebUiState(snapshot);
      expect([...ui.timelineRows].filter((row) => row.type === 'approval-pending')).toEqual([]);
      expect([...ui.timelineRows]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'approval-resolved',
            approvalId: requested.approvalId,
            decision: 'decline',
          }),
        ])
      );
    } finally {
      await server.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function shellProvider(): SubscriptionProviderServiceAdapter {
  const model = {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
  } as PiModel<'openai-codex-responses'>;
  return {
    id: 'openai-codex',
    auth: {
      oauth: {
        login: async () => credential(),
        refresh: async (current) => current,
      },
    },
    getModels: () => [model],
    stream: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: 'done',
        reason: 'toolUse',
        message: assistantToolCall(model.id),
      });
      return stream;
    },
  };
}

function gatewayProvider(service: OpenAISubscriptionProviderService): OpenAiSubscriptionProvider {
  const provider = service.modelProvider;
  return {
    getModels: () => provider.getModels(),
    stream: (model, context, options) => provider.stream(model, context, options),
  };
}

function assistantToolCall(model: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: 'shell-call-1',
        name: 'shell',
        arguments: { command: 'echo must-not-run' },
      },
    ],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 0,
  };
}

async function seedCredential(service: OpenAISubscriptionProviderService): Promise<void> {
  await writeFile(
    service.credentialPath,
    JSON.stringify({
      version: 1,
      provider: 'openai-codex',
      credential: credential(),
      updatedAt: '2026-07-22T00:00:00.000Z',
    })
  );
}

function credential(): OpenAISubscriptionOAuthCredential {
  return {
    type: 'oauth',
    access: 'test-access',
    refresh: 'test-refresh',
    expires: Date.now() + 60 * 60_000,
  };
}

function waitForApproval(
  server: AppServer
): Promise<Extract<AppServerNotification, { readonly type: 'approval/requested' }>> {
  return new Promise((resolve) => {
    const unsubscribe = server.subscribe((notification) => {
      if (notification.type !== 'approval/requested') return;
      unsubscribe();
      resolve(notification);
    });
  });
}

function waitForTerminal(
  server: AppServer
): Promise<Extract<AppServerNotification, { readonly type: 'turn/failed' }>> {
  return new Promise((resolve) => {
    const unsubscribe = server.subscribe((notification) => {
      if (notification.type !== 'turn/failed') return;
      unsubscribe();
      resolve(notification);
    });
  });
}

function sequence(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
