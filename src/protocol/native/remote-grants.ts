import {
  readFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface RemoteDeviceGrant {
  deviceId: string;
  digest: string;
  revoked: boolean;
  access?: "read" | "control" | undefined;
  shellEnabled?: boolean;
  toolsEnabled?: boolean;
  workspaceIds: string[] | null;
}
/** Host-owned authorization configuration, never a conversation journal. */
export class RemoteGrantFile {
  constructor(
    readonly file: string,
    readonly hostId: string,
  ) {}
  read(): RemoteDeviceGrant[] {
    try {
      const stat = lstatSync(this.file);
      if (
        !stat.isFile() ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
        stat.size > 256 * 1024
      )
        throw new Error("Remote grants require a private regular file");
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Object.keys(data).some(
          (key) => !["version", "hostId", "devices"].includes(key),
        ) ||
        data.version !== 1 ||
        data.hostId !== this.hostId ||
        !Array.isArray(data.devices) ||
        data.devices.length > 128
      )
        throw new Error("Invalid remote grant file");
      const ids = new Set<string>();
      for (const grant of data.devices) {
        if (
          !grant ||
          typeof grant !== "object" ||
          Array.isArray(grant) ||
          Object.keys(grant).some(
            (key) =>
              ![
                "deviceId",
                "digest",
                "revoked",
                "access",
                "workspaceIds",
                "shellEnabled",
                "toolsEnabled",
              ].includes(key),
          ) ||
          typeof grant.deviceId !== "string" ||
          !grant.deviceId ||
          grant.deviceId.length > 512 ||
          ids.has(grant.deviceId) ||
          typeof grant.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(grant.digest) ||
          typeof grant.revoked !== "boolean" ||
          (grant.access !== undefined &&
            grant.access !== "read" &&
            grant.access !== "control") ||
          (grant.shellEnabled !== undefined &&
            typeof grant.shellEnabled !== "boolean") ||
          (grant.toolsEnabled !== undefined &&
            (typeof grant.toolsEnabled !== "boolean" ||
              (grant.toolsEnabled && grant.access !== "control"))) ||
          (grant.workspaceIds !== null &&
            (!Array.isArray(grant.workspaceIds) ||
              grant.workspaceIds.length > 32 ||
              grant.workspaceIds.some(
                (id: unknown) =>
                  typeof id !== "string" || !id || id.length > 512,
              )))
        )
          throw new Error("Invalid remote device grant");
        ids.add(grant.deviceId);
      }
      return data.devices;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  write(devices: RemoteDeviceGrant[]): void {
    if (devices.length > 128) throw new Error("Remote device limit reached");
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(
        fd,
        JSON.stringify({ version: 1, hostId: this.hostId, devices }) + "\n",
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }
}
