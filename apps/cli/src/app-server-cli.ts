#!/usr/bin/env node
import {
  cleanupPublishedAppServerClientHandoff,
  createAgentAppProductionComposition,
  DEFAULT_APP_SERVER_HOST,
  publishAppServerClientHandoff,
  readAppServerCredentialMode,
  readAppServerPort,
  readRemoteBindOptIn,
  resolveAgentAppDataRoot,
  runAgentAppCliComposition,
  serveAgentAppHttpTransport,
  watchShutdownFile,
} from '@zen/framework/node';
import type { AgentAppClient } from '@zen/framework/product';

const host = process.env.ZEN_APP_SERVER_HOST ?? DEFAULT_APP_SERVER_HOST;
const port = readAppServerPort(process.env.ZEN_APP_SERVER_PORT);
const credentialMode = readAppServerCredentialMode(process.env);
const allowRemoteBind = readRemoteBindOptIn(
  process.env.ZEN_APP_SERVER_ALLOW_REMOTE,
  'ZEN_APP_SERVER_ALLOW_REMOTE'
);

const shutdownFileWatcher = watchShutdownFile({
  markerPath: process.env.ZEN_APP_SERVER_SHUTDOWN_FILE,
  onShutdown: () => process.emit('SIGTERM'),
});

try {
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
        agentAppServer: appServer as AgentAppClient,
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
} finally {
  shutdownFileWatcher.dispose();
}
