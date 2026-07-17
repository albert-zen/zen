import { createServer as createViteServer } from 'vite';

import { serveAppServerHttpTransport } from '../dist/adapters/node/app-server-transport.js';
import { AppServer, PolicyToolRuntime } from '../dist/product/index.js';

export async function startFixtureServer() {
  const progress = new ProgressGate();
  const executedCommands = [];
  const nextThreadId = sequence('thread-e2e');
  const nextRunId = sequence('run-e2e');
  const nextTurnId = sequence('turn-e2e');
  const nextItemId = sequence('item-e2e');
  const appServer = new AppServer({
    threadManagerOptions: {
      generateThreadId: nextThreadId,
      generateRunId: nextRunId,
      generateTurnId: nextTurnId,
      generateItemId: nextItemId,
      clock: (() => {
        let timestamp = 1_000;
        return () => timestamp++;
      })(),
      runtimeFactory: ({ approvalBroker }) => ({
        model: createFixtureModel(progress),
        toolRuntime: new PolicyToolRuntime({
          approvalBroker,
          policy: {
            evaluate: () => ({
              type: 'needsApproval',
              reason: 'Fixture shell command requires approval',
            }),
          },
          toolRuntime: {
            async *execute(call) {
              executedCommands.push(call);
              yield {
                type: 'output.delta',
                delta: { stream: 'stdout', chunk: 'fixture shell executed' },
              };
              yield { type: 'result.completed', content: 'fixture command completed' };
            },
          },
        }),
      }),
    },
  });
  let transport;
  let vite;
  const environment = saveProxyEnvironment();

  try {
    transport = await serveAppServerHttpTransport({ appServer, port: 0 });
    process.env.ZEN_APP_SERVER_URL = transport.url;
    process.env.ZEN_APP_SERVER_CAPABILITY = transport.capability;
    delete process.env.ZEN_APP_SERVER_CAPABILITY_HANDOFF;
    vite = await createViteServer({
      configFile: 'web/vite.config.ts',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true },
    });
    await vite.listen();
  } catch (cause) {
    await closeFixtureResources({ vite, transport, appServer });
    throw cause;
  } finally {
    restoreProxyEnvironment(environment);
  }

  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') {
    await closeFixtureResources({ vite, transport, appServer });
    throw new Error('Vite fixture did not expose a TCP address');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    progress,
    executionCount: () => executedCommands.length,
    async close() {
      await closeFixtureResources({ vite, transport, appServer });
    },
  };
}

export async function closeFixtureResources({ vite, transport, appServer }) {
  const results = await Promise.allSettled([vite?.close(), transport?.close(), appServer?.close()]);
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to close deterministic E2E fixture resources');
  }
}

function createFixtureModel(progress) {
  let callCount = 0;

  return {
    async *generate(context) {
      callCount += 1;
      if (callCount === 1) {
        yield { type: 'text.delta', text: 'Streamed assistant progress' };
        await progress.pause();
        yield {
          type: 'message.completed',
          content: 'Assistant is requesting shell approval',
          toolCalls: [
            {
              id: 'fixture-shell-call',
              name: 'shell',
              input: { command: 'fixture-safe-command' },
            },
          ],
        };
        return;
      }

      const executed = context.parts.some((part) => part.type === 'toolResult');
      yield {
        type: 'message.completed',
        content: executed ? 'Approved command complete' : 'Declined command was not executed',
      };
    },
  };
}

class ProgressGate {
  #pending = [];
  #waiters = [];

  async pause() {
    const deferred = createDeferred();
    this.#pending.push(deferred);
    this.#waiters.shift()?.resolve();
    await deferred.promise;
  }

  async waitForPending() {
    if (this.#pending.length > 0) return;
    const deferred = createDeferred();
    this.#waiters.push(deferred);
    await deferred.promise;
  }

  releaseNext() {
    const deferred = this.#pending.shift();
    if (!deferred) throw new Error('No streamed progress is waiting for release');
    deferred.resolve();
  }
}

function createDeferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function sequence(prefix) {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

function saveProxyEnvironment() {
  return {
    capability: process.env.ZEN_APP_SERVER_CAPABILITY,
    handoff: process.env.ZEN_APP_SERVER_CAPABILITY_HANDOFF,
    url: process.env.ZEN_APP_SERVER_URL,
  };
}

function restoreProxyEnvironment(environment) {
  setEnvironment('ZEN_APP_SERVER_CAPABILITY', environment.capability);
  setEnvironment('ZEN_APP_SERVER_CAPABILITY_HANDOFF', environment.handoff);
  setEnvironment('ZEN_APP_SERVER_URL', environment.url);
}

function setEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
