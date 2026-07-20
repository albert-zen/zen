#!/usr/bin/env node
import { randomInt } from 'node:crypto';
import { join } from 'node:path';

import { HttpAgentAppClient, watchShutdownFile } from '@zen/framework/node';

import { loadImZenConfig } from './config.js';
import { QQGateway } from './qq-gateway.js';
import { ImZenStateStore } from './state-store.js';
import { ImZenBridge } from './zen-bridge.js';

await run().catch((cause: unknown) => {
  console.error(`IMZen startup failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
});

async function run(): Promise<void> {
  const config = await loadImZenConfig();
  const state = await ImZenStateStore.open(join(config.dataDir, 'state.json'));
  const client = new HttpAgentAppClient({
    baseUrl: config.appServerUrl,
    capability: config.appServerCapability,
  });
  const gateway = new QQGateway({
    apiBase: config.qqApiBase,
    credential: config.qqCredential,
  });
  const pairingCode =
    config.allowedUserIds.size === 0 && !state.ownerUserId()
      ? String(randomInt(100_000, 1_000_000))
      : undefined;
  const bridge = new ImZenBridge({
    client,
    config,
    deliver: async (message) => await gateway.send(message),
    pairingCode,
    state,
  });
  const shutdown = signalWaiter();
  const shutdownFileWatcher = watchShutdownFile({
    markerPath: process.env.IMZEN_SHUTDOWN_FILE,
    onShutdown: () => process.emit('SIGTERM'),
  });
  let primaryFailure: unknown;
  let closeFailures: unknown[];

  try {
    await bridge.start();
    if (pairingCode) console.log(`IMZen pairing command: /pair ${pairingCode}`);
    await gateway.start(async (message) => await bridge.accept(message));
    console.log('IMZen connected to QQ and Zen App Server.');
    await shutdown.promise;
  } catch (cause) {
    primaryFailure = cause;
  } finally {
    shutdownFileWatcher.dispose();
    shutdown.dispose();
    const closed = await Promise.allSettled([gateway.stop(), bridge.stop(), client.close()]);
    closeFailures = closed.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
  }
  if (primaryFailure !== undefined && closeFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...closeFailures],
      'IMZen startup/runtime and shutdown failed'
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (closeFailures.length > 0) throw new AggregateError(closeFailures, 'IMZen shutdown failed');
}

function signalWaiter(): { readonly promise: Promise<void>; dispose(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const stop = () => resolvePromise();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    promise,
    dispose() {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    },
  };
}
