#!/usr/bin/env node
import { createProviderBackedAppServer } from './provider-runtime.js';
import { serveAppServerHttpTransport } from './app-server-transport.js';
import { runAppServerCliComposition } from './production-composition.js';
import {
  cleanupPublishedAppServerClientHandoff,
  DEFAULT_APP_SERVER_HOST,
  publishAppServerClientHandoff,
  readAppServerPort,
  readAppServerCredentialMode,
  readRemoteBindOptIn,
} from './app-server-config.js';

const host = process.env.ZEN_APP_SERVER_HOST ?? DEFAULT_APP_SERVER_HOST;
const port = readAppServerPort(process.env.ZEN_APP_SERVER_PORT);
const credentialMode = readAppServerCredentialMode(process.env);
const allowRemoteBind = readRemoteBindOptIn(
  process.env.ZEN_APP_SERVER_ALLOW_REMOTE,
  'ZEN_APP_SERVER_ALLOW_REMOTE'
);

await runAppServerCliComposition({
  credentialMode,
  signalSource: process,
  createAppServer: async () => await createProviderBackedAppServer({ cwd: process.cwd() }),
  createTransport: async (appServer, capability) =>
    await serveAppServerHttpTransport({
      allowRemoteBind,
      appServer,
      capability,
      host,
      port,
    }),
  publishHandoff: publishAppServerClientHandoff,
  cleanupHandoff: cleanupPublishedAppServerClientHandoff,
  onHandoffPublished: (handoff) => {
    console.log(`Zen App Server capability handoff: ${handoff.path}`);
  },
  onListening: (transport) => {
    console.log(`Zen App Server listening at ${transport.url}`);
  },
});
