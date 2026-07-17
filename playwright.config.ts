import { defineConfig } from '@playwright/test';

const ownerMarker = process.env.ZEN_E2E_RUN_MARKER;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    launchOptions: ownerMarker ? { args: [`--zen-e2e-owner=${ownerMarker}`] } : undefined,
  },
});
