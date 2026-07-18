// Test-only aggregation keeps production boundaries explicit while allowing
// existing characterization tests to exercise composed product behavior.
export * from '../src/kernel/index.js';
export * from '../src/product/index.js';
export * from '../src/adapters/node/index.js';
export * from '../src/presentation/index.js';
export * from '../src/tui/index.js';
// Legacy runtime characterization tests remain internal-only during protocol
// migration; no package entry point re-exports these symbols.
export * from '../src/product/app-server.js';
export * from '../src/product/app-server-protocol.js';
export * from '../src/product/demo-runtime.js';
export * from '../src/adapters/node/app-server-transport.js';
export * from '../src/adapters/node/provider-runtime.js';
