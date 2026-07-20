// Test-only aggregation keeps production boundaries explicit while allowing
// existing characterization tests to exercise composed product behavior.
export * from '../packages/framework/src/kernel/index.js';
export * from '../packages/framework/src/product/index.js';
export * from '../packages/framework/src/adapters/node/index.js';
export * from '../packages/framework/src/presentation/index.js';
// Legacy runtime characterization tests remain internal-only during protocol
// migration; no package entry point re-exports these symbols.
export * from '../packages/framework/src/product/app-server.js';
export * from '../packages/framework/src/product/app-server-protocol.js';
export * from '../packages/framework/src/adapters/node/app-server-transport.js';
export * from '../packages/framework/src/adapters/node/provider-runtime.js';
