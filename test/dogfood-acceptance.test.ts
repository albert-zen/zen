import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runDogfoodAcceptanceScenario } from '../acceptance/dogfood-acceptance.js';

describe('Agent App bootstrap acceptance', () => {
  it('creates a durable project and parent thread through the current protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-agent-app-acceptance-'));
    const evidencePath = join(root, 'evidence.md');
    try {
      const result = await runDogfoodAcceptanceScenario({
        evidencePath,
        fixtureRoot: root,
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      });

      expect(result.status).toBe('passed');
      expect(result.fixturePath.startsWith(root)).toBe(true);
      expect(result.projectId).toBeTruthy();
      expect(result.threadId).toBeTruthy();
      expect(readFileSync(evidencePath, 'utf8')).toContain('project/create then thread/create');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
