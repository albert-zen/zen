import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createViteServer } from 'vite';

import {
  createAgentAppProductionComposition,
  serveAgentAppHttpTransport,
} from '../dist/adapters/node/index.js';

/** A real Project-first App Server behind the browser's same-origin proxy. */
export async function startFixtureServer() {
  const root = await mkdtemp(join(tmpdir(), 'zen-agent-app-e2e-'));
  const projectRoot = join(root, 'workspace');
  await mkdir(projectRoot, { recursive: true });
  const execution = [];
  const composition = await createAgentAppProductionComposition({
    appDataRoot: join(root, 'app-data'),
    createModel: () => ({
      async *generate(context) {
        execution.push(context);
        const user = [...context.parts].reverse().find((part) => part.type === 'user');
        yield {
          type: 'message.completed',
          content: `Completed: ${typeof user?.content === 'string' ? user.content : 'thread turn'}`,
        };
      },
    }),
  });
  let transport;
  let vite;
  const environment = saveProxyEnvironment();
  try {
    transport = await serveAgentAppHttpTransport({
      agentAppServer: composition.agentAppServer,
      port: 0,
    });
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
    await closeFixtureResources({ vite, transport, composition, root });
    throw cause;
  } finally {
    restoreProxyEnvironment(environment);
  }
  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') {
    await closeFixtureResources({ vite, transport, composition, root });
    throw new Error('Vite fixture did not expose a TCP address');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    projectRoot,
    executionCount: () => execution.length,
    async request(body) {
      const response = await fetch(new URL('/request', transport.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${transport.capability}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      await closeFixtureResources({ vite, transport, composition, root });
    },
  };
}

export async function closeFixtureResources({ vite, transport, composition, appServer, root }) {
  const results = await Promise.allSettled([
    vite?.close(),
    transport?.close(),
    composition?.close() ?? appServer?.close(),
  ]);
  if (root) await rm(root, { recursive: true, force: true });
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length)
    throw new AggregateError(failures, 'Failed to close deterministic E2E fixture resources');
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
