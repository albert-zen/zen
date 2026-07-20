import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const coverageGroup = process.env.COVERAGE_GROUP;
const coverageGroups = new Set(['kernel', 'product', 'presentation']);

if (coverageGroup !== undefined && !coverageGroups.has(coverageGroup)) {
  throw new Error(`Unknown coverage group: ${coverageGroup}`);
}

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@zen/framework/node',
        replacement: fileURLToPath(
          new URL('./packages/framework/src/adapters/node/index.ts', import.meta.url)
        ),
      },
      {
        find: '@zen/framework/presentation',
        replacement: fileURLToPath(
          new URL('./packages/framework/src/presentation/index.ts', import.meta.url)
        ),
      },
      {
        find: '@zen/framework/product',
        replacement: fileURLToPath(
          new URL('./packages/framework/src/product/index.ts', import.meta.url)
        ),
      },
      {
        find: '@zen/framework',
        replacement: fileURLToPath(
          new URL('./packages/framework/src/kernel/index.ts', import.meta.url)
        ),
      },
    ],
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'test/**/*.test.mjs'],
    fileParallelism: false,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: coverageGroup ? [`packages/framework/src/${coverageGroup}/**/*.ts`] : undefined,
      exclude: [
        'packages/framework/src/**/index.ts',
        'packages/framework/src/**/*.d.ts',
        'packages/framework/src/adapters/**',
        'test/**',
        'acceptance/**',
      ],
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: coverageGroup ? `coverage/${coverageGroup}` : 'coverage',
      thresholds: coverageGroup
        ? {
            lines: 85,
            functions: 85,
            statements: 85,
            branches: 80,
          }
        : undefined,
    },
  },
});
