import { defineConfig } from 'vitest/config';

const coverageGroup = process.env.COVERAGE_GROUP;
const coverageGroups = new Set(['kernel', 'product', 'presentation']);

if (coverageGroup !== undefined && !coverageGroups.has(coverageGroup)) {
  throw new Error(`Unknown coverage group: ${coverageGroup}`);
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'test/**/*.test.mjs'],
    fileParallelism: false,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: coverageGroup ? [`src/${coverageGroup}/**/*.ts`] : undefined,
      exclude: [
        'src/**/index.ts',
        'src/**/*.d.ts',
        'src/adapters/**',
        'src/tui/**',
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
