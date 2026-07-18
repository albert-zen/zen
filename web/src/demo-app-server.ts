import type {
  AppServerClient,
  AppServerNotificationListener,
  AppServerSubscription,
  AppServerRequestInput,
} from '#zen/product';
import type { AppServerResponse, ProtocolItem, ThreadSnapshot, TurnSnapshot } from '#zen/product';

export function createBrowserDemoAppServer(): AppServerClient {
  let activeThreadId: string | undefined;
  let nextThread = 1;
  let nextRun = 1;
  let nextTurn = 1;
  let nextItem = 1;
  const threadsById = new Map<string, MutableThread>();
  const listeners = new Set<AppServerNotificationListener>();

  seedThread(
    'Map the item-first kernel',
    'The UI should make item append order visible without making trace rows dominate.'
  );
  seedThread(
    'Run a shell smoke test',
    'The shell workbench row should collapse noisy output but keep stdout easy to inspect.'
  );

  return {
    subscribe(listener): AppServerSubscription {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(request: AppServerRequestInput): Promise<AppServerResponse> {
      if (request.method === 'thread/start') {
        const thread = startThread();
        return { method: 'thread/start', ok: true, result: { thread: snapshot(thread.id) } };
      }

      if (request.method === 'thread/list') {
        return {
          method: 'thread/list',
          ok: true,
          result: {
            threads: [...threadsById.keys()].map((id) => snapshot(id)),
            persistenceFailures: [],
          },
        };
      }

      if (request.method === 'thread/read') {
        const params = readParams(request.params);
        activeThreadId = readString(params, 'threadId');
        return {
          method: 'thread/read',
          ok: true,
          result: { thread: snapshot(activeThreadId) },
        };
      }

      if (request.method === 'turn/start') {
        const params = readParams(request.params);
        activeThreadId = readString(params, 'threadId');
        await runTurn(String(params.input ?? ''));
        return {
          method: 'turn/start',
          ok: true,
          result: { turn: cloneTurn(thread().turns.at(-1) ?? emptyTurn()) },
        };
      }

      if (request.method === 'turn/interrupt') {
        return {
          method: 'turn/interrupt',
          ok: true,
          result: { turn: cloneTurn(thread().turns.at(-1) ?? emptyTurn()) },
        };
      }

      if (request.method === 'turn/retry') {
        await runTurn('Retry the previous request');
        return {
          method: 'turn/retry',
          ok: true,
          result: { turn: cloneTurn(thread().turns.at(-1) ?? emptyTurn()) },
        };
      }

      return {
        method: request.method,
        ok: false,
        error: { code: 'UNKNOWN_METHOD', message: `Unknown method ${request.method}` },
      };
    },
  };

  function seedThread(user: string, assistant: string): void {
    const seeded = startThread(false);
    const turn = newTurn();
    seeded.turns.push(turn);
    append('run.started', turn, {}, seeded);
    append('turn.started', turn, {}, seeded);
    append('user.message.completed', turn, { content: user }, seeded);
    append('assistant.message.completed', turn, { content: assistant }, seeded);
    append('turn.completed', turn, { status: 'completed' }, seeded);
    append('run.completed', turn, { status: 'completed' }, seeded);
    turn.status = 'completed';
    seeded.status = 'idle';
  }

  function startThread(emitStarted = true): MutableThread {
    const current: MutableThread = {
      id: `demo-thread-${nextThread++}`,
      status: 'idle',
      turns: [],
      items: [],
    };
    threadsById.set(current.id, current);
    activeThreadId = current.id;
    if (emitStarted) {
      emit({ type: 'thread/started', thread: snapshot(current.id) });
    }
    return current;
  }

  async function runTurn(input: string): Promise<void> {
    const current = thread();
    const turn = newTurn();
    current.status = 'running';
    current.turns.push(turn);
    emit({ type: 'turn/started', threadId: current.id, turn: cloneTurn(turn) });

    append('run.started', turn, {});
    append('turn.started', turn, {});
    append('user.message.completed', turn, { content: input });
    append('model.request.started', turn, { contextPartCount: current.items.length });

    if (input.toLowerCase().includes('shell')) {
      append('assistant.message.completed', turn, { content: 'Running a demo shell command.' });
      append('model.request.completed', turn, { status: 'completed' });
      const shell = append('tool.call.started', turn, {
        toolCallId: 'demo-shell',
        toolName: 'shell',
        input: { command: 'echo zen' },
      });
      append(
        'tool.result.completed',
        turn,
        {
          toolCallId: 'demo-shell',
          toolName: 'shell',
          content: { exitCode: 0, stdout: 'zen\n', stderr: '' },
        },
        current,
        shell.id
      );
      append('assistant.message.completed', turn, {
        content: 'The demo shell command completed.',
      });
      completeTurn(turn);
      return;
    }

    append('assistant.message.completed', turn, { content: `Demo response to: ${input}` });
    append('model.request.completed', turn, { status: 'completed' });
    completeTurn(turn);
  }

  function completeTurn(turn: MutableTurn): void {
    append('turn.completed', turn, { status: 'completed' });
    append('run.completed', turn, { status: 'completed' });
    turn.status = 'completed';
    thread().status = 'idle';
    emit({ type: 'turn/completed', threadId: thread().id, turn: cloneTurn(turn) });
  }

  function append(
    type: string,
    turn: MutableTurn,
    payload: ProtocolItem['payload'],
    targetThread = thread(),
    targetId?: string
  ): ProtocolItem {
    const item: ProtocolItem = {
      id: `demo-item-${nextItem++}`,
      type,
      createdAtMs: Date.now(),
      seq: targetThread.items.length + 1,
      runId: turn.runId,
      turnId: turn.id,
      targetId,
      payload,
    };
    targetThread.items.push(item);
    turn.itemIds.push(item.id);
    if (targetThread.id === activeThreadId) {
      emit({ type: 'item/appended', threadId: targetThread.id, turnId: turn.id, item });
    }
    return item;
  }

  function newTurn(): MutableTurn {
    return {
      id: `demo-turn-${nextTurn++}`,
      runId: `demo-run-${nextRun++}`,
      status: 'inProgress',
      itemIds: [],
    };
  }

  function emptyTurn(): MutableTurn {
    return {
      id: 'demo-turn-empty',
      runId: 'demo-run-empty',
      status: 'canceled',
      itemIds: [],
    };
  }

  function thread(): MutableThread {
    if (!activeThreadId || !threadsById.has(activeThreadId)) {
      return startThread(false);
    }
    return threadsById.get(activeThreadId)!;
  }

  function snapshot(threadId: string): ThreadSnapshot {
    const current = threadsById.get(threadId);
    if (!current) {
      throw new Error(`Unknown demo thread ${threadId}`);
    }
    return {
      id: current.id,
      status: current.status,
      turns: current.turns.map(cloneTurn),
      items: current.items.map((item) => structuredClone(item)),
    };
  }

  function emit(notification: Parameters<AppServerNotificationListener>[0]): void {
    listeners.forEach((listener) => listener(notification));
  }
}

type MutableThread = {
  id: string;
  status: ThreadSnapshot['status'];
  turns: MutableTurn[];
  items: ProtocolItem[];
};

type MutableTurn = {
  id: string;
  runId: string;
  status: TurnSnapshot['status'];
  itemIds: string[];
};

function cloneTurn(turn: MutableTurn): TurnSnapshot {
  return {
    ...turn,
    itemIds: [...turn.itemIds],
  };
}

function readParams(params: unknown): Readonly<Record<string, unknown>> {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Readonly<Record<string, unknown>>)
    : {};
}

function readString(params: Readonly<Record<string, unknown>>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing ${key}`);
  }
  return value;
}
