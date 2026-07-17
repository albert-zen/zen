#!/usr/bin/env node
import { createProviderBackedAppServer } from './provider-runtime.js';
import { serveAppServerHttpTransport } from './app-server-transport.js';
import {
  cleanupPublishedAppServerClientHandoff,
  DEFAULT_APP_SERVER_HOST,
  publishAppServerClientHandoff,
  readAppServerPort,
  readAppServerCredentialMode,
  readRemoteBindOptIn,
  type PublishedAppServerClientHandoff,
} from './app-server-config.js';

const host = process.env.ZEN_APP_SERVER_HOST ?? DEFAULT_APP_SERVER_HOST;
const port = readAppServerPort(process.env.ZEN_APP_SERVER_PORT);
const credentialMode = readAppServerCredentialMode(process.env);
const allowRemoteBind = readRemoteBindOptIn(
  process.env.ZEN_APP_SERVER_ALLOW_REMOTE,
  'ZEN_APP_SERVER_ALLOW_REMOTE'
);

const server = await createProviderBackedAppServer({ cwd: process.cwd() });
const transport = await serveAppServerHttpTransport({
  allowRemoteBind,
  appServer: server,
  capability: credentialMode.type === 'provided' ? credentialMode.capability : undefined,
  host,
  port,
});
let publishedHandoff: PublishedAppServerClientHandoff | undefined;

try {
  if (credentialMode.type === 'handoff') {
    publishedHandoff = await publishAppServerClientHandoff(credentialMode.directory, {
      baseUrl: transport.url,
      capability: transport.capability,
    });
    console.log(`Zen App Server capability handoff: ${publishedHandoff.path}`);
  }

  console.log(`Zen App Server listening at ${transport.url}`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      process.off('message', shutdownFromParent);
      resolve();
    };
    const shutdownFromParent = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'shutdown'
      ) {
        shutdown();
      }
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.on('message', shutdownFromParent);
  });
} finally {
  if (publishedHandoff) {
    await cleanupPublishedAppServerClientHandoff(publishedHandoff);
  }

  await transport.close();
}
