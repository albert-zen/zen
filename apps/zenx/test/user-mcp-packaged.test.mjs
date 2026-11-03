import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveConfig } from "electron-vite";
import { build } from "vite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BUNDLED_MCP_LICENSE_PACKAGES } from "../scripts/package-zenx-portable.mjs";
import { stageStorageWriter } from "../scripts/stage-storage-writer.mjs";
import { createLiveUserMcpHost } from "./fixtures/live-user-mcp-host.js";

const run = promisify(execFile);

test(
  "normal main build bundles the MCP closure and runs outside repository dependencies",
  { timeout: 120_000 },
  async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "zen-mcp-packaged-"),
    );
    const repository = fileURLToPath(new URL("../../../", import.meta.url));
    const app = path.join(temporary, "app");
    const main = path.join(app, "out", "main");
    const previousCwd = process.cwd();
    let host;
    let client;
    try {
      // electron-vite resolves dependency externalization from its package cwd.
      process.chdir(fileURLToPath(new URL("../", import.meta.url)));
      const resolved = await resolveConfig(
        {
          root: fileURLToPath(new URL("../", import.meta.url)),
          configFile: fileURLToPath(
            new URL("../electron.vite.config.ts", import.meta.url),
          ),
          logLevel: "silent",
        },
        "build",
        "production",
      );
      assert(resolved.config?.main);
      const sdkClosure = new Set();
      const result = await build({
        ...resolved.config.main,
        build: { ...resolved.config.main.build, outDir: main },
        plugins: [
          ...(resolved.config.main.plugins ?? []),
          {
            name: "inspect-bundled-mcp-licenses",
            generateBundle() {
              const visit = (id) => {
                if (sdkClosure.has(id)) return;
                sdkClosure.add(id);
                const info = this.getModuleInfo(id);
                for (const dependency of [
                  ...(info?.importedIds ?? []),
                  ...(info?.dynamicallyImportedIds ?? []),
                ])
                  visit(dependency);
              };
              for (const id of this.getModuleIds())
                if (id.includes("/node_modules/@modelcontextprotocol/sdk/"))
                  visit(id);
            },
          },
        ],
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (entry) => ("output" in entry ? entry.output : []),
      );
      const packages = new Set(
        outputs.flatMap((entry) =>
          entry.type === "chunk"
            ? Object.entries(entry.modules).flatMap(([id, module]) => {
                const name = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//u.exec(
                  id,
                )?.[1];
                return sdkClosure.has(id) && module.renderedLength > 0 && name
                  ? [name]
                  : [];
              })
            : [],
        ),
      );
      assert.deepEqual(
        [...packages].sort(),
        [...BUNDLED_MCP_LICENSE_PACKAGES].sort(),
        "Every rendered SDK dependency must retain its license notice",
      );

      // Only the existing app's JS/runtime externals, not SDK or repository links.
      // This checks the MCP closure, not the Electron shell or platform PTY package.
      await mkdir(path.join(app, "node_modules"), { recursive: true });
      await cp(
        await realpath(path.join(repository, "node_modules", "ws")),
        path.join(app, "node_modules", "ws"),
        { recursive: true, dereference: true },
      );
      const sdk = path.join(repository, "node_modules", "@zenx", "plugin-sdk");
      const sdkDestination = path.join(
        app,
        "node_modules",
        "@zenx",
        "plugin-sdk",
      );
      await mkdir(sdkDestination, { recursive: true });
      await cp(
        path.join(sdk, "package.json"),
        path.join(sdkDestination, "package.json"),
      );
      await cp(path.join(sdk, "dist"), path.join(sdkDestination, "dist"), {
        recursive: true,
        dereference: true,
      });
      await stageStorageWriter(repository, app);
      await writeFile(path.join(app, "package.json"), '{"type":"module"}\n');
      await assert.rejects(
        access(path.join(app, "node_modules", "@modelcontextprotocol")),
        { code: "ENOENT" },
      );
      for (
        let directory = path.dirname(app);
        ;
        directory = path.dirname(directory)
      ) {
        await assert.rejects(
          access(
            path.join(
              directory,
              "node_modules",
              "@modelcontextprotocol",
              "sdk",
            ),
          ),
          { code: "ENOENT" },
        );
        if (directory === path.dirname(directory)) break;
      }
      const assertRegularTree = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          assert.equal(
            entry.isSymbolicLink(),
            false,
            `External dependency link: ${entry.name}`,
          );
          if (entry.isDirectory())
            await assertRegularTree(path.join(directory, entry.name));
        }
      };
      await assertRegularTree(app);
      const launcher = path.join(main, "user-mcp-stdio-cli.js");
      await assert.rejects(
        run(process.execPath, [launcher], {
          cwd: app,
          env: { PATH: process.env.PATH },
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.equal(error.stdout, "");
          assert.equal(
            error.stderr,
            "Explicit --descriptor and --thread are required; this launcher never starts a Host\n",
          );
          return true;
        },
      );
      host = await createLiveUserMcpHost(path.join(temporary, "host"), {
        builtMainDirectory: main,
        environment: {
          PATH: process.env.PATH,
          HOME: temporary,
          NODE_PATH: "",
          NODE_OPTIONS: "",
        },
      });
      const pid = host.manager.processId;
      client = new Client({
        name: "isolated-built-mcp-acceptance",
        version: "1",
      });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            launcher,
            "--descriptor",
            host.descriptorFile,
            "--thread",
            host.threadId,
          ],
          cwd: app,
          env: { PATH: process.env.PATH },
          stderr: "pipe",
        }),
      );
      assert.equal(client.getServerVersion()?.name, "zen-bound-user-tools");
      const result_ = await client.callTool({
        name: "zenx_threads_read",
        arguments: {},
      });
      assert.notEqual(result_.isError, true);
      assert.match(
        JSON.stringify(result_),
        /Actual already-running Desktop child history/u,
      );
      assert.equal(host.manager.processId, pid);
      const tool = async (name, arguments_ = {}) => {
        const value = await client.callTool({ name, arguments: arguments_ });
        assert.notEqual(value.isError, true, JSON.stringify(value));
        return JSON.parse(
          value.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        );
      };
      const empty = await tool("zenx_board_read", { view: "document" });
      const document = {
        id: "packaged",
        title: "Isolated built MCP Board",
        summary: "Synthetic runtime packaging proof",
        blocks: [],
        events: [],
      };
      assert.equal(
        (await tool("zenx_board_put", { snapshot: empty.snapshot, document }))
          .applied,
        true,
      );
      assert.equal(
        (
          await tool("zenx_board_put", {
            snapshot: empty.snapshot,
            document: { ...document, title: "stale" },
          })
        ).applied,
        false,
      );
      assert.equal(
        (await tool("zenx_board_read", { view: "document" })).document.title,
        document.title,
      );
    } finally {
      process.chdir(previousCwd);
      try {
        await client?.close();
      } finally {
        try {
          await host?.close();
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
    }
  },
);
