import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import type { ZenXCapabilityService } from "../src/main/capability-service.js";

export async function captureLiveComponents(
  service: ZenXCapabilityService,
  threadId: string,
  output: string,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-trigger-live-ui-"));
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.url !== "/cmd" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { nonce, id, input } = JSON.parse(body);
      if (nonce !== secret) throw new Error("Unauthorized QA request");
      const data = await service.executePluginCommand(
        "zenx-triggers",
        id,
        input,
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, message: String(error) }));
    }
  });
  const secret = Math.random().toString(36).slice(2);
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No QA server");
    const base = `http://127.0.0.1:${address.port}`;
    const entry = path.join(root, "entry.tsx");
    const sourceRoot = path.resolve("src/renderer/src");
    await writeFile(
      entry,
      `import React from 'react';import {createRoot} from 'react-dom/client';import {TriggersPage,TriggersPanel} from '${sourceRoot}/bundled-automation-ui.tsx';
  const context={threadId:${JSON.stringify(threadId)}};
  const sdk={context,navigation:{navigate:()=>{}},commands:{execute:async(id,input)=>{const reply=await fetch(${JSON.stringify(base)}+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:${JSON.stringify(secret)},id,input})}).then(r=>r.json());if(!reply.ok)throw new Error(reply.message);return reply.data;}}};
  createRoot(document.querySelector('#app')).render(location.search.includes('rail')?<TriggersPanel sdk={sdk}/>:<TriggersPage sdk={sdk}/>);`,
    );
    await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      outfile: path.join(root, "index.js"),
      loader: { ".png": "dataurl", ".svg": "dataurl" },
      logLevel: "silent",
      nodePaths: [path.resolve("../../node_modules")],
    });
    const css = (
      await Promise.all(
        ["theme.css", "styles.css", "trigger-ui.css"].map((f) =>
          readFile(path.join(sourceRoot, f), "utf8"),
        ),
      )
    ).join("\n");
    await writeFile(
      path.join(root, "index.html"),
      `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="app"></div><script type="module" src="./index.js"></script></body></html>`,
    );
    const main = path.join(root, "capture.cjs");
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.whenReady().then(async()=>{const window=new BrowserWindow({width:920,height:700,show:false,webPreferences:{offscreen:true}});window.webContents.on('console-message',(_,level,message)=>{if(level>=3)console.error(message)});for(const [name,query,w,h] of [['global','',920,700],['rail','?rail',500,700],['narrow','?rail',360,560]]){window.setSize(w,h);await window.loadFile('${root}/index.html',{query:query?{view:'rail'}:{}});await new Promise(r=>setTimeout(r,900));const img=await window.webContents.capturePage();fs.writeFileSync('${output}/new-live-'+name+'.png',img.toPNG());console.log('capture',name,JSON.stringify(img.getSize()));}window.destroy();app.quit();}).catch(e=>{console.error(e);app.exit(1)});`,
    );
    const electron = path.resolve(
      "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(electron, [main], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => process.stdout.write(d));
      child.stderr.on("data", (d) => process.stderr.write(d));
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`capture exit ${code}`)),
      );
    });
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}
