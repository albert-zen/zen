import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, createServer as createViteServer } from 'vite';

import {
  AppServer,
  type AppServerClient,
  serveAppServerHttpTransport,
  type ModelGateway,
} from './test-exports.js';
import { publishAppServerClientHandoff } from '../packages/framework/src/adapters/node/app-server-config.js';

describe('Web development App Server proxy', () => {
  it('keeps the capability out of DEBUG=vite:config subprocess output', async () => {
    const appServer = new AppServer({
      threadManagerOptions: {
        generateThreadId: () => 'debug-thread',
        generateRunId: () => 'debug-run',
        generateTurnId: () => 'debug-turn',
        generateItemId: () => 'debug-item',
        clock: () => 1000,
        runtimeFactory: () => ({
          model: {
            async *generate() {
              yield { type: 'message.completed', content: 'unused' };
            },
          } satisfies ModelGateway,
        }),
      },
    });
    const proxy = await startDebugProxySubprocess(appServer);

    try {
      const response = await fetch(new URL('/request', proxy.browserOrigin), {
        method: 'POST',
        headers: {
          origin: proxy.browserOrigin,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'thread/start' }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ method: 'thread/start', ok: true })
      );
    } finally {
      await proxy.close();
    }

    expect(proxy.output()).toContain('vite:config');
    expect(proxy.output()).not.toContain(proxy.capability);
  }, 30_000);

  it('injects the capability for same-origin requests and event streams', async () => {
    const appServer = new AppServer({
      threadManagerOptions: {
        generateThreadId: () => 'thread-1',
        generateRunId: () => 'run-1',
        generateTurnId: () => 'turn-1',
        generateItemId: () => 'item-1',
        clock: () => 1000,
        runtimeFactory: () => ({
          model: {
            async *generate() {
              yield { type: 'message.completed', content: 'unused' };
            },
          } satisfies ModelGateway,
        }),
      },
    });
    const proxy = await startProxy(appServer);

    try {
      const eventResponse = await fetch(new URL('/events', proxy.browserOrigin), {
        headers: {
          origin: proxy.browserOrigin,
          'sec-fetch-site': 'same-origin',
        },
      });

      expect(eventResponse.status).toBe(200);
      expect(eventResponse.headers.get('access-control-allow-origin')).toBeNull();

      const notificationPromise = readSseNotification(eventResponse);
      const requestResponse = await fetch(new URL('/request', proxy.browserOrigin), {
        method: 'POST',
        headers: {
          origin: proxy.browserOrigin,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'thread/start' }),
      });

      expect(requestResponse.status).toBe(200);
      await expect(requestResponse.json()).resolves.toEqual(
        expect.objectContaining({ method: 'thread/start', ok: true })
      );
      await expect(notificationPromise).resolves.toEqual(
        expect.objectContaining({
          type: 'thread/started',
          thread: expect.objectContaining({ id: 'thread-1' }),
        })
      );
      expect(proxy.logs.length).toBeGreaterThan(0);
      expect(proxy.logs.join('\n')).not.toContain(proxy.capability);
    } finally {
      await proxy.close();
    }
  });

  it('rejects foreign, cross-site, and preflight traffic before App Server dispatch', async () => {
    let requestCount = 0;
    let subscriptionCount = 0;
    const appServer = {
      async request() {
        requestCount += 1;
        throw new Error('request reached App Server');
      },
      subscribe() {
        subscriptionCount += 1;
        return () => undefined;
      },
    } satisfies AppServerClient;
    const proxy = await startProxy(appServer);
    const transportSubscriptionCount = subscriptionCount;

    try {
      const cases: readonly {
        readonly path: string;
        readonly init: RequestInit;
      }[] = [
        {
          path: '/request',
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method: 'thread/start' }),
          },
        },
        {
          path: '/request',
          init: {
            method: 'POST',
            headers: {
              origin: 'https://foreign.example',
              'sec-fetch-site': 'same-origin',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ method: 'thread/start' }),
          },
        },
        {
          path: '/events',
          init: {},
        },
        {
          path: '/request',
          init: {
            method: 'POST',
            headers: {
              origin: proxy.browserOrigin,
              'sec-fetch-site': 'cross-site',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ method: 'thread/start' }),
          },
        },
        {
          path: '/request',
          init: {
            method: 'OPTIONS',
            headers: {
              origin: proxy.browserOrigin,
              'sec-fetch-site': 'same-origin',
              'access-control-request-method': 'POST',
            },
          },
        },
        {
          path: '/events',
          init: {
            headers: {
              origin: 'https://foreign.example',
              'sec-fetch-site': 'cross-site',
            },
          },
        },
      ];

      for (const testCase of cases) {
        const response = await fetch(new URL(testCase.path, proxy.browserOrigin), testCase.init);

        expect(response.status).toBe(403);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
        await expect(response.json()).resolves.toEqual({
          error: 'Forbidden proxy request',
        });
      }

      expect(requestCount).toBe(0);
      expect(transportSubscriptionCount).toBe(1);
      expect(subscriptionCount).toBe(transportSubscriptionCount);
    } finally {
      await proxy.close();
    }
  });

  it('rejects conflicting external proxy credential modes without claiming the handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-web-proxy-modes-'));
    const published = await publishAppServerClientHandoff(root, {
      baseUrl: 'http://127.0.0.1:3000',
      capability: 'handoff-capability-0123456789-abcdef-0123456789',
    });
    const previousCapability = process.env.ZEN_APP_SERVER_CAPABILITY;
    const previousHandoffPath = process.env.ZEN_APP_SERVER_CAPABILITY_HANDOFF;
    process.env.ZEN_APP_SERVER_CAPABILITY = 'provided-capability-0123456789-abcdef-0123456789';
    process.env.ZEN_APP_SERVER_CAPABILITY_HANDOFF = published.path;

    try {
      await expect(
        createViteServer({
          configFile: 'apps/web/vite.config.ts',
          logLevel: 'silent',
        })
      ).rejects.toThrow(
        'Set exactly one of ZEN_APP_SERVER_CAPABILITY or ZEN_APP_SERVER_CAPABILITY_HANDOFF'
      );
      await expect(readFile(published.path, 'utf8')).resolves.toContain(published.ownershipMarker);
    } finally {
      restoreEnvironment(previousCapability, previousHandoffPath);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function startDebugProxySubprocess(appServer: AppServerClient): Promise<{
  readonly browserOrigin: string;
  readonly capability: string;
  output(): string;
  close(): Promise<void>;
}> {
  const transport = await serveAppServerHttpTransport({ appServer });
  const root = await mkdtemp(join(tmpdir(), 'zen-web-debug-proxy-'));
  const published = await publishAppServerClientHandoff(root, {
    baseUrl: transport.url,
    capability: transport.capability,
  });
  const port = await reservePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEBUG: 'vite:config',
    ZEN_APP_SERVER_CAPABILITY_HANDOFF: published.path,
  };
  delete env.ZEN_APP_SERVER_CAPABILITY;
  let output = '';
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js'),
      '--config',
      'apps/web/vite.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: process.cwd(),
      env,
      stdio: 'pipe',
    }
  );
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });

  try {
    await waitForViteReady(child, () => output, port);
  } catch (cause) {
    if (child.exitCode === null) {
      child.kill();
      await waitForChildExit(child).catch(() => undefined);
    }
    await transport.close();
    await rm(root, { recursive: true, force: true });
    throw cause;
  }

  return {
    browserOrigin: `http://127.0.0.1:${port}`,
    capability: transport.capability,
    output: () => output,
    async close() {
      if (child.exitCode === null) {
        child.kill();
        await waitForChildExit(child);
      }
      await transport.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => (cause ? reject(cause) : resolve()));
  });
  return port;
}

async function waitForViteReady(
  child: ChildProcess,
  output: () => string,
  port: number
): Promise<void> {
  const readyPattern = new RegExp(`Local[\\s\\S]*?http://127\\.0\\.0\\.1:[\\s\\S]*?${port}`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        finish(new Error(`Timed out waiting for Vite readiness output: ${output().slice(-1_000)}`)),
      10_000
    );
    const onOutput = () => {
      if (readyPattern.test(output())) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Vite exited before readiness (code ${code}, signal ${signal})`));
    };
    const finish = (cause?: Error) => {
      clearTimeout(timeout);
      child.stdout?.off('data', onOutput);
      child.stderr?.off('data', onOutput);
      child.off('exit', onExit);
      if (cause) reject(cause);
      else resolve();
    };

    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.once('exit', onExit);
    onOutput();
  });
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for Vite subprocess exit')),
      5_000
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function startProxy(appServer: AppServerClient): Promise<{
  readonly browserOrigin: string;
  readonly capability: string;
  readonly logs: readonly string[];
  close(): Promise<void>;
}> {
  const transport = await serveAppServerHttpTransport({ appServer });
  const root = await mkdtemp(join(tmpdir(), 'zen-web-proxy-'));
  const previousCapability = process.env.ZEN_APP_SERVER_CAPABILITY;
  const previousHandoffPath = process.env.ZEN_APP_SERVER_CAPABILITY_HANDOFF;
  const logs: string[] = [];
  const logger = createLogger('info', { allowClearScreen: false });
  logger.info = (message) => logs.push(message);
  logger.warn = (message) => logs.push(message);
  logger.warnOnce = (message) => logs.push(message);
  logger.error = (message) => logs.push(message);
  logger.clearScreen = () => undefined;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;

  try {
    const published = await publishAppServerClientHandoff(root, {
      baseUrl: transport.url,
      capability: transport.capability,
    });
    delete process.env.ZEN_APP_SERVER_CAPABILITY;
    process.env.ZEN_APP_SERVER_CAPABILITY_HANDOFF = published.path;
    vite = await createViteServer({
      configFile: 'apps/web/vite.config.ts',
      customLogger: logger,
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
      },
    });
    restoreEnvironment(previousCapability, previousHandoffPath);
    await vite.listen();
    vite.printUrls();
    const address = vite.httpServer?.address() as AddressInfo;

    return {
      browserOrigin: `http://127.0.0.1:${address.port}`,
      capability: transport.capability,
      logs,
      async close() {
        await vite?.close();
        await transport.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    restoreEnvironment(previousCapability, previousHandoffPath);
    await vite?.close();
    await transport.close();
    await rm(root, { recursive: true, force: true });
    throw cause;
  }
}

function restoreEnvironment(capability: string | undefined, handoffPath: string | undefined): void {
  if (capability === undefined) {
    delete process.env.ZEN_APP_SERVER_CAPABILITY;
  } else {
    process.env.ZEN_APP_SERVER_CAPABILITY = capability;
  }

  if (handoffPath === undefined) {
    delete process.env.ZEN_APP_SERVER_CAPABILITY_HANDOFF;
  } else {
    process.env.ZEN_APP_SERVER_CAPABILITY_HANDOFF = handoffPath;
  }
}

async function readSseNotification(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new Error('Proxy event stream did not include a body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const result = await reader.read();

      if (result.done) {
        throw new Error('Proxy event stream ended before a notification');
      }

      buffer += decoder.decode(result.value, { stream: true }).replaceAll('\r\n', '\n');
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
        const eventType = event
          .split('\n')
          .find((line) => line.startsWith('event:'))
          ?.slice('event:'.length)
          .trim();
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trimStart())
          .join('\n');

        if (eventType === 'notification' && data) {
          return JSON.parse(data) as unknown;
        }
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
