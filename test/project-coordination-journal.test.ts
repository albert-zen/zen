import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileProjectCoordinationJournal,
  ProjectCoordinationJournalCorruptionError,
  type ProjectCoordinationItem,
} from './test-exports.js';

const prefix = 'zen-agent-app-coordination-';
const roots = new Set<string>();

afterEach(async () => {
  const pending = [...roots];
  roots.clear();
  await Promise.all(pending.map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('FileProjectCoordinationJournal', () => {
  it('serializes append-only records and restores them after restart', async () => {
    const filePath = join(createTempRoot(), 'coordination.jsonl');
    const journal = new FileProjectCoordinationJournal({ filePath });
    await Promise.all([journal.append(item('one', 1)), journal.append(item('two', 2))]);
    await journal.close();

    await expect(new FileProjectCoordinationJournal({ filePath }).replay()).resolves.toEqual([
      item('one', 1),
      item('two', 2),
    ]);
  });

  it('fails closed on malformed or truncated records', async () => {
    const filePath = join(createTempRoot(), 'coordination.jsonl');
    await writeFile(filePath, '{bad}\n', 'utf8');
    await expect(new FileProjectCoordinationJournal({ filePath }).replay()).rejects.toBeInstanceOf(
      ProjectCoordinationJournalCorruptionError
    );
    await writeFile(filePath, JSON.stringify({ version: 1, item: item('one', 1) }), 'utf8');
    await expect(new FileProjectCoordinationJournal({ filePath }).replay()).rejects.toThrow(
      'truncated final record'
    );
  });
});

function item(id: string, seq: number): ProjectCoordinationItem {
  return {
    version: 1,
    id,
    type: 'thread.message.sent',
    projectId: 'project-1',
    createdAtMs: 1000,
    seq,
    sourceThreadId: 'source',
    targetThreadId: 'target',
    messageId: id,
    payload: { content: id },
  };
}

function createTempRoot(): string {
  const parent = resolve(tmpdir());
  const root = resolve(mkdtempSync(join(parent, prefix)));
  if (dirname(root) !== parent || !basename(root).startsWith(prefix)) {
    throw new Error(`Unsafe coordination test temp root: ${root}`);
  }
  roots.add(root);
  return root;
}
