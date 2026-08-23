import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  publishZenXConnectionDescriptor,
  readZenXConnectionDescriptor,
  revokeZenXConnectionDescriptor,
  type ZenXConnectionDescriptor,
} from "../protocol-client/connection-descriptor.js";

export { readZenXConnectionDescriptor as readAppServerConnectionDescriptor };

export class AppServerConnectionPublisher {
  readonly #descriptorFile: string;
  readonly #leaseFile: string;
  #lease: FileHandle | undefined;

  constructor(descriptorFile: string) {
    this.#descriptorFile = descriptorFile;
    this.#leaseFile = `${descriptorFile}.lock`;
  }

  async acquire(options: { reclaimStale?: boolean } = {}): Promise<void> {
    if (this.#lease !== undefined) {
      throw new Error("ZenX App Server connection authority is already owned");
    }
    await mkdir(path.dirname(this.#descriptorFile), {
      recursive: true,
      mode: 0o700,
    });
    if (options.reclaimStale === true) {
      await removeFile(this.#descriptorFile);
      await removeFile(this.#leaseFile);
    }
    try {
      this.#lease = await open(this.#leaseFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `ZenX App Server connection authority is already owned: ${this.#descriptorFile}`,
        );
      }
      throw error;
    }
    await this.#lease.writeFile(`${String(process.pid)}\n`, "utf8");
    await this.#lease.chmod(0o600);
  }

  async publish(descriptor: ZenXConnectionDescriptor): Promise<void> {
    if (this.#lease === undefined) {
      throw new Error("ZenX App Server connection authority is not owned");
    }
    await publishZenXConnectionDescriptor(this.#descriptorFile, descriptor);
  }

  async revoke(): Promise<void> {
    await revokeZenXConnectionDescriptor(this.#descriptorFile);
  }

  async release(): Promise<void> {
    await this.revoke();
    const lease = this.#lease;
    this.#lease = undefined;
    await lease?.close();
    await removeFile(this.#leaseFile);
  }
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
