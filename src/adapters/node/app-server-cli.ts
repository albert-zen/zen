#!/usr/bin/env node
import { resolveAgentAppDataRoot } from './app-data-root.js';
import { createAgentAppProductionComposition } from './agent-app-production.js';
import { serveAgentAppHttpTransport } from './agent-app-transport.js';
import { runAgentAppCliComposition } from './production-composition.js';
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

await runAgentAppCliComposition({
  credentialMode,
  signalSource: process,
  createAppServer: async () => {
    const composition = await createAgentAppProductionComposition({
      appDataRoot: resolveAgentAppDataRoot(),
    });
    return {
      request: composition.agentAppServer.request.bind(composition.agentAppServer),
      subscribe: composition.agentAppServer.subscribe.bind(composition.agentAppServer),
      close: composition.close,
    };
  },
  createTransport: async (appServer, capability) =>
    await serveAgentAppHttpTransport({
      allowRemoteBind,
      agentAppServer: appServer as import('../../product/index.js').AgentAppClient,
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
