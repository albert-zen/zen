import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ProjectCommandRecord, ProjectCommandStore } from '../../product/index.js';

const STORE_VERSION = 1;

export type ProjectCommandStoreFileSystem = {
  mkdir(path: string, options: { readonly recursive: true }): Promise<string | undefined>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(
    path: string,
    contents: string,
    options: { readonly encoding: BufferEncoding; readonly flag: 'wx' }
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
};

export class FileProjectCommandStore implements ProjectCommandStore {
  private sequence = 0;
  constructor(
    private readonly filePath: string,
    private readonly fileSystem: ProjectCommandStoreFileSystem = nodeFileSystem
  ) {}

  async load(): Promise<readonly ProjectCommandRecord[]> {
    let text: string;
    try {
      text = await this.fileSystem.readFile(this.filePath, 'utf8');
    } catch (cause) {
      if (isMissing(cause)) return [];
      throw cause;
    }
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.version !== STORE_VERSION || !Array.isArray(value.commands)) {
      throw new Error(`Invalid Agent App command store: ${this.filePath}`);
    }
    return structuredClone(value.commands) as readonly ProjectCommandRecord[];
  }

  async save(records: readonly ProjectCommandRecord[]): Promise<void> {
    const temporary = `${this.filePath}.tmp-${process.pid}-${++this.sequence}`;
    await this.fileSystem.mkdir(dirname(this.filePath), { recursive: true });
    try {
      await this.fileSystem.writeFile(
        temporary,
        JSON.stringify({ version: STORE_VERSION, commands: records }),
        { encoding: 'utf8', flag: 'wx' }
      );
      await this.fileSystem.rename(temporary, this.filePath);
    } catch (cause) {
      await this.fileSystem.unlink(temporary).catch(() => undefined);
      throw cause;
    }
  }
}

const nodeFileSystem: ProjectCommandStoreFileSystem = {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(cause: unknown): boolean {
  return isRecord(cause) && cause.code === 'ENOENT';
}
