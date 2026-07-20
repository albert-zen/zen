import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentAppProductionComposition } from '@zen/framework/node';

export type AgentAppBootstrapAcceptance = {
  readonly status: 'passed';
  readonly fixturePath: string;
  readonly projectId: string;
  readonly threadId: string;
};

/**
 * A provider-independent product acceptance. It validates the durable
 * Project -> Thread bootstrap path without reviving the retired single-thread
 * AppServer protocol or treating missing credentials as a test skip.
 */
export async function runDogfoodAcceptanceScenario(input: {
  readonly evidencePath: string;
  readonly fixtureRoot?: string;
  readonly now?: () => Date;
}): Promise<AgentAppBootstrapAcceptance> {
  const fixturePath = await mkdtemp(join(input.fixtureRoot ?? tmpdir(), 'zen-agent-app-'));
  const appDataRoot = join(fixturePath, '.zen');
  await mkdir(appDataRoot, { recursive: true });
  const composition = await createAgentAppProductionComposition({ appDataRoot });
  try {
    const project = await composition.agentAppServer.request({
      method: 'project/create',
      params: {
        name: 'Agent App acceptance',
        rootPath: fixturePath,
        idempotencyKey: 'acceptance-project',
      },
    });
    if (!project.ok) throw new Error(project.error.message);
    const projectId = readId(project.result, 'project');
    const thread = await composition.agentAppServer.request({
      method: 'thread/create',
      params: {
        projectId,
        objective: 'Validate Agent App bootstrap',
        idempotencyKey: 'acceptance-thread',
      },
    });
    if (!thread.ok) throw new Error(thread.error.message);
    const threadId = readId(thread.result, 'thread');
    await writeFile(
      input.evidencePath,
      [
        '# Agent App Bootstrap Acceptance',
        '',
        'Status: passed',
        `Timestamp: ${(input.now ?? (() => new Date()))().toISOString()}`,
        `Project: ${projectId}`,
        `Thread: ${threadId}`,
        `Fixture: ${fixturePath}`,
        '',
        'Validated the current Project-first Agent App protocol: project/create then thread/create.',
        '',
      ].join('\n'),
      'utf8'
    );
    return { status: 'passed', fixturePath, projectId, threadId };
  } finally {
    await composition.close();
  }
}

function readId(result: Readonly<Record<string, unknown>>, key: 'project' | 'thread'): string {
  const value = result[key];
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string'
  ) {
    throw new Error(`Missing ${key} id from Agent App response`);
  }
  return value.id;
}
