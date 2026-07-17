import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AgentLoop,
  InMemoryItemList,
  appendToolExecutionItems,
  type AgentLoopOptions,
} from './test-exports.js';
import {
  ApprovalBroker,
  PolicyToolRuntime,
  type PolicyRuntime,
} from '../src/product/approval-runtime.js';
import type {
  ToolCallPayload,
  ToolExecutionContext,
  ToolRuntime,
} from '../src/kernel/tool-runtime.js';

describe('PolicyToolRuntime', () => {
  it('delegates allowed tool calls to the wrapped runtime', async () => {
    const call = createCall();
    const context = createContext();
    const policy: PolicyRuntime = {
      evaluate(receivedCall, receivedContext) {
        expect(receivedCall).toEqual(call);
        expect(receivedContext).toEqual(context);
        return { type: 'allow' };
      },
    };
    const executedCalls: ToolCallPayload[] = [];
    const wrapped: ToolRuntime = {
      async *execute(receivedCall) {
        executedCalls.push(receivedCall);
        yield { type: 'result.completed', content: 'allowed result' };
      },
    };
    const runtime = new PolicyToolRuntime({
      policy,
      approvalBroker: new ApprovalBroker(),
      toolRuntime: wrapped,
    });

    await expect(collect(runtime.execute(call, context))).resolves.toEqual([
      { type: 'result.completed', content: 'allowed result' },
    ]);
    expect(executedCalls).toEqual([call]);
  });

  it('prevents wrapped execution and appends a tool error item when policy denies', async () => {
    const items = createItems();
    const assistant = appendAssistantToolCall(items);
    let executed = false;
    const runtime = new PolicyToolRuntime({
      policy: {
        evaluate() {
          return { type: 'deny', reason: 'filesystem write is blocked' };
        },
      },
      approvalBroker: new ApprovalBroker(),
      toolRuntime: {
        async *execute() {
          executed = true;
          yield { type: 'result.completed', content: 'should not execute' };
        },
      },
    });

    const result = await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant,
    });

    expect(executed).toBe(false);
    expect(result.completed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(items.getItems().map((item) => item.type)).toEqual([
      'assistant.message.completed',
      'tool.call.started',
      'tool.error',
    ]);
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        type: 'tool.error',
        visibility: 'trace',
        payload: expect.objectContaining({
          toolCallId: 'call-weather-1',
          toolName: 'weather',
          message: 'Tool call denied by policy: filesystem write is blocked',
        }),
      })
    );
  });

  it('waits for approval before executing the wrapped runtime', async () => {
    const call = createCall();
    const context = createContext();
    const broker = new ApprovalBroker({
      generateId: () => 'approval-1',
    });
    let executed = false;
    const runtime = new PolicyToolRuntime({
      policy: {
        evaluate() {
          return { type: 'needsApproval', reason: 'outside workspace' };
        },
      },
      approvalBroker: broker,
      toolRuntime: {
        async *execute() {
          executed = true;
          yield { type: 'result.completed', content: 'approved result' };
        },
      },
    });
    const iterator = runtime.execute(call, context)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'approval.requested',
        request: {
          id: 'approval-1',
          threadId: '',
          turnId: 'turn-1',
          runId: 'run-1',
          toolCallId: 'call-weather-1',
          toolName: 'weather',
          input: { city: 'Shanghai' },
          reason: 'outside workspace',
        },
      },
    });
    expect(broker.listPending().map((pending) => pending.request)).toEqual([
      expect.objectContaining({
        id: 'approval-1',
        call,
        runId: 'run-1',
        turnId: 'turn-1',
        startedItemId: 'tool-started-1',
        reason: 'outside workspace',
      }),
    ]);

    const nextEvent = iterator.next();
    await Promise.resolve();
    expect(executed).toBe(false);

    broker.resolve({
      approvalId: 'approval-1',
      threadId: '',
      turnId: 'turn-1',
      decision: { type: 'approveOnce', reason: 'user accepted' },
    });

    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: {
        type: 'approval.resolved',
        request: {
          id: 'approval-1',
          threadId: '',
          turnId: 'turn-1',
          runId: 'run-1',
          toolCallId: 'call-weather-1',
          toolName: 'weather',
          input: { city: 'Shanghai' },
          reason: 'outside workspace',
        },
        decision: {
          type: 'approveOnce',
          reason: 'user accepted',
        },
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'result.completed', content: 'approved result' },
    });
    expect(executed).toBe(true);
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('records approval request and decline as item-compatible tool trace', async () => {
    const items = createItems();
    const assistant = appendAssistantToolCall(items);
    const broker = new ApprovalBroker({
      generateId: () => 'approval-1',
    });
    let executed = false;
    const runtime = new PolicyToolRuntime({
      policy: {
        evaluate() {
          return { type: 'needsApproval', reason: 'network access' };
        },
      },
      approvalBroker: broker,
      toolRuntime: {
        async *execute() {
          executed = true;
          yield { type: 'result.completed', content: 'should not execute' };
        },
      },
    });

    const resultPromise = appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant,
    });

    await waitForPendingApproval(broker, 'approval-1');
    broker.resolve({
      approvalId: 'approval-1',
      threadId: '',
      turnId: 'turn-1',
      decision: { type: 'decline', reason: 'user declined' },
    });

    const result = await resultPromise;

    expect(executed).toBe(false);
    expect(result.completed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(items.getItems().map((item) => item.type)).toEqual([
      'assistant.message.completed',
      'tool.call.started',
      'approval.requested',
      'approval.resolved',
      'tool.error',
    ]);
    expect(
      items
        .getItems()
        .filter((item) => item.type === 'approval.requested' || item.type === 'approval.resolved')
        .map((item) => item.payload)
    ).toEqual([
      expect.objectContaining({
        approvalId: 'approval-1',
        threadId: '',
        turnId: 'turn-1',
        toolCallId: 'call-weather-1',
        toolName: 'weather',
        reason: 'network access',
      }),
      expect.objectContaining({
        approvalId: 'approval-1',
        threadId: '',
        turnId: 'turn-1',
        toolCallId: 'call-weather-1',
        toolName: 'weather',
        decision: 'decline',
        reason: 'user declined',
      }),
    ]);
    expect(result.errors[0]?.payload).toEqual(
      expect.objectContaining({
        message: 'Tool call denied by policy: user declined',
      })
    );
  });
});

describe('AgentLoop approval boundary', () => {
  it('does not expose policy-specific public options', () => {
    expectTypeOf<keyof AgentLoopOptions>().toEqualTypeOf<
      'itemList' | 'model' | 'toolRuntime' | 'contextCompiler' | 'hooks' | 'systemPrompt'
    >();

    expect(
      new AgentLoop({
        itemList: new InMemoryItemList(),
        model: {
          async *generate() {
            yield { type: 'message.completed', content: 'ok' };
          },
        },
      })
    ).toBeInstanceOf(AgentLoop);
  });
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

async function waitForPendingApproval(broker: ApprovalBroker, approvalId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (broker.listPending().some((pending) => pending.request.id === approvalId)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for pending approval: ${approvalId}`);
}

function createCall(): ToolCallPayload {
  return {
    id: 'call-weather-1',
    name: 'weather',
    input: { city: 'Shanghai' },
  };
}

function createContext(): ToolExecutionContext {
  return {
    runId: 'run-1',
    turnId: 'turn-1',
    assistantItem: {
      id: 'assistant-1',
      createdAtMs: 1000,
      seq: 1,
      type: 'assistant.message.completed',
      runId: 'run-1',
      turnId: 'turn-1',
      payload: {},
    },
    startedItem: {
      id: 'tool-started-1',
      createdAtMs: 1001,
      seq: 2,
      type: 'tool.call.started',
      runId: 'run-1',
      turnId: 'turn-1',
      causeId: 'assistant-1',
      payload: {
        toolCallId: 'call-weather-1',
        toolName: 'weather',
      },
    },
  };
}

function createItems(): InMemoryItemList {
  return new InMemoryItemList({
    generateId: (() => {
      let nextId = 0;
      return () => `item-${++nextId}`;
    })(),
    clock: () => 1000,
  });
}

function appendAssistantToolCall(items: InMemoryItemList) {
  return items.append({
    type: 'assistant.message.completed',
    runId: 'run-1',
    turnId: 'turn-1',
    payload: {
      content: 'Checking the weather.',
      toolCalls: [createCall()],
    },
  });
}
