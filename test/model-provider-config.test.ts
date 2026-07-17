import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadModelProviderConfig } from './test-exports.js';

describe('model provider config', () => {
  it('loads a Zen-owned OpenAI-compatible model provider config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-provider-'));
    const path = join(dir, 'model-provider.json');
    writeFileSync(
      path,
      JSON.stringify({
        providerName: 'DashScope',
        baseUrl: 'https://example.test/v1/',
        apiKey: 'test-key',
        model: 'kimi-k2.6',
        displayName: 'Kimi K2.6',
        params: { max_completion_tokens: 1000 },
      }),
      'utf8'
    );

    expect(loadModelProviderConfig({ path })).toEqual({
      providerName: 'DashScope',
      modelId: 'kimi-k2.6',
      displayName: 'Kimi K2.6',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      params: { max_completion_tokens: 1000 },
    });
  });

  it('allows explicit Zen environment variables to provide the model config', () => {
    expect(
      loadModelProviderConfig({
        env: {
          ZEN_MODEL_PROVIDER: 'test-provider',
          ZEN_MODEL_BASE_URL: 'https://provider.test/v1/',
          ZEN_MODEL_API_KEY: 'env-key',
          ZEN_MODEL: 'test-model',
          ZEN_MODEL_PARAMS: JSON.stringify({ temperature: 0 }),
        },
      })
    ).toEqual({
      providerName: 'test-provider',
      modelId: 'test-model',
      displayName: undefined,
      baseUrl: 'https://provider.test/v1',
      apiKey: 'env-key',
      params: { temperature: 0 },
    });
  });
});
