import {
  browserExtensionsFixturePath,
  browserExtensionsFixtureBody,
  verifyBrowserExtensions,
} from "./browser-extensions-smoke.js";
/**
 * Real headed, disposable-profile fixture. Never attach to a personal profile.
 * Run: node --import tsx apps/zenx/src/main/browser-parallel-input-smoke.ts
 * ZENX_USER_BROWSER_EXECUTABLE may select an existing Chrome/Chromium binary.
 * ZENX_REQUIRE_OS_INPUT=1 makes missing macOS Accessibility fail acceptance.
 * ZENX_PARALLEL_INPUT_ARTIFACT_DIR optionally retains the JSON evidence report.
 * This smoke intentionally activates only its own fixture windows during setup.
 * Protocol-only user input is reported separately from real OS input evidence.
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { UserBrowserCdpDiagnosticObserver } from "./capabilities/user-browser-cdp-diagnostics.js";
import {
  BrowserInputUnsupportedError,
  BrowserInputOutcomeUnknownError,
} from "./capabilities/browser-targeted-input.js";
import type {
  BrowserInspection,
  ZenXBrowserBackend,
} from "./capabilities/browser-provider.js";
import {
  connectUserBrowserCdp,
  UserBrowserDocumentChangedBeforeDispatchError,
  UserBrowserMutationOutcomeUnknownError,
  windowsBrowserExecutableCandidates,
  type UserBrowserConnection,
} from "./capabilities/user-browser-provider.js";

const runFile = promisify(execFile);
const delay = async (ms: number) =>
  await new Promise<void>((r) => setTimeout(r, ms));
const nonce = randomUUID();
const userTitle = `ZenX Parallel USER ${nonce}`;
const agentTitle = `ZenX Parallel AGENT ${nonce}`;
const sessionId = `parallel-${nonce}`;

interface PageState {
  value: string;
  focus: string;
  hasFocus: boolean;
  visibility: string;
  clicks: number;
  submissions: string[];
  trustedKeys: number;
  visibilityEvents: string[];
  focusEvents: string[];
}
interface NativeState {
  pid: number;
  hwnd?: string;
  title?: string;
  axTrusted: boolean;
  samples: number;
  titleSamples?: number;
  idleTitleCooldownMs?: number;
  drift: boolean;
  sentinelValue?: string;
  sentinelFocused?: boolean;
  focusedValueState?: "matched" | "pending" | "invalid";
}
interface Target {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

interface FixtureCdpEvent {
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
}

class Rpc {
  // Screenshot-only, payload-free transport evidence. The last 16 calls also
  // serve as bounded tombstones: late replies never regain a pending promise.
  #screenshots = new Map<
    number,
    {
      id: number;
      startedAt: number;
      sessionScoped: boolean;
      transportAccepted: boolean;
      sendCallback: "pending" | "ok" | "error";
      sendCallbackElapsedMs?: number;
      sendCallbackState?: {
        readyState: number;
        bufferedAmount: number;
        pendingCount: number;
      };
      returned?: {
        readyState: number;
        bufferedAmount: number;
        pendingCount: number;
      };
      outcome:
        | "pending"
        | "success"
        | "protocol-error"
        | "timeout"
        | "socket-closed"
        | "send-threw";
      elapsedMs?: number;
      sent: {
        readyState: number;
        bufferedAmount: number;
        pendingCount: number;
      };
      settled?: {
        readyState: number;
        bufferedAmount: number;
        pendingCount: number;
      };
      lateReply?: {
        outcome: "success" | "protocol-error";
        elapsedMs: number;
        readyState: number;
        bufferedAmount: number;
        pendingCount: number;
      };
    }
  >();
  #screenshotDropped = 0;
  #reportedSocketEnd = false;
  #socketState() {
    return {
      readyState: this.socket.readyState,
      bufferedAmount: this.socket.bufferedAmount,
      pendingCount: this.#pending.size,
    };
  }
  screenshotTransport() {
    // Return detached scalar records, never CDP parameters, results or errors.
    return {
      limit: 16,
      dropped: this.#screenshotDropped,
      records: Array.from(this.#screenshots.values(), (record) => ({
        ...record,
        sent: { ...record.sent },
        ...(record.returned ? { returned: { ...record.returned } } : {}),
        ...(record.sendCallbackState
          ? { sendCallbackState: { ...record.sendCallbackState } }
          : {}),
        ...(record.settled ? { settled: { ...record.settled } } : {}),
        ...(record.lateReply ? { lateReply: { ...record.lateReply } } : {}),
      })),
    };
  }
  #reportScreenshots(phase: "cleanup" | "socket-end") {
    if (!this.#screenshots.size) return;
    try {
      console.error(
        "Fixture screenshot transport",
        JSON.stringify({ phase, ...this.screenshotTransport() }),
      );
    } catch {
      // A diagnostic sink must never change cleanup or promise settlement.
    }
  }
  #listeners = new Set<(event: FixtureCdpEvent) => void>();
  onEvent(listener: (event: FixtureCdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #id = 0;
  #pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
    }
  >();
  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: unknown;
      } & FixtureCdpEvent;
      if (message.id === undefined) {
        for (const listener of this.#listeners) listener(message);
        return;
      }
      const pending = this.#pending.get(message.id);
      const screenshot = this.#screenshots.get(message.id);
      if (!pending) {
        if (
          screenshot &&
          !screenshot.lateReply &&
          (screenshot.outcome === "timeout" ||
            screenshot.outcome === "socket-closed" ||
            screenshot.outcome === "send-threw")
        ) {
          screenshot.lateReply = {
            outcome: message.error ? "protocol-error" : "success",
            elapsedMs: Date.now() - screenshot.startedAt,
            ...this.#socketState(),
          };
        }
        return;
      }
      this.#pending.delete(message.id);
      if (screenshot) {
        screenshot.outcome = message.error ? "protocol-error" : "success";
        screenshot.elapsedMs = Date.now() - screenshot.startedAt;
        screenshot.settled = this.#socketState();
      }
      if (message.error)
        pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result ?? {});
    });
    const fail = () => {
      for (const [id, pending] of this.#pending) {
        const screenshot = this.#screenshots.get(id);
        if (screenshot) {
          screenshot.outcome = "socket-closed";
          screenshot.elapsedMs = Date.now() - screenshot.startedAt;
          screenshot.settled = this.#socketState();
        }
        pending.reject(new Error("Fixture CDP socket closed"));
      }
      this.#pending.clear();
      if (!this.#reportedSocketEnd) {
        this.#reportedSocketEnd = true;
        this.#reportScreenshots("socket-end");
      }
    };
    socket.on("close", fail);
    socket.on("error", fail);
  }
  static async connect(url: string): Promise<Rpc> {
    const socket = new WebSocket(url, { handshakeTimeout: 5_000 });
    const rpc = new Rpc(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return rpc;
  }
  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    const startedAt = Date.now();
    let transportAccepted = false;
    if (method === "Page.captureScreenshot") {
      if (this.#screenshots.size === 16) {
        this.#screenshots.delete(this.#screenshots.keys().next().value!);
        this.#screenshotDropped++;
      }
      this.#screenshots.set(id, {
        id,
        startedAt,
        sessionScoped: sessionId !== undefined,
        transportAccepted: false,
        sendCallback: "pending",
        outcome: "pending",
        sent: this.#socketState(),
      });
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const screenshot = this.#screenshots.get(id);
        if (screenshot) {
          screenshot.outcome = "timeout";
          screenshot.elapsedMs = Date.now() - startedAt;
          screenshot.settled = this.#socketState();
        }
        // A returned socket.send is transport acceptance, not browser execution.
        // In particular a screenshot timeout does not imply an input was sent.
        reject(
          Object.assign(
            new Error(`${method} fixture timeout; never replay an input`),
            {
              fixtureCdp: {
                method,
                id,
                transportAccepted,
                sessionScoped: sessionId !== undefined,
                elapsedMs: Date.now() - startedAt,
                timeoutMs: 10_000,
                ...(method === "Page.captureScreenshot"
                  ? { screenshotTransport: this.screenshotTransport() }
                  : {}),
              },
            },
          ),
        );
      }, 10_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
          ...(method === "Page.captureScreenshot"
            ? [
                (error?: Error) => {
                  const screenshot = this.#screenshots.get(id);
                  if (!screenshot) return;
                  screenshot.sendCallback = error ? "error" : "ok";
                  screenshot.sendCallbackElapsedMs = Date.now() - startedAt;
                  screenshot.sendCallbackState = this.#socketState();
                  // This callback is evidence only, not a CDP response or failure.
                },
              ]
            : []),
        );
        transportAccepted = true;
        const screenshot = this.#screenshots.get(id);
        if (screenshot) {
          screenshot.transportAccepted = true;
          screenshot.returned = this.#socketState();
        }
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        const screenshot = this.#screenshots.get(id);
        if (screenshot) {
          screenshot.outcome = "send-threw";
          screenshot.elapsedMs = Date.now() - startedAt;
          screenshot.settled = this.#socketState();
        }
        reject(error);
      }
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(
      result.exceptionDetails,
      undefined,
      `Fixture evaluation failed: ${JSON.stringify(result.exceptionDetails)}`,
    );
    return (result.result as { value: T }).value;
  }
  close(): void {
    this.socket.close();
    this.#reportScreenshots("cleanup");
  }
}

class Native {
  #id = 0;
  #pending = new Map<
    number,
    { resolve(value: NativeState): void; reject(error: Error): void }
  >();
  readonly ready: Promise<NativeState>;
  readonly child: ChildProcess;
  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    this.child.stderr!.on("data", (raw) => {
      stderr = (stderr + String(raw)).slice(-8_192);
    });
    this.ready = new Promise((resolve, reject) =>
      this.#pending.set(0, { resolve, reject }),
    );
    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line) => {
      let response: { id: number; result: NativeState; error?: string };
      try {
        response = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.result);
    });
    const fail = (error: unknown) => {
      for (const pending of this.#pending.values())
        pending.reject(
          new Error(`Native fixture helper exited: ${String(error)} ${stderr}`),
        );
      this.#pending.clear();
    };
    this.child.on("error", fail);
    this.child.on("exit", (code, signal) =>
      fail(`${String(code)}/${String(signal)}`),
    );
  }
  async call(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<NativeState> {
    const id = ++this.#id;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Native ${method} timed out; no replay`));
      }, 10_000);
      this.#pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin!.write(JSON.stringify({ id, method, ...params }) + "\n");
    });
  }
  async close(): Promise<void> {
    await this.call("clear").catch(() => undefined);
    this.child.stdin?.end();
    await stopOwnedChild(this.child);
  }
}

function page(kind: "user" | "agent"): string {
  const agent = kind === "agent";
  return `<!doctype html><meta charset="utf-8"><title>${agent ? agentTitle : userTitle}</title>
<style>body{margin:0;background:#f6f8fc;font:18px system-ui}input{position:absolute;left:20px;top:120px;width:250px;height:40px;font:18px system-ui}canvas{position:absolute;left:20px;top:20px;background:#acf}button{position:absolute;left:300px;top:125px}</style>
${agent ? '<canvas id="agent-canvas" width="200" height="60" tabindex="0"></canvas><form id="form"><input id="agent-input" aria-label="Agent input"><button>Submit</button></form>' : '<input id="user-input" aria-label="User input" autocomplete="off">'}
<script>window.__zenProgrammableSmoke=42;
window.fixture={clicks:0,submissions:[],trustedKeys:0,visibilityEvents:[],focusEvents:[]};
document.addEventListener('keydown',e=>{if(e.isTrusted)fixture.trustedKeys++});
document.addEventListener('visibilitychange',()=>fixture.visibilityEvents.push(document.visibilityState));
for(const type of ['focus','blur'])window.addEventListener(type,event=>{if(event.target===window)fixture.focusEvents.push(type)});
${agent ? "document.querySelector('canvas').onclick=e=>{if(!e.isTrusted)throw Error('untrusted pointer');fixture.clicks++;e.currentTarget.focus()};document.querySelector('#form').onsubmit=e=>{e.preventDefault();fixture.submissions.push(document.querySelector('input').value)};" : ""}
</script>`;
}
const stateScript = `({value:document.querySelector('input').value,focus:document.activeElement?.id||'',hasFocus:document.hasFocus(),visibility:document.visibilityState,...window.fixture})`;

/** Observe consumption of already-issued fixture input; never dispatch/replay it. */
async function settleMacFixtureInput(options: {
  previousValue: string;
  expectedValue: string;
  read(): Promise<{
    domValue: string;
    nativeValueState: NativeState["focusedValueState"];
  }>;
  signal: AbortSignal;
}): Promise<number> {
  const deadline = performance.now() + 2_000;
  let reads = 0;
  for (;;) {
    options.signal.throwIfAborted();
    assert(performance.now() < deadline, "Native fixture input did not settle");
    const { domValue, nativeValueState } = await withDeadline(
      options.read(),
      deadline - performance.now(),
      "Native fixture input settlement",
    );
    reads++;
    options.signal.throwIfAborted();
    assert(performance.now() < deadline, "Native fixture input did not settle");
    assert(
      domValue.startsWith(options.previousValue) &&
        options.expectedValue.startsWith(domValue),
      "Already-issued native input changed the exact user fixture value",
    );
    assert(
      nativeValueState === "matched" || nativeValueState === "pending",
      "Native focused value is not a prefix of the exact issued input",
    );
    if (domValue === options.expectedValue && nativeValueState === "matched")
      return reads;
    await delay(20);
  }
}

import {
  isRemoteFrameMode,
  remoteFrameModes,
  remoteFrameContractPage,
  remoteFrameFixtureFromUrl,
  type RemoteFrameMode,
} from "./browser-remote-frame-smoke-fixture.js";
export { remoteFrameContractPage } from "./browser-remote-frame-smoke-fixture.js";

/** Served only by the disposable local smoke servers, before any tracker exists. */
export function targetedInputContractPage(requestUrl: string): string {
  const mode = new URL(requestUrl, "http://127.0.0.1").searchParams.get("mode");
  if (isRemoteFrameMode(mode))
    return remoteFrameContractPage(
      new URL(requestUrl, "http://127.0.0.1").pathname === "/remote-frame-child"
        ? "child"
        : "parent",
      remoteFrameFixtureFromUrl(requestUrl),
    );
  return `<!doctype html><meta charset="utf-8"><title>ZenX targeted input contract</title>
<style>body{margin:0;font:16px system-ui}#contract-host{position:absolute;left:20px;top:20px;width:620px;height:480px}#status{position:absolute;top:530px}</style>
<div id="contract-host"></div><p id="status">Disposable targeted input contract</p>
<script>
const mode=${JSON.stringify(mode)};
const host=document.querySelector('#contract-host');
let root=host;
let contractFrame;
let reflected=false;
const cosine=0.9659258262890683,sine=0.25881904510252074;
const applyAffine=()=>{contractFrame.style.transform='matrix('+[cosine,reflected?-sine:sine,reflected?sine:-sine,cosine,0,0].join(',')+')'};
if(mode==='same-origin-frame'||mode==='same-origin-closed-shadow'||mode==='affine-frame'){
  contractFrame=document.createElement('iframe');contractFrame.id='contract-frame';
  contractFrame.style.cssText='width:620px;height:480px;border:5px solid #345;padding:11px 7px';
  host.append(contractFrame);root=contractFrame.contentDocument.body;root.style.margin='0';
  if(mode==='affine-frame'){host.style.left='100px';host.style.top='90px';contractFrame.style.display='block';contractFrame.style.transformOrigin='322px 256px';applyAffine()}
  // Main-world poison is a witness that provider probes stay in isolated wrappers.
  const child=contractFrame.contentWindow;child.mainWorldProbeCalls=0;
  child.getComputedStyle=()=>{child.mainWorldProbeCalls++;throw Error('Main-world style probe used')};
  contractFrame.contentDocument.elementFromPoint=()=>{child.mainWorldProbeCalls++;throw Error('Main-world hit probe used')};
}
if(mode==='shadow'||mode==='closed-shadow'||mode==='same-origin-closed-shadow'){
  const shadowHost=contractFrame?contractFrame.contentDocument.createElement('div'):host;
  if(contractFrame){shadowHost.style.cssText='position:absolute;left:0;top:0;width:620px;height:480px';root.append(shadowHost)}
  root=shadowHost.attachShadow({mode:mode==='shadow'?'open':'closed'});
}
if(mode==='deep-shadow'){
  let container=host;
  for(let depth=0;depth<40;depth++){
    root=container.attachShadow({mode:'open'});
    const child=document.createElement('div');
    child.style.cssText='position:absolute;left:0;top:0;width:620px;height:480px';
    root.append(child);container=child;
  }
  root=container;
}
root.innerHTML='<style>canvas,input,select,label{position:absolute;box-sizing:border-box}canvas{left:0;top:0;background:#acf}input,select{left:0;width:190px;height:32px}#text-a{top:90px}#text-b{top:140px}label{left:220px;width:210px;height:32px;padding:5px;background:#eee}#opaque{position:absolute;left:0;top:0;width:200px;height:60px;background:#ddd}</style>'+
  '<canvas id="canvas" tabindex="0" width="200" height="60"></canvas><input id="text-a" aria-label="Contract text A"><input id="text-b" aria-label="Contract text B">'+
  ['file','color','date','select'].map((type,index)=>{
    const top=200+index*55;
    const control=type==='select'?'<select id="native-select" style="top:'+top+'px"><option>One</option><option>Two</option></select>':'<input id="native-'+type+'" type="'+type+'" style="top:'+top+'px">';
    return control+'<label id="label-'+type+'" tabindex="0" for="native-'+type+'" style="top:'+top+'px"><span>Native '+type+' label</span></label>';
  }).join('');
if(mode==='ordinary-dom')root.innerHTML='<button style="width:200px;height:60px"><span id="button-span">Styled save</span></button><div id="widget" role="button" tabindex="0" style="position:absolute;top:90px;width:200px;height:60px;background:#ddd">Pointer widget</div><div id="editor" contenteditable="true" tabindex="0" style="position:absolute;top:170px;width:240px;height:60px;border:1px solid">Draft</div>';
const node=id=>root.querySelector('#'+id);
const events=[];
const eventTypes=['pointerdown','pointerup','keydown','keyup'];
// Register the fixture witness before the consuming handler and before inspection.
// The witness observes real trusted events; it never changes them or tracker state.
const witness=(mode==='closed-shadow'||mode==='same-origin-closed-shadow')?root:contractFrame?contractFrame.contentWindow:window;
const witnessEvent=event=>events.push({type:event.type,trusted:event.isTrusted,target:event.composedPath().find(node=>node.id)?.id||''});
for(const type of eventTypes)witness.addEventListener(type,witnessEvent,true);
if(mode==='stop-propagation'||mode==='stop-immediate'){
  for(const type of eventTypes)window.addEventListener(type,event=>{
    if(mode==='stop-immediate')event.stopImmediatePropagation();else event.stopPropagation();
  },true);
}
// Suppress control defaults (including focus/activation) in this fixture only.
// This proves trusted dispatch, not real picker operation or value changes. The
// witness above still records both events, including open-shadow controls.
for(const element of root.querySelectorAll('input:not([type]),input[type=file],input[type=color],input[type=date],select,label')){
  if(!element.id.startsWith('native-')&&!element.id.startsWith('label-'))continue;
  for(const type of ['pointerdown','mousedown','click','keydown','keyup'])element.addEventListener(type,event=>event.preventDefault());
}
window.contract={mode,events,clicks:0,widgets:{},
  reopenFrame(){if(!contractFrame)throw Error('Frame fixture required');const html=root.innerHTML;const doc=contractFrame.contentDocument;doc.open();doc.write('<!doctype html><body style="margin:0;min-height:900px">'+html+'</body>');doc.close();root=doc.body;for(const type of eventTypes)doc.defaultView.addEventListener(type,witnessEvent,true);node('text-a').focus()},
  flipTransform(){if(mode!=='affine-frame')throw Error('Affine fixture required');const before=contractFrame.getBoundingClientRect().toJSON();reflected=!reflected;applyAffine();return {before,after:contractFrame.getBoundingClientRect().toJSON()}},
  point(id){const element=node(id);if(!element)throw Error('Missing fixture node '+id);const hit=id.startsWith('label-')?element.querySelector('span'):element;const r=hit.getBoundingClientRect();
    // Independent forward oracle: fixed fixture layout + authored CSS matrix,
    // never provider inverse mapping, CDP quads or transformed bounding boxes.
    if(mode==='affine-frame'){const x=r.left+r.width/2+12-322,y=r.top+r.height/2+16-256,angle=reflected?-sine:sine;return {x:100+322+cosine*x-angle*y,y:90+256+angle*x+cosine*y}}
    const frame=contractFrame?.getBoundingClientRect();return {x:r.left+r.width/2+(frame?frame.left+contractFrame.clientLeft+7:0),y:r.top+r.height/2+(frame?frame.top+contractFrame.clientTop+11:0)}},
  focus(id){const element=node(id);element.focus();if(element.isContentEditable){const range=element.ownerDocument.createRange();range.selectNodeContents(element);range.collapse(false);const selection=element.ownerDocument.defaultView.getSelection();selection.removeAllRanges();selection.addRange(range)}return {outer:document.activeElement?.id,inner:element.getRootNode().activeElement?.id||document.activeElement?.id}},
  state(){return {mode,events:[...events],clicks:this.clicks,widgets:{...this.widgets},values:{'text-a':node('text-a')?.value,'text-b':node('text-b')?.value,editor:node('editor')?.textContent.replaceAll(String.fromCharCode(160),' ')},a:node('text-a')?.value,b:node('text-b')?.value,visibility:document.visibilityState,outer:document.activeElement?.id}},
};
if(node('canvas'))node('canvas').onclick=event=>{if(!event.isTrusted)throw Error('Untrusted fixture click');contract.clicks++;event.currentTarget.focus()};
for(const id of ['button-span','widget'])if(node(id))node(id).addEventListener('pointerdown',event=>{if(!event.isTrusted)throw Error('Untrusted widget pointer');contract.widgets[id]=(contract.widgets[id]||0)+1});
node(mode==='ordinary-dom'?'editor':'text-a').focus();
</script>`;
}

interface ContractState {
  mode: string;
  documentId?: string;
  childVisibility?: string;
  routeEvents?: {
    type: string;
    trusted: boolean;
    target: string;
    clientX?: number;
    clientY?: number;
  }[];
  rootEvents?: {
    type: string;
    trusted: boolean;
    target: string;
    clientX?: number;
    clientY?: number;
  }[];
  widgets: Record<string, number>;
  values: Record<string, string | undefined>;
  events: { type: string; trusted: boolean; target: string }[];
  clicks: number;
  a?: string;
  b?: string;
  visibility: string;
  outer: string;
}
interface RemoteFixturePoint {
  outerAffine?: boolean;
  reflected?: boolean;
  x: number;
  y: number;
  documentId: string;
  hitId: string;
  localPoint: { x: number; y: number };
  childViewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  owners: {
    id: string;
    left: number;
    top: number;
    width: number;
    height: number;
    hitId: string;
    scrollX: number;
    scrollY: number;
  }[];
}

/** The independent authored forward point must match every current DOM owner. */
export function assertRemoteFixturePoint(
  point: RemoteFixturePoint,
  id: string,
  depth: number,
): void {
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  assert.equal(
    point.hitId,
    id,
    "Independent child point must hit the requested element",
  );
  assert.equal(point.childViewport.width, depth === 1 ? 620 : 400);
  assert.equal(point.childViewport.height, depth === 1 ? 480 : 300);
  assert.equal(
    point.childViewport.scrollX,
    0,
    "Fixture child must not scroll during setup",
  );
  assert.equal(
    point.childViewport.scrollY,
    0,
    "Fixture child must not scroll during setup",
  );
  assert.ok(
    Number.isFinite(point.localPoint.x) && Number.isFinite(point.localPoint.y),
  );
  assert.ok(
    point.localPoint.x >= 0 && point.localPoint.x < point.childViewport.width,
  );
  assert.ok(
    point.localPoint.y >= 0 && point.localPoint.y < point.childViewport.height,
  );
  assert.equal(point.owners.length, depth);
  const nestedOffset = depth === 2 ? { x: 45, y: 55 } : { x: 0, y: 0 };
  const cosine = Math.cos(Math.PI / 12);
  const sine = Math.sin(Math.PI / 12);
  const localX = point.localPoint.x + nestedOffset.x;
  const localY = point.localPoint.y + nestedOffset.y;
  const angle = point.reflected ? -sine : sine;
  const expectedPoint = point.outerAffine
    ? {
        x: 422 + cosine * (localX + 12 - 322) - angle * (localY + 16 - 256),
        y: 346 + angle * (localX + 12 - 322) + cosine * (localY + 16 - 256),
      }
    : { x: localX + 32, y: localY + 36 };
  assert.ok(Math.abs(point.x - expectedPoint.x) < 0.01);
  assert.ok(Math.abs(point.y - expectedPoint.y) < 0.01);
  for (const [index, owner] of point.owners.entries()) {
    const expected =
      index === 0
        ? point.outerAffine
          ? {
              id: "contract-frame",
              left: 422 - cosine * 322 - sine * 256,
              top: 346 - sine * 322 - cosine * 256,
              width: cosine * 644 + sine * 512,
              height: sine * 644 + cosine * 512,
            }
          : { id: "contract-frame", left: 20, top: 20, width: 644, height: 512 }
        : {
            id: "nested-contract-frame",
            left: 40,
            top: 50,
            width: 410,
            height: 310,
          };
    assert.equal(owner.id, expected.id);
    assert.equal(
      owner.hitId,
      owner.id,
      "Mapped point must hit the actual parent iframe",
    );
    assert.equal(owner.scrollX, 0);
    assert.equal(owner.scrollY, 0);
    for (const key of ["left", "top", "width", "height"] as const)
      assert.ok(
        Math.abs(owner[key] - expected[key]) < 0.01,
        `Fixture owner ${owner.id} ${key} is ${owner[key]}, expected ${expected[key]}`,
      );
  }
}

/** CDP ACK is not child-consumption evidence. Only read the already-issued pair. */
export async function settleRemoteFixturePair(
  read: () => Promise<ContractState>,
  before: ContractState,
  kind: "click" | "key",
  id: string,
): Promise<{ state: ContractState; reads: number }> {
  const expected = (
    kind === "click" ? ["pointerdown", "pointerup"] : ["keydown", "keyup"]
  ).map((type) => ({ type, trusted: true, target: id }));
  let reads = 0;
  const state = await poll(async () => {
    const current = await read();
    reads++;
    assert.equal(
      current.documentId,
      before.documentId,
      "Child document changed while consuming the issued pair",
    );
    assert.equal(current.visibility, "hidden");
    assert.deepEqual(
      current.events.slice(0, before.events.length),
      before.events,
      "Remote witness history must not change",
    );
    const events = current.events.slice(before.events.length);
    assert.ok(
      events.length <= expected.length,
      "Unexpected additional remote input",
    );
    assert.deepEqual(
      events,
      expected.slice(0, events.length),
      "Remote input must be the exact trusted target/type prefix",
    );
    const expectedClicks =
      before.clicks + Number(kind === "click" && id === "canvas");
    assert.ok(
      current.clicks === before.clicks || current.clicks === expectedClicks,
      "Unexpected remote click effect",
    );
    const expectedValue =
      kind === "key" && id in before.values
        ? before.values[id] + " "
        : undefined;
    if (expectedValue !== undefined)
      assert.ok(
        current.values[id] === before.values[id] ||
          current.values[id] === expectedValue,
        "Unexpected remote text effect",
      );
    return events.length === expected.length &&
      current.clicks === expectedClicks &&
      (expectedValue === undefined || current.values[id] === expectedValue)
      ? current
      : undefined;
  }, "exact remote trusted pair and effect (read-only settlement)");
  return { state, reads };
}

interface ContractInput {
  method: string;
  type: string;
  sessionId: string;
  socketId?: number;
  route?: {
    targetId?: string;
    parentSessionId?: string;
    parentTargetId?: string;
    grandparentSessionId?: string;
    frameId?: string;
    parentFrameId?: string;
  };
  x?: number;
  y?: number;
}

interface FixtureExecutionContext {
  id: number;
  uniqueId: string;
  auxData: { frameId: string; isDefault: boolean };
}
interface FramePlacementEvidence {
  mode: RemoteFrameMode;
  rootFrameId: string;
  childFrameId: string;
  rootContexts: FixtureExecutionContext[];
  targets: { targetId: string; type: string; url: string }[];
  childUrl: string;
  childSessionId?: string;
  childSessionTargetId?: string;
  childSessionFrameId?: string;
  childSessionParentFrameId?: string;
  parentTreeChildFrames?: { id: string; url: string }[];
  childContexts?: FixtureExecutionContext[];
  childAttachedEvent?: {
    sessionId: string;
    targetInfo: { targetId: string; type: string; url: string };
  };
  ownerBackendNodeId: number;
  descendant?: FramePlacementEvidence;
}

/** Process placement is observed, never inferred from cross-origin URLs. */
export function assertRemoteFramePlacement(
  evidence: FramePlacementEvidence,
): void {
  assert.notEqual(evidence.rootFrameId, evidence.childFrameId);
  const root = evidence.rootContexts.filter(
    (context) =>
      context.auxData?.isDefault &&
      context.auxData.frameId === evidence.rootFrameId &&
      context.uniqueId,
  );
  const local = evidence.rootContexts.filter(
    (context) =>
      context.auxData?.isDefault &&
      context.auxData.frameId === evidence.childFrameId &&
      context.uniqueId,
  );
  const targets = evidence.targets.filter(
    (target) => target.type === "iframe" && target.url === evidence.childUrl,
  );
  assert.equal(root.length, 1, "Need the exact live root default context");
  assert.ok(
    Number.isSafeInteger(evidence.ownerBackendNodeId) &&
      evidence.ownerBackendNodeId > 0,
    "Need the exact parent DOM frame owner",
  );
  if (evidence.mode === "cross-origin-same-process") {
    assert.equal(
      local.length,
      1,
      "Same-process fixture requires a real child default context in the root session",
    );
    assert.equal(
      targets.length,
      0,
      "Same-process fixture must not actually be an OOPIF",
    );
  } else {
    assert.equal(
      local.length,
      0,
      "OOPIF default context must not be in the parent session",
    );
    assert.equal(
      targets.length,
      1,
      "OOPIF fixture requires a real iframe target",
    );
    assert.equal(targets[0]!.url, evidence.childUrl);
    assert.ok(
      evidence.childSessionId,
      "OOPIF fixture requires an attached child session",
    );
    assert.equal(evidence.childSessionTargetId, targets[0]!.targetId);
    assert.equal(
      evidence.childAttachedEvent?.sessionId,
      evidence.childSessionId,
    );
    assert.equal(
      evidence.childAttachedEvent?.targetInfo.targetId,
      evidence.childSessionTargetId,
    );
    assert.equal(evidence.childAttachedEvent?.targetInfo.type, "iframe");
    assert.equal(
      evidence.childAttachedEvent?.targetInfo.url,
      evidence.childUrl,
    );
    assert.equal(evidence.childSessionFrameId, evidence.childFrameId);
    if (evidence.childSessionParentFrameId !== undefined)
      assert.equal(evidence.childSessionParentFrameId, evidence.rootFrameId);
    const child = evidence.childContexts?.filter(
      (context) =>
        context.auxData?.isDefault &&
        context.auxData.frameId === evidence.childFrameId &&
        context.uniqueId,
    );
    assert.equal(
      child?.length,
      1,
      "OOPIF fixture requires its child-session default context",
    );
  }
  if (
    evidence.mode === "nested-oopif" ||
    evidence.mode === "nested-same-process"
  ) {
    assert.ok(
      evidence.descendant,
      "Nested fixture requires independently observed descendant placement",
    );
    assert.equal(evidence.descendant.rootFrameId, evidence.childFrameId);
    assert.equal(
      evidence.descendant.mode,
      evidence.mode === "nested-oopif"
        ? "cross-origin-oopif"
        : "cross-origin-same-process",
    );
    assertRemoteFramePlacement(evidence.descendant);
  }
}

/** Passive native transport evidence, independent from the provider's route receipt. */
export function assertRemoteProviderRoute(options: {
  kind: "click" | "key";
  inputs: ContractInput[];
  root: { sessionId: string; socketId: number };
  placement: FramePlacementEvidence;
  point?: RemoteFixturePoint;
}): void {
  const { kind, inputs, root, placement, point } = options;
  assert.equal(inputs.length, 2);
  const remoteMouse =
    kind === "click" && placement.mode !== "cross-origin-same-process";
  const renderer =
    placement.mode === "nested-oopif" ? placement.descendant! : placement;
  for (const input of inputs) {
    assert.equal(
      input.socketId,
      root.socketId,
      "Pair must remain on the verified provider connection",
    );
    if (remoteMouse) {
      assert.notEqual(input.sessionId, root.sessionId);
      assert.equal(input.route?.targetId, renderer.childSessionTargetId);
      assert.equal(input.route?.frameId, renderer.childFrameId);
      assert.equal(input.route?.parentFrameId, renderer.rootFrameId);
      assert.ok(input.route?.parentSessionId);
      if (placement.mode === "nested-oopif") {
        assert.equal(
          input.route?.parentTargetId,
          placement.childSessionTargetId,
        );
        assert.equal(
          input.route?.grandparentSessionId,
          root.sessionId,
          "Nested renderer ancestry must return to the verified provider root",
        );
      } else assert.equal(input.route?.parentSessionId, root.sessionId);
    } else {
      assert.equal(
        input.sessionId,
        root.sessionId,
        "Keys and same-process mouse remain root routed",
      );
    }
    if (kind === "click") {
      assert.ok(point);
      const expected = !remoteMouse
        ? point
        : placement.mode === "nested-same-process"
          ? { x: point.localPoint.x + 45, y: point.localPoint.y + 55 }
          : point.localPoint;
      assert.ok(
        typeof input.x === "number" && Math.abs(input.x - expected.x) < 0.01,
        "Mouse x must be in the selected renderer-root viewport, not leaf or top coordinates",
      );
      assert.ok(
        typeof input.y === "number" && Math.abs(input.y - expected.y) < 0.01,
        "Mouse y must be in the selected renderer-root viewport, not leaf or top coordinates",
      );
    }
  }
  assert.equal(inputs[0]!.sessionId, inputs[1]!.sessionId);
}

type FixtureCdpEndpoint = Pick<Rpc, "send" | "onEvent">;

export async function observeRemoteFramePlacement(
  rpc: FixtureCdpEndpoint,
  browserRpc: FixtureCdpEndpoint,
  mode: RemoteFrameMode,
  rootUrl: string,
  expectedChildRevision = 0,
): Promise<FramePlacementEvidence> {
  const rootContexts: FixtureExecutionContext[] = [];
  const removeRoot = rpc.onEvent((event) => {
    if (event.method === "Runtime.executionContextCreated")
      rootContexts.push(event.params?.context as FixtureExecutionContext);
  });
  let childSessionId: string | undefined;
  let removeChild: (() => void) | undefined;
  const diagnostic: Record<string, unknown> = { mode, rootUrl };
  try {
    // Re-enabling this independent observer session enumerates its current
    // contexts without consulting provider caches or changing page state.
    await rpc.send("Runtime.disable");
    await rpc.send("Runtime.enable");
    const tree = (await rpc.send("Page.getFrameTree")).frameTree as {
      frame: { id: string; url: string };
      childFrames?: { frame: { id: string; url: string } }[];
    };
    diagnostic.rootTree = tree;
    assert.equal(tree.frame.url, rootUrl);
    // Native Chromium may omit remote children from a renderer's frame tree.
    // Discover the exact authored owner and nonce-bound URL independently, then
    // join the attached child's own frame identity through DOM.getFrameOwner.
    const fixture = remoteFrameFixtureFromUrl(rootUrl);
    const nestedOwner = new URL(rootUrl).pathname === "/remote-frame-child";
    if (nestedOwner) assert.ok(fixture.leafOrigin);
    const childUrl = new URL(
      "/remote-frame-child",
      nestedOwner ? fixture.leafOrigin! : fixture.childOrigin,
    );
    for (const [key, value] of Object.entries(
      nestedOwner
        ? {
            ...fixture,
            parentOrigin: fixture.childOrigin,
            childOrigin: fixture.leafOrigin!,
            leafOrigin: "",
          }
        : fixture,
    ))
      childUrl.searchParams.set(key, value);
    assert.ok(
      Number.isSafeInteger(expectedChildRevision) && expectedChildRevision >= 0,
    );
    if (expectedChildRevision > 0) {
      assert.equal(
        nestedOwner,
        false,
        "Only the top fixture reloads its direct child",
      );
      childUrl.searchParams.set("revision", String(expectedChildRevision));
    }
    const document = (await rpc.send("DOM.getDocument", { depth: 0 })).root as {
      nodeId: number;
    };
    const owners = (
      await rpc.send("DOM.querySelectorAll", {
        nodeId: document.nodeId,
        selector: "iframe",
      })
    ).nodeIds as number[];
    assert.equal(
      owners.length,
      1,
      "Need one actual iframe owner in this parent document",
    );
    const ownerNode = (
      await rpc.send("DOM.describeNode", { nodeId: owners[0], depth: 0 })
    ).node as {
      localName: string;
      backendNodeId: number;
      frameId?: string;
      attributes: string[];
    };
    diagnostic.ownerNode = ownerNode;
    assert.equal(ownerNode.localName, "iframe");
    const attributes = new Map<string, string>();
    for (let index = 0; index < ownerNode.attributes.length; index += 2)
      attributes.set(
        ownerNode.attributes[index]!,
        ownerNode.attributes[index + 1]!,
      );
    assert.equal(
      attributes.get("id"),
      nestedOwner ? "nested-contract-frame" : "contract-frame",
    );
    assert.equal(
      attributes.get("src"),
      childUrl.href,
      "Owner must have the exact authored nonce-bound child URL",
    );
    assert.ok(
      Number.isSafeInteger(ownerNode.backendNodeId) &&
        ownerNode.backendNodeId > 0,
    );
    const targets = (await browserRpc.send("Target.getTargets"))
      .targetInfos as FramePlacementEvidence["targets"];
    diagnostic.targets = targets;
    let child: { id: string; url: string; parentId?: string };
    const childEvidence: Partial<FramePlacementEvidence> = {};
    if (mode === "cross-origin-same-process") {
      assert.equal(
        tree.childFrames?.length,
        1,
        "Same-process child must appear in its parent's renderer tree",
      );
      child = tree.childFrames![0]!.frame;
      assert.equal(child.url, childUrl.href);
    } else {
      const candidates = targets.filter(
        (target) => target.type === "iframe" && target.url === childUrl.href,
      );
      assert.equal(
        candidates.length,
        1,
        "Need one exact nonce-bound OOPIF target before attaching",
      );
      const childTargetId = candidates[0]!.targetId;
      const childContexts: FixtureExecutionContext[] = [];
      const childAttachedEvents: NonNullable<
        FramePlacementEvidence["childAttachedEvent"]
      >[] = [];
      removeChild = browserRpc.onEvent((event) => {
        if (event.method === "Target.attachedToTarget") {
          const params = event.params as unknown as NonNullable<
            FramePlacementEvidence["childAttachedEvent"]
          >;
          if (params.targetInfo.targetId === childTargetId)
            childAttachedEvents.push(params);
        }
        if (
          event.sessionId === childSessionId &&
          event.method === "Runtime.executionContextCreated"
        )
          childContexts.push(event.params?.context as FixtureExecutionContext);
      });
      const attached = await browserRpc.send("Target.attachToTarget", {
        targetId: childTargetId,
        flatten: true,
      });
      assert.equal(typeof attached.sessionId, "string");
      childSessionId = attached.sessionId as string;
      await browserRpc.send("Runtime.enable", {}, childSessionId);
      const childTree = (
        await browserRpc.send("Page.getFrameTree", {}, childSessionId)
      ).frameTree as { frame: { id: string; url: string; parentId?: string } };
      diagnostic.childTree = childTree;
      diagnostic.childAttachedEvents = childAttachedEvents;
      assert.equal(
        childAttachedEvents.length,
        1,
        "Need exactly one trusted attachment for the observed child target",
      );
      child = childTree.frame;
      assert.equal(child.url, childUrl.href);
      if (child.parentId !== undefined)
        assert.equal(child.parentId, tree.frame.id);
      const reportedChildren = tree.childFrames ?? [];
      assert.ok(
        reportedChildren.length <= 1,
        "Parent tree must not contain additional children",
      );
      if (reportedChildren.length === 1)
        assert.deepEqual(
          {
            id: reportedChildren[0]!.frame.id,
            url: reportedChildren[0]!.frame.url,
          },
          { id: child.id, url: child.url },
          "A supplied remote placeholder must match the child-session frame",
        );
      Object.assign(childEvidence, {
        childSessionId,
        childSessionTargetId: childTargetId,
        childAttachedEvent: childAttachedEvents[0],
        childSessionFrameId: child.id,
        childSessionParentFrameId: child.parentId,
        childContexts,
      });
    }
    const owner = await rpc.send("DOM.getFrameOwner", { frameId: child.id });
    assert.equal(
      owner.backendNodeId,
      ownerNode.backendNodeId,
      "Child-session frame must belong to the exact authored parent owner",
    );
    if (ownerNode.frameId !== undefined)
      assert.equal(ownerNode.frameId, child.id);
    const evidence: FramePlacementEvidence = {
      mode,
      rootFrameId: tree.frame.id,
      childFrameId: child.id,
      rootContexts,
      targets,
      childUrl: child.url,
      ownerBackendNodeId: ownerNode.backendNodeId,
      parentTreeChildFrames: (tree.childFrames ?? []).map(({ frame }) => ({
        id: frame.id,
        url: frame.url,
      })),
      ...childEvidence,
    };
    if (mode === "nested-oopif" || mode === "nested-same-process") {
      removeChild?.();
      removeChild = undefined;
      assert.ok(childSessionId);
      const parentSessionId = childSessionId;
      const childRpc: FixtureCdpEndpoint = {
        send: async (method, params = {}) =>
          await browserRpc.send(method, params, parentSessionId),
        onEvent: (listener) =>
          browserRpc.onEvent((event) => {
            if (event.sessionId === parentSessionId) listener(event);
          }),
      };
      evidence.descendant = await observeRemoteFramePlacement(
        childRpc,
        browserRpc,
        mode === "nested-oopif"
          ? "cross-origin-oopif"
          : "cross-origin-same-process",
        child.url,
      );
    }
    assertRemoteFramePlacement(evidence);
    return evidence;
  } catch (error) {
    console.error("Remote frame placement failure", JSON.stringify(diagnostic));
    throw error;
  } finally {
    removeRoot();
    removeChild?.();
    if (childSessionId)
      await browserRpc.send("Target.detachFromTarget", {
        sessionId: childSessionId,
      });
  }
}

/** Independent protocol diagnostics, never retries or provider acceptance. */
async function runRemoteFrameRouteDiagnostics(options: {
  backend: ZenXBrowserBackend;
  sessionId: string;
  endpoint: string;
  url: string;
  browserRpc: FixtureCdpEndpoint;
  guard(): Promise<void>;
  report(receipt: Record<string, unknown>): void;
}): Promise<void> {
  const { backend, sessionId, browserRpc, guard } = options;
  // Both sequences are planned before input. A failed case cannot select a
  // fallback route on its target; each case physically retires its own tab.
  for (const route of ["root-pair", "child-session-pair"] as const) {
    const url = new URL(options.url);
    url.searchParams.set("nonce", randomUUID());
    assert.equal(url.searchParams.get("mode"), "cross-origin-oopif");
    const owned = await backend.open(sessionId, url.href);
    let rpc: Rpc | undefined;
    let childSessionId: string | undefined;
    let removeChild: (() => void) | undefined;
    let fatalSafetyError: unknown;
    let childLifecycleInvalidatedBy: string | undefined;
    let admittedChildContext: FixtureExecutionContext | undefined;
    const receipt: Record<string, unknown> = {
      scenario: "independent-remote-protocol-route",
      layer: "protocol-diagnostic-only",
      providerAcceptance: "not-exercised",
      nativeExtensionRouting: "not-exercised",
      platform: process.platform,
      route,
      ownedTargetId: owned.tabId,
      dispatchAttempts: 0,
      acknowledgedDispatches: 0,
      settlementReads: 0,
      outcome: "inconclusive",
    };
    const checkForeground = async (stage: string) => {
      receipt.stage = stage;
      try {
        await guard();
      } catch (error) {
        fatalSafetyError = error;
        receipt.fatalSafetyFailure = true;
        receipt.foregroundGuardError ??= String(error);
        receipt.foregroundGuardErrorAt ??= stage;
        throw error;
      }
    };
    const checkHidden = (current: ContractState, stage: string) => {
      try {
        assert.equal(
          current.visibility,
          "hidden",
          "Diagnostic target must stay hidden",
        );
        assert.equal(
          current.childVisibility,
          "hidden",
          "Diagnostic child must stay hidden",
        );
      } catch (error) {
        fatalSafetyError = error;
        receipt.fatalSafetyFailure = true;
        receipt.visibilityGuardError ??= String(error);
        receipt.visibilityGuardErrorAt ??= stage;
        throw error;
      }
    };
    const checkChildLifecycle = () =>
      assert.equal(
        childLifecycleInvalidatedBy,
        undefined,
        "Diagnostic child context/session changed; never dispatch to a replacement",
      );
    try {
      const target = await poll(async () => {
        const targets = (await (
          await fetch(`${options.endpoint}/json/list`, {
            redirect: "error",
            signal: AbortSignal.timeout(5_000),
          })
        ).json()) as Target[];
        return targets.find((target) => target.id === owned.tabId);
      }, "dedicated route-diagnostic target");
      rpc = await Rpc.connect(target.webSocketDebuggerUrl);
      const fixture = rpc;
      await poll(
        async () =>
          (await fixture.evaluate<boolean>("window.contract?.ready === true"))
            ? true
            : undefined,
        "route-diagnostic remote child",
      );
      const placement = await observeRemoteFramePlacement(
        fixture,
        browserRpc,
        "cross-origin-oopif",
        url.href,
      );
      receipt.placement = placement;
      if (route === "child-session-pair") {
        const childContexts: FixtureExecutionContext[] = [];
        const attachedEvents: NonNullable<
          FramePlacementEvidence["childAttachedEvent"]
        >[] = [];
        removeChild = browserRpc.onEvent((event) => {
          if (event.method === "Target.attachedToTarget") {
            const attached = event.params as unknown as NonNullable<
              FramePlacementEvidence["childAttachedEvent"]
            >;
            if (attached.targetInfo.targetId === placement.childSessionTargetId)
              attachedEvents.push(attached);
          }
          const invalidate = (reason: string) => {
            childLifecycleInvalidatedBy ??= reason;
            receipt.childLifecycleInvalidatedBy = childLifecycleInvalidatedBy;
          };
          if (
            event.method === "Target.detachedFromTarget" &&
            ((childSessionId && event.params?.sessionId === childSessionId) ||
              event.params?.targetId === placement.childSessionTargetId)
          )
            invalidate(event.method);
          if (event.sessionId !== childSessionId || !childSessionId) return;
          if (
            event.method === "Runtime.executionContextsCleared" ||
            event.method === "Runtime.executionContextDestroyed"
          )
            invalidate(event.method);
          if (event.method === "Runtime.executionContextCreated") {
            const context = event.params?.context as FixtureExecutionContext;
            childContexts.push(context);
            if (
              context.auxData?.isDefault &&
              (admittedChildContext ||
                context.uniqueId !==
                  placement.childContexts!.find(
                    (value) => value.auxData.isDefault,
                  )?.uniqueId)
            )
              invalidate("default-context-replaced");
          }
        });
        const attached = await browserRpc.send("Target.attachToTarget", {
          targetId: placement.childSessionTargetId,
          flatten: true,
        });
        assert.equal(typeof attached.sessionId, "string");
        childSessionId = attached.sessionId as string;
        await browserRpc.send("Runtime.enable", {}, childSessionId);
        const tree = (
          await browserRpc.send("Page.getFrameTree", {}, childSessionId)
        ).frameTree as {
          frame: { id: string; url: string; parentId?: string };
        };
        assert.equal(tree.frame.url, placement.childUrl);
        assert.equal(attachedEvents.length, 1);
        const current = {
          ...placement,
          childSessionId,
          childAttachedEvent: attachedEvents[0],
          childSessionFrameId: tree.frame.id,
          childSessionParentFrameId: tree.frame.parentId,
          childContexts,
        };
        assertRemoteFramePlacement(current);
        assert.deepEqual(
          childContexts
            .filter((context) => context.auxData.isDefault)
            .map((context) => context.uniqueId),
          placement
            .childContexts!.filter((context) => context.auxData.isDefault)
            .map((context) => context.uniqueId),
          "Diagnostic attachment must retain the exact child document context",
        );
        const owner = await fixture.send("DOM.getFrameOwner", {
          frameId: tree.frame.id,
        });
        assert.equal(owner.backendNodeId, placement.ownerBackendNodeId);
        admittedChildContext = childContexts.find(
          (context) => context.auxData.isDefault,
        );
        assert.ok(admittedChildContext);
        checkChildLifecycle();
        receipt.dispatchSessionEvidence = current;
      }
      const capture = await fixture.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      assert.ok(typeof capture.data === "string" && capture.data.length > 0);
      const position = await fixture.evaluate<RemoteFixturePoint>(
        "window.contract.point('canvas')",
      );
      receipt.position = position;
      assertRemoteFixturePoint(position, "canvas", 1);
      const before = await fixture.evaluate<ContractState>(
        "window.contract.state()",
      );
      receipt.before = before;
      checkHidden(before, "setup");
      assert.equal(before.documentId, position.documentId);
      assert.equal(before.events.length, 0);
      assert.equal(before.routeEvents?.length, 0);
      assert.equal(before.rootEvents?.length, 0);
      assert.equal(before.clicks, 0);
      await checkForeground("before-pair");
      const point =
        route === "root-pair"
          ? { x: position.x, y: position.y }
          : position.localPoint;
      receipt.inputPoint = point;
      receipt.setupVerified = true;
      for (const type of ["mousePressed", "mouseReleased"]) {
        if (route === "child-session-pair") {
          checkChildLifecycle();
          assert.ok(childSessionId && admittedChildContext);
          const document = await browserRpc.send(
            "Runtime.evaluate",
            {
              expression: "document.URL",
              uniqueContextId: admittedChildContext.uniqueId,
              returnByValue: true,
              awaitPromise: false,
            },
            childSessionId,
          );
          assert.equal(
            document.exceptionDetails,
            undefined,
            "Exact diagnostic child context must remain live",
          );
          assert.equal(
            (document.result as { value: string }).value,
            placement.childUrl,
          );
        }
        const current = await fixture.evaluate<ContractState>(
          "window.contract.state()",
        );
        checkHidden(current, `before-${type}`);
        assert.equal(
          current.documentId,
          before.documentId,
          "Diagnostic child document changed before dispatch",
        );
        await checkForeground(`before-${type}`);
        checkChildLifecycle();
        receipt.dispatchAttempts = Number(receipt.dispatchAttempts) + 1;
        const params = {
          type,
          ...point,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        };
        if (route === "root-pair")
          await fixture.send("Input.dispatchMouseEvent", params);
        else {
          assert.ok(childSessionId);
          await browserRpc.send(
            "Input.dispatchMouseEvent",
            params,
            childSessionId,
          );
        }
        receipt.acknowledgedDispatches =
          Number(receipt.acknowledgedDispatches) + 1;
        await checkForeground(`after-${type}`);
        const afterEvent = await fixture.evaluate<ContractState>(
          "window.contract.state()",
        );
        receipt.after = afterEvent;
        checkHidden(afterEvent, `after-${type}`);
        checkChildLifecycle();
      }
      await settleRemoteFixturePair(
        async () => {
          await checkForeground("read-only-settlement");
          const current = await fixture.evaluate<ContractState>(
            "window.contract.state()",
          );
          receipt.after = current;
          checkHidden(current, "read-only-settlement");
          checkChildLifecycle();
          receipt.settlementReads = Number(receipt.settlementReads) + 1;
          return current;
        },
        before,
        "click",
        "canvas",
      );
      receipt.outcome = "observed-exact-leaf-pair-and-effect";
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : String(error);
    } finally {
      // Even a failed/unknown press retires this exact owned target. Never
      // release/retry on another session, and do not run another case if close fails.
      removeChild?.();
      if (childSessionId) {
        try {
          await browserRpc.send("Target.detachFromTarget", {
            sessionId: childSessionId,
          });
        } catch (error) {
          receipt.detachError = String(error);
        }
      }
      rpc?.close();
      try {
        try {
          await backend.closeTab(sessionId, owned.tabId);
        } catch (error) {
          receipt.providerDetachError = String(error);
        }
        const closed = await browserRpc.send("Target.closeTarget", {
          targetId: owned.tabId,
        });
        assert.equal(
          closed.success,
          true,
          "Exact diagnostic target must physically close",
        );
        await poll(async () => {
          const targets = (await (
            await fetch(`${options.endpoint}/json/list`, {
              redirect: "error",
              signal: AbortSignal.timeout(5_000),
            })
          ).json()) as Target[];
          return targets.some((target) => target.id === owned.tabId)
            ? undefined
            : true;
        }, "physical route-diagnostic target closure");
        receipt.physicallyClosed = true;
        await checkForeground("after-physical-close");
      } catch (error) {
        receipt.teardownError = String(error);
        throw error;
      } finally {
        options.report(receipt);
        console.log(
          "Independent remote protocol route",
          JSON.stringify(receipt),
        );
      }
    }
    if (receipt.fatalSafetyFailure) throw fatalSafetyError;
  }
}

/** Intentional unknown outcome owns a separate tab and physically closes it. */
async function runInterruptedRemoteFrameSmoke(options: {
  backend: ZenXBrowserBackend;
  sessionId: string;
  endpoint: string;
  url: string;
  browserRpc: Pick<Rpc, "send">;
  inputs: ContractInput[];
  guard(): Promise<void>;
  onFailure?(receipt: Record<string, unknown>): void;
}): Promise<Record<string, unknown>> {
  const { backend, sessionId, inputs, guard } = options;
  const owned = await backend.open(sessionId, options.url);
  let rpc: Rpc | undefined;
  const inputStart = inputs.length;
  const diagnostic: Record<string, unknown> = {
    scenario: "remote-document-open-after-press",
    ownedTargetId: owned.tabId,
    setup: "not-ready",
    pointerCalls: 0,
  };
  try {
    const target = await poll(async () => {
      const targets = (await (
        await fetch(`${options.endpoint}/json/list`, {
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        })
      ).json()) as Target[];
      return targets.find((target) => target.id === owned.tabId);
    }, "dedicated interrupted-input target");
    rpc = await Rpc.connect(target.webSocketDebuggerUrl);
    const fixture = rpc;
    await poll(
      async () =>
        (await fixture.evaluate<boolean>("window.contract?.ready === true"))
          ? true
          : undefined,
      "dedicated remote child",
    );
    await guard();
    assert.equal(await fixture.evaluate("document.visibilityState"), "hidden");
    // Explicit read-only setup absorbs first observer/owner discovery before
    // the final authorizing capture. Never repair geometry or replay an action.
    const discovery = await backend.inspect(sessionId, owned.tabId);
    assert.equal(discovery.screenshot.status, "captured");
    assert.equal(inputs.length, inputStart);
    diagnostic.discoveryInputAvailable = Boolean(discovery.inputViewport);
    const screenshot = await fixture.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    assert.ok(
      typeof screenshot.data === "string" && screenshot.data.length > 0,
    );
    const before = await fixture.evaluate<
      ContractState & { documentId: string }
    >("window.contract.state()");
    const position = await fixture.evaluate<RemoteFixturePoint>(
      "window.contract.point('canvas')",
    );
    assertRemoteFixturePoint(
      position,
      "canvas",
      before.mode.startsWith("nested-") ? 2 : 1,
    );
    assert.equal(position.documentId, before.documentId);
    assert.equal(before.visibility, "hidden");
    assert.equal(before.childVisibility, "hidden");
    await guard();
    diagnostic.before = before;
    diagnostic.position = position;
    diagnostic.setup = "read-only-discovery-compositor-and-geometry-verified";
    assert.deepEqual(await fixture.evaluate("window.contract.armReplace()"), {
      armed: true,
    });
    const capture = async () =>
      await poll(async () => {
        const count = inputs.length;
        const observed = await backend.inspect(sessionId, owned.tabId);
        assert.equal(observed.screenshot.status, "captured");
        assert.equal(
          inputs.length,
          count,
          "Interrupted-target inspection must never dispatch Input",
        );
        await guard();
        return observed.inputViewport ? observed : undefined;
      }, "interrupted-target coherent capture (read-only)");
    const observed = await capture();
    const start = inputs.length;
    let reason = "";
    await assert.rejects(
      () => {
        diagnostic.pointerCalls = Number(diagnostic.pointerCalls) + 1;
        return backend.pointerClick!(
          sessionId,
          owned.tabId,
          observed.observationId,
          position.x,
          position.y,
        );
      },
      (error) => {
        diagnostic.originalError =
          error instanceof Error
            ? {
                name: error.name,
                constructor: error.constructor.name,
                message: error.message,
                stack: error.stack,
                cause: String(error.cause ?? ""),
              }
            : { message: String(error) };
        diagnostic.inputAttempts = inputs.slice(inputStart);
        const rawHeldUnknown =
          error instanceof UserBrowserMutationOutcomeUnknownError &&
          error.message.startsWith(
            "Browser targeted input outcome is unknown (",
          );
        assert.ok(
          error instanceof BrowserInputOutcomeUnknownError || rawHeldUnknown,
          `Expected typed targeted-input unknown after the intended press; got ${error instanceof Error ? error.constructor.name + ": " + error.message : String(error)}; observed Input attempts=${inputs.length - inputStart}`,
        );
        if (error instanceof BrowserInputOutcomeUnknownError)
          assert.equal(error.inputMayRemainPressed, true);
        reason = error instanceof Error ? error.message : String(error);
        return true;
      },
    );
    assert.deepEqual(
      inputs
        .slice(start)
        .map((event) => ({ method: event.method, type: event.type })),
      [{ method: "Input.dispatchMouseEvent", type: "mousePressed" }],
      "A changed child must never receive a successor release",
    );
    const after = await fixture.evaluate<
      ContractState & { documentId: string }
    >("window.contract.state()");
    assert.notEqual(after.documentId, before.documentId);
    assert.deepEqual(after.events.slice(before.events.length), [
      { type: "pointerdown", trusted: true, target: "canvas" },
    ]);
    assert.equal(after.clicks, before.clicks);
    assert.equal(after.visibility, "hidden");
    // A fresh, deliberate different action confirms the held-input fence. It is
    // not a retry or release of the unknown earlier click.
    // Quarantine intentionally withholds authorizing input metadata. A single
    // ordinary read remains available; never wait for an input-ready capture.
    const fresh = await backend.inspect(sessionId, owned.tabId);
    assert.equal(fresh.screenshot.status, "captured");
    assert.equal(fresh.inputViewport, undefined);
    await guard();
    await assert.rejects(
      () =>
        backend.keyPress!(sessionId, owned.tabId, fresh.observationId, "Space"),
      /blocked|held|pressed|close.*tab/iu,
    );
    assert.equal(inputs.length, start + 1);
    assert.deepEqual(
      (await fixture.evaluate<ContractState>("window.contract.state()")).events,
      after.events,
    );
    await guard();
    return {
      scenario: "remote-document-open-after-press",
      layer: "headed-provider-cdp-contract",
      nativeExtensionRouting: "not-exercised",
      status: "passed",
      inputDispatches: 1,
      successorReleaseDispatches: 0,
      quarantined: true,
      reason,
    };
  } catch (error) {
    diagnostic.error = error instanceof Error ? error.message : String(error);
    diagnostic.inputAttempts = inputs.slice(inputStart);
    options.onFailure?.(diagnostic);
    console.error(
      "Interrupted remote fixture failure",
      JSON.stringify(diagnostic),
    );
    throw error;
  } finally {
    rpc?.close();
    // Provider closeTab settles only its logical attachment; it is not physical
    // Chrome closure and cannot release the possibly held input by itself.
    try {
      await backend.closeTab(sessionId, owned.tabId);
    } finally {
      const closed = await options.browserRpc.send("Target.closeTarget", {
        targetId: owned.tabId,
      });
      assert.equal(
        closed.success,
        true,
        "The exact positively-created disposable target must physically close",
      );
    }
    await poll(async () => {
      const targets = (await (
        await fetch(`${options.endpoint}/json/list`, {
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        })
      ).json()) as Target[];
      return targets.some((target) => target.id === owned.tabId)
        ? undefined
        : true;
    }, "physical interrupted-input target closure");
    await guard();
  }
}

/** Real protocol acceptance, shared by both headed smoke entry points. */
export async function runTargetedInputContractSmoke(options: {
  backend: ZenXBrowserBackend;
  sessionId: string;
  tabId: string;
  endpoint: string;
  origin: string;
  guard(): Promise<void>;
  onPhase?(phase: string): void;
  onFailure?(diagnostic: Record<string, unknown>): void;
  remoteFrameInput?: "supported" | "unsupported";
}): Promise<Record<string, unknown>[]> {
  const { backend, sessionId, tabId, endpoint, origin, guard } = options;
  assert.ok(backend.pointerClick && backend.keyPress);
  const targets = (await (
    await fetch(`${endpoint}/json/list`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    })
  ).json()) as Target[];
  const target = targets.find((entry) => entry.id === tabId);
  assert.ok(target, "Contract smoke needs the already-owned inactive target");
  const version = (await (
    await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    })
  ).json()) as { webSocketDebuggerUrl: string };
  const rpc = await Rpc.connect(target.webSocketDebuggerUrl);
  const placementRpc = await Rpc.connect(version.webSocketDebuggerUrl);
  const remoteServer = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("Origin-Agent-Cluster", "?0");
    try {
      assert.equal(
        new URL(request.url ?? "", origin).pathname,
        "/remote-frame-child",
      );
      response.end(
        remoteFrameContractPage(
          "child",
          remoteFrameFixtureFromUrl(request.url!),
        ),
      );
    } catch {
      response.statusCode = 400;
      response.end("Invalid disposable fixture request");
    }
  });
  const inputs: ContractInput[] = [];
  const reports: Record<string, unknown>[] = [];
  let remoteWitness: Record<string, unknown> | undefined;
  const protocolRouteDiagnostics: Record<string, unknown>[] = [];
  const interruptedRouteFailures: Record<string, unknown>[] = [];
  // A passive, scoped tap on actual outgoing ws messages. No mock transport,
  // rewritten events, retries, tracker access or synthetic trusted-event shims.
  // Only provider Input is counted. The independent placement/diagnostic
  // socket is excluded even when its explicit child-session probe sends Input.
  const originalSend = WebSocket.prototype.send;
  const providerSockets = new Map<
    WebSocket,
    {
      id: number;
      sessions: Map<string, NonNullable<ContractInput["route"]>>;
      pendingTrees: Map<number, string>;
      listener(raw: unknown): void;
    }
  >();
  let providerRootSession: { sessionId: string; socketId: number } | undefined;
  let providerPlacement: FramePlacementEvidence | undefined;
  WebSocket.prototype.send = function (this: WebSocket, ...args: unknown[]) {
    if (
      this.url === version.webSocketDebuggerUrl &&
      this !== placementRpc.socket &&
      typeof args[0] === "string"
    ) {
      let observed = providerSockets.get(this);
      if (!observed) {
        const sessions = new Map<string, NonNullable<ContractInput["route"]>>();
        const pendingTrees = new Map<number, string>();
        const listener = (raw: unknown) => {
          const event = JSON.parse(String(raw)) as {
            id?: number;
            method?: string;
            sessionId?: string;
            params?: {
              sessionId?: string;
              targetInfo?: { targetId: string; type: string };
            };
            result?: {
              frameTree?: { frame?: { id: string; parentId?: string } };
            };
          };
          if (
            event.method === "Target.attachedToTarget" &&
            event.params?.sessionId &&
            event.params.targetInfo?.type === "iframe"
          ) {
            sessions.set(event.params.sessionId, {
              targetId: event.params.targetInfo.targetId,
              parentSessionId: event.sessionId,
            });
          } else if (
            event.method === "Target.detachedFromTarget" &&
            event.params?.sessionId
          ) {
            sessions.delete(event.params.sessionId);
          } else if (event.id !== undefined && pendingTrees.has(event.id)) {
            const session = pendingTrees.get(event.id)!;
            pendingTrees.delete(event.id);
            const frame = event.result?.frameTree?.frame;
            if (frame && event.sessionId === session)
              sessions.set(session, {
                ...sessions.get(session),
                frameId: frame.id,
                parentFrameId: frame.parentId,
              });
          }
        };
        observed = {
          id: providerSockets.size + 1,
          sessions,
          pendingTrees,
          listener,
        };
        providerSockets.set(this, observed);
        this.on("message", listener);
      }
      const message = JSON.parse(args[0]) as {
        id?: number;
        method?: string;
        sessionId?: string;
        params?: { type?: string; x?: number; y?: number };
      };
      if (
        message.method === "Page.getFrameTree" &&
        message.id !== undefined &&
        message.sessionId
      )
        observed.pendingTrees.set(message.id, message.sessionId);
      if (message.method?.startsWith("Input.")) {
        assert.ok(
          message.sessionId,
          "Provider Input must bind an exact CDP session",
        );
        const route = observed.sessions.get(message.sessionId);
        inputs.push({
          method: message.method,
          type: message.params?.type ?? "",
          sessionId: message.sessionId,
          socketId: observed.id,
          route: {
            ...route,
            parentTargetId: route?.parentSessionId
              ? observed.sessions.get(route.parentSessionId)?.targetId
              : undefined,
            grandparentSessionId: route?.parentSessionId
              ? observed.sessions.get(route.parentSessionId)?.parentSessionId
              : undefined,
          },
          ...(message.params?.x !== undefined
            ? { x: message.params.x, y: message.params.y }
            : {}),
        });
      }
    }
    return Reflect.apply(originalSend, this, args);
  };
  const state = async () =>
    await rpc.evaluate<ContractState>("window.contract.state()");
  let withheldCaptures = 0;
  const inspect = async () => {
    const inputIndex = inputs.length;
    // A frame's first layout may invalidate a captured image. Wait only through
    // fresh read-only inspections; never replay input or loosen provider fences.
    return await poll(async () => {
      const observation = await backend.inspect(sessionId, tabId);
      assert.equal(observation.screenshot.status, "captured");
      assert.equal(
        inputs.length,
        inputIndex,
        "Inspection must not dispatch input",
      );
      await guard();
      if (!observation.inputViewport) {
        withheldCaptures++;
        options.onPhase?.(
          `input-contracts:withheld-capture:${withheldCaptures}`,
        );
        return undefined;
      }
      return observation;
    }, "contract coherent screenshot (read-only capture settlement)");
  };
  const focus = async (id: string) =>
    await rpc.evaluate<{ outer: string; inner: string }>(
      `window.contract.focus(${JSON.stringify(id)})`,
    );
  const point = async (id: string) =>
    await rpc.evaluate<{ x: number; y: number }>(
      `window.contract.point(${JSON.stringify(id)})`,
    );
  const paired = async (
    kind: "click" | "key",
    id: string,
    key: "Space" | "Enter" = "Space",
  ) => {
    if (kind === "key") assert.equal((await focus(id)).inner, id);
    const position = kind === "click" ? await point(id) : undefined;
    const observation = await inspect();
    if (kind === "key") assert.equal(observation.focusedInputAvailable, true);
    const before = await state();
    if (position && isRemoteFrameMode(before.mode))
      assertRemoteFixturePoint(
        position as RemoteFixturePoint,
        id,
        before.mode.startsWith("nested-") ? 2 : 1,
      );
    const inputIndex = inputs.length;
    if (position)
      await backend.pointerClick!(
        sessionId,
        tabId,
        observation.observationId,
        position.x,
        position.y,
      );
    else
      await backend.keyPress!(sessionId, tabId, observation.observationId, key);
    const dispatched = inputs.slice(inputIndex);
    assert.equal(
      dispatched.length,
      2,
      "Normal input must send exactly its planned pair",
    );
    assert.equal(
      dispatched[0]!.sessionId,
      dispatched[1]!.sessionId,
      "Both events must use the same target session",
    );
    assert.deepEqual(
      dispatched.map((event) => event.method),
      Array(2).fill(
        kind === "click"
          ? "Input.dispatchMouseEvent"
          : "Input.dispatchKeyEvent",
      ),
    );
    assert.deepEqual(
      dispatched.map((event) => event.type),
      kind === "click"
        ? ["mousePressed", "mouseReleased"]
        : ["keyDown", "keyUp"],
    );
    if (isRemoteFrameMode(before.mode)) {
      assert.ok(providerRootSession && providerPlacement);
      assertRemoteProviderRoute({
        kind,
        inputs: dispatched,
        root: providerRootSession,
        placement: providerPlacement,
        point: position as RemoteFixturePoint | undefined,
      });
    } else {
      assert.ok(dispatched[0]!.socketId);
      const currentRoot = {
        sessionId: dispatched[0]!.sessionId,
        socketId: dispatched[0]!.socketId!,
      };
      if (providerRootSession)
        assert.deepEqual(currentRoot, providerRootSession);
      else providerRootSession = currentRoot;
    }
    const after = isRemoteFrameMode(before.mode)
      ? (
          await settleRemoteFixturePair(
            async () => {
              await guard();
              return await state();
            },
            before,
            kind,
            id,
          )
        ).state
      : await state();
    const observedEvents = after.events.slice(before.events.length);
    assert.deepEqual(
      observedEvents.map((event) => event.type),
      kind === "click" ? ["pointerdown", "pointerup"] : ["keydown", "keyup"],
    );
    assert.ok(
      observedEvents.every((event) => event.trusted && event.target === id),
      "The real trusted pair must reach the exact fixture element",
    );
    if (kind === "click")
      assert.equal(after.clicks, before.clicks + Number(id === "canvas"));
    else if (key === "Space" && id in before.values)
      assert.equal(after.values[id], before.values[id] + " ");
    if (kind === "click" && ["button-span", "widget"].includes(id))
      assert.equal(after.widgets[id], (before.widgets[id] ?? 0) + 1);
    await guard();
    return dispatched;
  };
  const rejected = async (
    label: string,
    action: () => Promise<unknown>,
    expected: RegExp | "shadow-surface",
  ) => {
    const inputIndex = inputs.length;
    const before = await state();
    let reason = "";
    await assert.rejects(action, (error: unknown) => {
      reason = error instanceof Error ? error.message : String(error);
      if (typeof expected === "string") {
        assert.ok(error instanceof BrowserInputUnsupportedError);
        assert.equal(error.code, "BROWSER_INPUT_UNSUPPORTED");
        assert.equal(error.reason, expected);
      } else assert.match(reason, expected);
      return true;
    });
    assert.equal(
      inputs.length,
      inputIndex,
      `${label} must reject before ANY Input dispatch`,
    );
    assert.deepEqual(
      (await state()).events,
      before.events,
      `${label} must not deliver a trusted press`,
    );
    await guard();
    return { case: label, inputDispatches: 0, reason };
  };
  try {
    await new Promise<void>((resolve, reject) => {
      remoteServer.once("error", reject);
      remoteServer.listen(0, "127.0.0.1", resolve);
    });
    const remoteAddress = remoteServer.address();
    assert.ok(remoteAddress && typeof remoteAddress !== "string");
    for (const mode of [
      "stop-propagation",
      "stop-immediate",
      "shadow",
      "light-native",
      "same-origin-frame",
      "affine-frame",
      "same-origin-closed-shadow",
      "closed-shadow",
      "deep-shadow",
      "ordinary-dom",
      ...remoteFrameModes,
    ]) {
      remoteWitness = undefined;
      const withheldBefore = withheldCaptures;
      options.onPhase?.(`input-contracts:${mode}:navigate`);
      await guard();
      const remoteMode = isRemoteFrameMode(mode);
      const contractUrl = new URL("/input-contract", origin);
      contractUrl.searchParams.set("mode", mode);
      if (remoteMode) {
        contractUrl.searchParams.set("parentOrigin", origin);
        contractUrl.searchParams.set(
          "childOrigin",
          `http://${mode === "cross-origin-same-process" ? "127.0.0.1" : "localhost"}:${remoteAddress.port}`,
        );
        contractUrl.searchParams.set("nonce", randomUUID());
        if (mode.startsWith("nested-"))
          contractUrl.searchParams.set("outerAffine", "true");
        if (mode === "nested-oopif")
          contractUrl.searchParams.set(
            "leafOrigin",
            `http://nested.localhost:${remoteAddress.port}`,
          );
        if (mode === "nested-same-process")
          contractUrl.searchParams.set(
            "leafOrigin",
            origin.replace("127.0.0.1", "localhost"),
          );
      }
      await backend.navigate(sessionId, tabId, contractUrl.href);
      await poll(async () => {
        const ready = await rpc.evaluate<boolean>(
          `window.contract?.mode === ${JSON.stringify(mode)} && ${remoteMode ? "window.contract.ready === true" : "true"}`,
        );
        assert.equal(
          typeof ready,
          "boolean",
          "Fixture readiness must be boolean",
        );
        return ready ? true : undefined;
      }, `contract ${mode} document`);
      options.onPhase?.(`input-contracts:${mode}:actions`);
      assert.equal(
        (await state()).visibility,
        "hidden",
        "Contract page must stay inactive",
      );
      const cases: Record<string, unknown>[] = [];
      if (mode === "closed-shadow" || mode === "same-origin-closed-shadow") {
        // Establish trusted closed-root observation before an authorizing capture.
        // This is an explicit read, never replay of a refused input operation.
        const discovery = await backend.inspect(sessionId, tabId);
        cases.push({
          case: "closed-root-observer-discovery",
          screenshot: discovery.screenshot.status,
        });
      }
      if (remoteMode) {
        if (mode === "cross-origin-oopif") {
          options.onPhase?.(
            "input-contracts:independent-remote-route-diagnostics",
          );
          await runRemoteFrameRouteDiagnostics({
            backend,
            sessionId,
            endpoint,
            url: contractUrl.href,
            browserRpc: placementRpc,
            guard,
            report: (receipt) => protocolRouteDiagnostics.push(receipt),
          });
          options.onPhase?.(`input-contracts:${mode}:actions`);
          cases.push({
            case: "independent-protocol-route-diagnostics",
            receipts: protocolRouteDiagnostics,
          });
        }
        const placement = await observeRemoteFramePlacement(
          rpc,
          placementRpc,
          mode,
          contractUrl.href,
        );
        providerPlacement = placement;
        cases.push({ case: "observed-frame-process-placement", ...placement });
        // Root mouse delivery to OOPIFs is measured only on the independent
        // disposable diagnostics. Its known platform limitation must not gate a
        // separately preselected provider child route. Provider success below
        // still requires the exact real trusted pair and effect in every mode.
        const directKinds: ("click" | "key")[] =
          mode === "cross-origin-same-process" ? ["click", "key"] : ["key"];
        for (const kind of directKinds) {
          const id = kind === "click" ? "canvas" : "text-a";
          if (kind === "key") assert.equal((await focus(id)).inner, id);
          const before = await state();
          remoteWitness = {
            mode,
            layer: "direct-root-cdp-fixture-oracle",
            kind,
            id,
            placement,
            before,
            dispatchAttempts: 0,
            acknowledgedDispatches: 0,
            settlementReads: 0,
          };
          const screenshot = await rpc.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          });
          assert.ok(
            typeof screenshot.data === "string" && screenshot.data.length > 0,
            "Direct fixture needs a real read-only compositor capture before input",
          );
          remoteWitness.compositorCaptured = true;
          await guard();
          if (kind === "click") {
            const position = await rpc.evaluate<RemoteFixturePoint>(
              `window.contract.point(${JSON.stringify(id)})`,
            );
            remoteWitness.position = position;
            console.log(
              "Remote frame fixture point",
              JSON.stringify({ mode, position }),
            );
            assertRemoteFixturePoint(
              position,
              id,
              mode.startsWith("nested-") ? 2 : 1,
            );
            assert.equal(position.documentId, before.documentId);
            for (const type of ["mousePressed", "mouseReleased"]) {
              remoteWitness.dispatchAttempts =
                Number(remoteWitness.dispatchAttempts) + 1;
              await rpc.send("Input.dispatchMouseEvent", {
                type,
                x: position.x,
                y: position.y,
                button: "left",
                buttons: type === "mousePressed" ? 1 : 0,
                clickCount: 1,
              });
              remoteWitness.acknowledgedDispatches =
                Number(remoteWitness.acknowledgedDispatches) + 1;
            }
          } else {
            for (const type of ["keyDown", "keyUp"]) {
              remoteWitness.dispatchAttempts =
                Number(remoteWitness.dispatchAttempts) + 1;
              await rpc.send("Input.dispatchKeyEvent", {
                type,
                key: " ",
                code: "Space",
                windowsVirtualKeyCode: 32,
                ...(type === "keyDown" ? { text: " " } : {}),
              });
              remoteWitness.acknowledgedDispatches =
                Number(remoteWitness.acknowledgedDispatches) + 1;
            }
          }
          const witness = remoteWitness;
          const settled = await settleRemoteFixturePair(
            async () => {
              await guard();
              const current = await state();
              witness.after = current;
              witness.settlementReads = Number(witness.settlementReads) + 1;
              return current;
            },
            before,
            kind,
            id,
          );
          const after = settled.state;
          assert.deepEqual(
            after.events.slice(before.events.length).map((event) => ({
              type: event.type,
              trusted: event.trusted,
              target: event.target,
            })),
            (kind === "click"
              ? ["pointerdown", "pointerup"]
              : ["keydown", "keyup"]
            ).map((type) => ({ type, trusted: true, target: id })),
          );
          if (kind === "click") assert.equal(after.clicks, before.clicks + 1);
          else assert.equal(after.values[id], before.values[id] + " ");
          assert.equal(after.visibility, "hidden");
          await guard();
          remoteWitness.status = "passed";
          cases.push({
            case: `child-${kind}-witness`,
            layer: "direct-root-cdp-fixture-oracle",
            trustedPair: true,
            effect: true,
            settlementReads: settled.reads,
          });
        }
        if (options.remoteFrameInput === "supported") {
          cases.push({
            case: "provider-remote-canvas",
            pair: await paired("click", "canvas"),
          });
          cases.push({
            case: "provider-remote-text",
            pair: await paired("key", "text-a"),
          });
        } else {
          const position = await point("canvas");
          const observed = await inspect();
          cases.push(
            await rejected(
              "provider-remote-pointer-not-yet-supported",
              () =>
                backend.pointerClick!(
                  sessionId,
                  tabId,
                  observed.observationId,
                  position.x,
                  position.y,
                ),
              /surface|frame|embedded|unsupported/iu,
            ),
          );
          cases.push(
            await rejected(
              "provider-remote-key-not-yet-supported",
              () =>
                backend.keyPress!(
                  sessionId,
                  tabId,
                  observed.observationId,
                  "Space",
                ),
              /surface|frame|embedded|unsupported|focused/iu,
            ),
          );
        }
        if (
          options.remoteFrameInput === "supported" &&
          mode.startsWith("nested-")
        ) {
          const oldGeometry = await inspect();
          const geometry = await rpc.evaluate<{
            before: { x: number; y: number; width: number; height: number };
            after: { x: number; y: number; width: number; height: number };
          }>("window.contract.flipTransform()");
          for (const key of ["x", "y", "width", "height"] as const)
            assert.ok(
              Math.abs(geometry.before[key] - geometry.after[key]) < 0.01,
              "Opposite fixture matrices retain the same AABB",
            );
          const nextPoint = await point("canvas");
          cases.push(
            await rejected(
              "remote-affine-quad-changed-before-pointer",
              () =>
                backend.pointerClick!(
                  sessionId,
                  tabId,
                  oldGeometry.observationId,
                  nextPoint.x,
                  nextPoint.y,
                ),
              /changed|stale|inspect again/iu,
            ),
          );
          cases.push({
            case: "fresh-remote-affine-quad-pointer",
            pair: await paired("click", "canvas"),
          });
        }
        const focusA = await focus("text-a");
        const focused = await inspect();
        const focusB = await focus("text-b");
        assert.equal(focusA.outer, focusB.outer);
        assert.equal(focusA.inner, "text-a");
        assert.equal(focusB.inner, "text-b");
        const staleReason =
          options.remoteFrameInput === "supported"
            ? /changed|stale|inspect again/iu
            : /surface|frame|embedded|unsupported|focused|changed|stale|inspect again/iu;
        cases.push(
          await rejected(
            "remote-inner-focus-replaced-before-key",
            () =>
              backend.keyPress!(
                sessionId,
                tabId,
                focused.observationId,
                "Space",
              ),
            staleReason,
          ),
        );
        const mutated = await inspect();
        await rpc.evaluate("window.contract.mutate()");
        const position = await point("canvas");
        cases.push(
          await rejected(
            "remote-document-mutation-before-pointer",
            () =>
              backend.pointerClick!(
                sessionId,
                tabId,
                mutated.observationId,
                position.x,
                position.y,
              ),
            staleReason,
          ),
        );
        const oldDocument = await rpc.evaluate<string>(
          "window.contract.state().then(state => state.documentId)",
        );
        const captured = await inspect();
        await rpc.evaluate("window.contract.reopenFrame()");
        await poll(
          async () =>
            (await rpc.evaluate<boolean>("window.contract.ready"))
              ? true
              : undefined,
          "replacement remote child document",
        );
        assert.notEqual(
          await rpc.evaluate<string>(
            "window.contract.state().then(state => state.documentId)",
          ),
          oldDocument,
        );
        cases.push(
          await rejected(
            "remote-child-navigation-before-pointer",
            () =>
              backend.pointerClick!(
                sessionId,
                tabId,
                captured.observationId,
                position.x,
                position.y,
              ),
            staleReason,
          ),
        );
        providerPlacement = await observeRemoteFramePlacement(
          rpc,
          placementRpc,
          mode,
          contractUrl.href,
          1,
        );
        cases.push({
          case: "replacement-child-placement",
          ...providerPlacement,
        });
        if (options.remoteFrameInput === "supported")
          cases.push({
            case: "fresh-replacement-remote-text",
            pair: await paired("key", "text-a"),
          });
        if (
          options.remoteFrameInput === "supported" &&
          mode === "nested-oopif"
        ) {
          // The shared target remains usable; held-input quarantine belongs only
          // to the new physical tab and that exact tab is closed in finally.
          cases.push(
            await runInterruptedRemoteFrameSmoke({
              backend,
              sessionId,
              endpoint,
              url: contractUrl.href,
              browserRpc: placementRpc,
              inputs,
              guard,
              onFailure: (receipt) => interruptedRouteFailures.push(receipt),
            }),
          );
          cases.push({
            case: "shared-target-still-usable-after-isolated-quarantine",
            pair: await paired("key", "text-a"),
          });
        }
      } else if (mode === "stop-propagation" || mode === "stop-immediate") {
        // Repeat actions on the SAME attachment to prove no held-input quarantine.
        for (let iteration = 0; iteration < 2; iteration++) {
          cases.push({
            case: `canvas-${iteration}`,
            pair: await paired("click", "canvas"),
          });
          cases.push({
            case: `text-${iteration}`,
            pair: await paired("key", "text-a"),
          });
        }
      } else if (
        mode === "shadow" ||
        mode === "light-native" ||
        mode === "same-origin-frame" ||
        mode === "affine-frame" ||
        mode === "closed-shadow" ||
        mode === "same-origin-closed-shadow"
      ) {
        cases.push({
          case: "ordinary-canvas",
          pair: await paired("click", "canvas"),
        });
        cases.push({
          case: "ordinary-text-pointer",
          pair: await paired("click", "text-a"),
        });
        cases.push({
          case: "ordinary-text",
          pair: await paired("key", "text-a"),
        });
        if (
          mode === "shadow" ||
          mode === "same-origin-frame" ||
          mode === "affine-frame" ||
          mode === "closed-shadow" ||
          mode === "same-origin-closed-shadow"
        ) {
          const a = await focus("text-a");
          const old = await inspect();
          const b = await focus("text-b");
          assert.equal(
            a.outer,
            b.outer,
            "Focus regression needs the SAME outer host",
          );
          assert.equal(a.inner, "text-a");
          assert.equal(b.inner, "text-b");
          cases.push(
            await rejected(
              `${mode}-focus-A-to-B-stale`,
              () =>
                backend.keyPress!(sessionId, tabId, old.observationId, "Space"),
              /changed|stale|inspect again/iu,
            ),
          );
          cases.push({
            case: `fresh-${mode}-focus-B`,
            pair: await paired("key", "text-b"),
          });
        }
        for (const type of ["file", "color", "date", "select"]) {
          for (const id of [`native-${type}`, `label-${type}`]) {
            cases.push({
              case: `${id}-pointer`,
              pair: await paired("click", id),
            });
            for (const key of ["Enter", "Space"] as const)
              cases.push({
                case: `${id}-${key}`,
                pair: await paired("key", id, key),
              });
          }
        }
        cases.push({
          case: "ordinary-after-native-controls",
          pair: await paired("key", "text-a"),
        });
      } else if (mode === "ordinary-dom") {
        for (const id of ["button-span", "widget", "editor"])
          cases.push({
            case: `ordinary-${id}`,
            pair: await paired("click", id),
          });
        cases.push({
          case: "contenteditable-Space",
          pair: await paired("key", "editor"),
        });
      } else {
        const id = "text-a";
        const position = await point(id);
        assert.equal((await focus(id)).inner, id);
        const observation = await inspect();
        assert.equal(
          observation.focusedInputAvailable,
          false,
          "Unresolved shadow focus must not advertise keyboard support",
        );
        cases.push(
          await rejected(
            `${mode}-pointer`,
            () =>
              backend.pointerClick!(
                sessionId,
                tabId,
                observation.observationId,
                position.x,
                position.y,
              ),
            "shadow-surface",
          ),
        );
        cases.push(
          await rejected(
            `${mode}-key`,
            () =>
              backend.keyPress!(
                sessionId,
                tabId,
                observation.observationId,
                "Space",
              ),
            "shadow-surface",
          ),
        );
      }
      if (mode === "affine-frame") {
        const position = await point("canvas");
        const captured = await inspect();
        const changed = await rpc.evaluate<{
          before: { x: number; y: number; width: number; height: number };
          after: { x: number; y: number; width: number; height: number };
        }>("window.contract.flipTransform()");
        for (const key of ["x", "y", "width", "height"] as const)
          assert.ok(
            Math.abs(changed.before[key] - changed.after[key]) < 0.01,
            "Opposite rotation must preserve the iframe bounding box",
          );
        cases.push(
          await rejected(
            "same-bounds-changed-affine-quad-stales-capture",
            () =>
              backend.pointerClick!(
                sessionId,
                tabId,
                captured.observationId,
                position.x,
                position.y,
              ),
            /changed|stale|inspect again/iu,
          ),
        );
        cases.push({
          case: "fresh-opposite-affine-quad",
          pair: await paired("key", "text-a"),
        });
        cases.push({
          case: "fresh-opposite-affine-canvas",
          pair: await paired("click", "canvas"),
        });
      }
      if (mode === "same-origin-frame" || mode === "affine-frame") {
        assert.equal(
          await rpc.evaluate(
            "document.querySelector('#contract-frame').contentWindow.mainWorldProbeCalls",
          ),
          0,
          "Input observation must not invoke poisoned child main-world APIs",
        );
        const position = await point("text-a");
        const observed = await inspect();
        await rpc.evaluate(
          "document.querySelector('#contract-frame').contentDocument.querySelector('#text-a').style.marginLeft = '8px'",
        );
        cases.push(
          await rejected(
            "child-document-mutation-stales-capture",
            () =>
              backend.pointerClick!(
                sessionId,
                tabId,
                observed.observationId,
                position.x,
                position.y,
              ),
            /changed|stale|inspect again/iu,
          ),
        );
        cases.push({
          case: "fresh-child-after-mutation",
          pair: await paired("click", "canvas"),
        });
        await rpc.evaluate("window.contract.reopenFrame()");
        cases.push({
          case: "fresh-child-after-document-open",
          pair: await paired("key", "text-a"),
        });
        const beforeScroll = await inspect();
        options.onPhase?.("input-contracts:same-origin-frame:reopened-scroll");
        // This page is deliberately hidden: animation frames may be suspended.
        // Read actual scroll geometry synchronously; the provider's next probe
        // must reject the old capture without a timer or synthetic event.
        const reopenedScroll = await rpc.evaluate<number>(
          "(() => { const child = document.querySelector('#contract-frame').contentWindow; child.scrollTo(0, 20); return child.scrollY; })()",
        );
        assert.equal(reopenedScroll, 20);
        cases.push(
          await rejected(
            "reopened-child-scroll-stales-capture",
            () =>
              backend.keyPress!(
                sessionId,
                tabId,
                beforeScroll.observationId,
                "Space",
              ),
            /changed|stale|inspect again/iu,
          ),
        );
      }
      await guard();
      reports.push({
        scenario: mode,
        withheldCaptures: withheldCaptures - withheldBefore,
        layer: "headed-real-cdp-contract",
        nativeExtensionRouting: "not-exercised",
        ...(remoteMode
          ? {
              frameDepth: mode.startsWith("nested-") ? 2 : 1,
              ownerChain: "cdp-observed",
              recursiveProviderInput:
                mode.startsWith("nested-") &&
                options.remoteFrameInput === "supported"
                  ? "trusted-inner-effect"
                  : "not-exercised",
              providerInput:
                options.remoteFrameInput === "supported"
                  ? "supported"
                  : "unsupported-zero-dispatch",
            }
          : {}),
        status: "passed",
        cases,
      });
    }
    return reports;
  } catch (error) {
    const diagnostic = {
      scenario: "targeted-input-contracts",
      completedReports: reports,
      lastDirectRemoteWitness: remoteWitness,
      protocolRouteDiagnostics,
      interruptedRouteFailures,
      error: error instanceof Error ? error.message : String(error),
      fixtureCdp:
        error instanceof Error && "fixtureCdp" in error
          ? error.fixtureCdp
          : undefined,
    };
    // Preserve the current authored point, owner/inner hits and final read in
    // both native entrypoint failure receipts, without replaying any action.
    try {
      options.onFailure?.(diagnostic);
      console.error(
        "Targeted input contract failure",
        JSON.stringify(diagnostic),
      );
    } catch {
      // Diagnostics never replace the original fixture assertion.
    }
    throw error;
  } finally {
    WebSocket.prototype.send = originalSend;
    for (const [socket, observed] of providerSockets)
      socket.off("message", observed.listener);
    rpc.close();
    placementRpc.close();
    if (remoteServer.listening) {
      const closed = new Promise<void>((resolve) =>
        remoteServer.close(() => resolve()),
      );
      remoteServer.closeAllConnections();
      await closed;
    }
  }
}

/** Passive fixture-only tracing; only the exact owned browser socket is observed. */
function traceOwnedCdpTransport(
  browserSocketUrl: string,
  record: (value: Record<string, unknown>) => void,
): () => void {
  const originalSend = WebSocket.prototype.send;
  const methods = new Set([
    "Target.getTargets",
    "Target.createTarget",
    "Target.attachToTarget",
    "Target.detachFromTarget",
    "Target.detachedFromTarget",
    "Target.targetDestroyed",
    "Target.setDiscoverTargets",
    "Page.enable",
    "Page.getFrameTree",
    "Page.createIsolatedWorld",
    "Page.captureScreenshot",
    "Page.frameNavigated",
    "Page.documentOpened",
    "Page.navigatedWithinDocument",
    "Page.frameStoppedLoading",
    "Runtime.enable",
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
    "Runtime.releaseObject",
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "DOM.describeNode",
    "DOM.resolveNode",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
  ]);
  let active = true;
  const sockets = new Map<
    WebSocket,
    {
      message(raw: unknown): void;
      close(code: number): void;
      error(): void;
      pending: Map<number, { method: string; at: number }>;
      number: number;
    }
  >();
  const emit = (value: Record<string, unknown>) => {
    try {
      if (active) record(value);
    } catch {
      /* Diagnostics never affect transport. */
    }
  };
  const send = function (this: WebSocket, ...args: unknown[]) {
    try {
      if (
        active &&
        this.url === browserSocketUrl &&
        typeof args[0] === "string"
      ) {
        let observed = sockets.get(this);
        if (!observed && sockets.size < 4) {
          const number = sockets.size + 1;
          const pending = new Map<number, { method: string; at: number }>();
          observed = {
            number,
            pending,
            message: (raw) => {
              try {
                const message = JSON.parse(String(raw)) as {
                  id?: number;
                  method?: string;
                };
                if (Number.isSafeInteger(message.id)) {
                  const sent = pending.get(message.id!);
                  if (sent) {
                    pending.delete(message.id!);
                    emit({
                      kind: "reply",
                      socket: number,
                      id: message.id,
                      method: sent.method,
                      elapsedMs: Date.now() - sent.at,
                    });
                  }
                } else if (message.method && methods.has(message.method)) {
                  emit({
                    kind: "event",
                    socket: number,
                    method: message.method,
                  });
                }
              } catch {
                /* Malformed or late diagnostics cannot alter a reply. */
              }
            },
            close: (code) => emit({ kind: "close", socket: number, code }),
            error: () => emit({ kind: "error", socket: number }),
          };
          sockets.set(this, observed);
          this.on("message", observed.message);
          this.on("close", observed.close);
          this.on("error", observed.error);
        }
        const message = JSON.parse(args[0]) as { id?: number; method?: string };
        if (
          observed &&
          Number.isSafeInteger(message.id) &&
          typeof message.method === "string"
        ) {
          const method = methods.has(message.method) ? message.method : "other";
          if (observed.pending.size >= 64)
            observed.pending.delete(observed.pending.keys().next().value!);
          observed.pending.set(message.id!, { method, at: Date.now() });
          emit({
            kind: "send",
            socket: observed.number,
            id: message.id,
            method,
          });
        }
      }
    } catch {
      /* The original send must run even if diagnostics fail. */
    }
    return Reflect.apply(originalSend, this, args);
  };
  WebSocket.prototype.send = send;
  return () => {
    active = false;
    if (WebSocket.prototype.send === send)
      WebSocket.prototype.send = originalSend;
    for (const [socket, observed] of sockets) {
      socket.removeListener("message", observed.message);
      socket.removeListener("close", observed.close);
      socket.removeListener("error", observed.error);
      observed.pending.clear();
    }
    sockets.clear();
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(
      "Run on an interactive macOS/Windows desktop: node --import tsx apps/zenx/src/main/browser-parallel-input-smoke.ts\nSet ZENX_USER_BROWSER_EXECUTABLE to an existing browser; ZENX_REQUIRE_OS_INPUT=1 requires real OS input. No permissions are requested or changed. Temporary owned windows are activated during fixture setup.",
    );
    return;
  }
  if (process.platform !== "darwin" && process.platform !== "win32")
    throw new Error(
      "This headed fixture requires an interactive macOS or Windows desktop. No native/headed work was started.",
    );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-parallel-input-"),
  );
  const profile = path.join(directory, "browser-profile");
  await mkdir(profile);
  const reports: Record<string, unknown>[] = [];
  const cdpDiagnostics = new UserBrowserCdpDiagnosticObserver();
  let diagnosticOutcome: "running" | "passed" | "failed" = "running";
  let cleanupCompleted = false;
  let browser: ChildProcess | undefined;
  let browserError = "";
  let phase = "startup";
  let remoteFrameFailure: Record<string, unknown> | undefined;
  const transportDiagnostics: unknown[] = [];
  let transportDropped = 0;
  let stopTransport: (() => void) | undefined;
  let native: Native | undefined;
  let connection: UserBrowserConnection | undefined;
  let browserRpc: Rpc | undefined,
    userRpc: Rpc | undefined,
    agentRpc: Rpc | undefined;
  const server = createServer((request, response) => {
    if (request.url?.startsWith(browserExtensionsFixturePath)) {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      response.end(browserExtensionsFixtureBody);
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("Origin-Agent-Cluster", "?0");
    if (
      request.url?.startsWith("/input-contract") ||
      request.url?.startsWith("/remote-frame-child")
    ) {
      response.end(targetedInputContractPage(request.url));
      return;
    }
    response.end(page(request.url?.startsWith("/agent") ? "agent" : "user"));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const executable = await findExecutable();
    phase = "startup-native-compile";
    native = await startNative(directory);
    const nativeReady = await withDeadline(
      native.ready,
      15_000,
      "native fixture readiness",
    );
    phase = "startup-browser-launch";
    browser = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--site-per-process",
        "--host-resolver-rules=MAP localhost 127.0.0.1, MAP nested.localhost 127.0.0.1",
        // Renderer AX metadata is required by this owned Mac fixture's strict
        // native focused-element/value preflight. This grants no OS permission.
        ...(process.platform === "darwin"
          ? ["--force-renderer-accessibility"]
          : []),
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1000,720",
        "--window-position=300,180",
        `${origin}/user`,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: false },
    );
    browser.stderr!.on("data", (raw) => {
      browserError = (browserError + String(raw)).slice(-8_192);
    });
    browser.on("error", (error) => {
      browserError = error.message;
    });
    assert.ok(browser.pid, "Browser did not create an owned process");
    const ownedBrowserPid = browser.pid;
    const port = await poll(async () => {
      if (browser!.exitCode !== null || browser!.signalCode !== null)
        throw new Error(`Owned browser exited: ${browserError}`);
      try {
        const value = (
          await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
        ).split(/\r?\n/u)[0];
        return /^\d+$/.test(value ?? "") ? value : undefined;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Chrome can still hold its startup file open on Windows. Re-read only
        // this owned file within the existing poll deadline; never relaunch.
        if (
          code === "ENOENT" ||
          (process.platform === "win32" && code === "EBUSY")
        )
          return undefined;
        throw error;
      }
    }, "owned browser DevTools endpoint");
    const endpoint = `http://127.0.0.1:${port}`;
    const getJson = async (route: string) => {
      const response = await fetch(`${endpoint}/${route}`, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.ok, true);
      return await response.json();
    };
    const version = (await getJson("json/version")) as {
      Browser: string;
      webSocketDebuggerUrl: string;
    };
    stopTransport = traceOwnedCdpTransport(
      version.webSocketDebuggerUrl,
      (value) => {
        transportDiagnostics.push({ phase, at: Date.now(), ...value });
        if (transportDiagnostics.length > 48) {
          transportDiagnostics.shift();
          transportDropped++;
        }
      },
    );
    phase = "startup-user-document";
    browserRpc = await Rpc.connect(version.webSocketDebuggerUrl);
    const user = await poll(
      async () =>
        ((await getJson("json/list")) as Target[]).find(
          (target) => target.url === `${origin}/user`,
        ),
      "user fixture target",
    );
    userRpc = await Rpc.connect(user.webSocketDebuggerUrl);
    await poll(async () => {
      const ready = await userRpc!.evaluate<boolean>(
        "Boolean(window.fixture && document.querySelector('#user-input'))",
      );
      assert.equal(
        typeof ready,
        "boolean",
        "Fixture readiness must be boolean",
      );
      return ready ? true : undefined;
    }, "user fixture document");
    phase = "startup-user-focus";
    await userRpc.evaluate(`document.querySelector('#user-input').focus()`);
    await browserRpc.send("Target.activateTarget", { targetId: user.id }); // Fixture setup only.
    await native.call("activateBrowser", {
      pid: ownedBrowserPid,
      title: userTitle,
    });
    const nativeBrowser = await poll(async () => {
      const state = await native!.call("snapshot");
      return state.pid === ownedBrowserPid ? state : undefined;
    }, "owned Chrome foreground");
    await native.call("guard", {
      pid: ownedBrowserPid,
      hwnd: nativeBrowser.hwnd,
      title: userTitle,
    });
    // Setup may focus/activate the owned window. Freeze its event history before
    // any provider work, and verify it before the scenario loop resets the guard.
    const beforeOpen = await userRpc.evaluate<PageState>(stateScript);
    assert.equal(beforeOpen.focus, "user-input");
    assert.equal(beforeOpen.hasFocus, true);
    assert.equal(beforeOpen.visibility, "visible");
    phase = "startup-connect-provider";
    connection = await connectUserBrowserCdp(endpoint, undefined, {
      cdpDiagnosticObserver: cdpDiagnostics,
    });
    await connection.backend.listTabs(sessionId);
    phase = "startup-open-agent";
    const opened = await connection.backend.open(sessionId, `${origin}/agent`);
    const agent = await poll(
      async () =>
        ((await getJson("json/list")) as Target[]).find(
          (target) =>
            target.id === opened.tabId && target.url === `${origin}/agent`,
        ),
      "agent fixture target",
    );
    phase = "startup-agent-document";
    agentRpc = await Rpc.connect(agent.webSocketDebuggerUrl);
    await poll(async () => {
      const ready = await agentRpc!.evaluate<boolean>(
        "Boolean(window.fixture && document.querySelector('#agent-input'))",
      );
      assert.equal(
        typeof ready,
        "boolean",
        "Fixture readiness must be boolean",
      );
      return ready ? true : undefined;
    }, "agent fixture document");
    phase = "startup-agent-inspection";
    // The fixture DOM can exist before the provider receives the final initial
    // navigation lifecycle event. Settle only this read, before concurrent input.
    await poll(async () => {
      try {
        await connection!.backend.inspect(sessionId, opened.tabId);
        return true;
      } catch (error) {
        if (error instanceof UserBrowserDocumentChangedBeforeDispatchError)
          return undefined;
        throw error;
      }
    }, "initial Agent document lifecycle");
    phase = "programmable-extensions";
    reports.push(
      await verifyBrowserExtensions(
        connection.backend,
        sessionId,
        opened.tabId,
        origin,
      ),
    );
    phase = "startup-target-window-check";
    const userWindow = await browserRpc.send("Browser.getWindowForTarget", {
      targetId: user.id,
    });
    const agentWindow = await browserRpc.send("Browser.getWindowForTarget", {
      targetId: opened.tabId,
    });
    assert.equal(
      agentWindow.windowId,
      userWindow.windowId,
      "Agent and user tabs must share one owned browser window",
    );
    assert.equal(
      (await agentRpc.evaluate<PageState>(stateScript)).visibility,
      "hidden",
      "backend.open must create an inactive Agent tab",
    );
    const afterOpen = await userRpc.evaluate<PageState>(stateScript);
    assert.equal(afterOpen.focus, "user-input");
    assert.equal(
      afterOpen.hasFocus,
      true,
      "User browser lost keyboard focus during provider startup",
    );
    assert.equal(afterOpen.visibility, "visible");
    assert.deepEqual(
      afterOpen.focusEvents,
      beforeOpen.focusEvents,
      "User window focus changed during provider startup",
    );
    assert.deepEqual(
      afterOpen.visibilityEvents,
      beforeOpen.visibilityEvents,
      "User tab visibility changed during provider startup",
    );
    assert.equal(
      (await native.call("snapshot")).drift,
      false,
      "backend.open changed native foreground",
    );
    const scenarios =
      process.platform === "darwin"
        ? ["chrome-foreground", "chrome-behind-sentinel"]
        : ["chrome-foreground"];
    for (const scenario of scenarios) {
      await native.call("clear");
      await userRpc.evaluate(
        `document.querySelector('#user-input').value='';document.querySelector('#user-input').focus()`,
      );
      await browserRpc.send("Target.activateTarget", { targetId: user.id }); // Between-scenario setup only.
      await native.call("activateBrowser", {
        pid: ownedBrowserPid,
        title: userTitle,
      });
      let expected: NativeState = await native.call("snapshot");
      if (scenario === "chrome-behind-sentinel")
        expected = await native.call("sentinel");
      expected = await poll(async () => {
        const observed = await native!.call("snapshot");
        const correctOwner =
          observed.pid ===
          (scenario === "chrome-behind-sentinel"
            ? nativeReady.pid
            : ownedBrowserPid);
        return correctOwner &&
          (scenario !== "chrome-behind-sentinel" ||
            observed.sentinelFocused === true)
          ? observed
          : undefined;
      }, "scenario foreground owner");
      const expectedPid =
        scenario === "chrome-behind-sentinel"
          ? nativeReady.pid
          : ownedBrowserPid;
      await native.call("guard", {
        pid: expectedPid,
        hwnd: expected.hwnd,
        title:
          scenario === "chrome-behind-sentinel"
            ? "ZenX Parallel Sentinel"
            : userTitle,
      });
      await delay(100);
      const userBefore: PageState =
        await userRpc.evaluate<PageState>(stateScript);
      const agentBefore: PageState =
        await agentRpc.evaluate<PageState>(stateScript);
      assert.equal(userBefore.focus, "user-input");
      assert.equal(
        userBefore.visibility,
        "visible",
        "Selected-tab identity is unverified when the entire browser is occluded/minimized; do not count that as a pass",
      );
      assert.equal(agentBefore.visibility, "hidden");
      const guard = async (): Promise<{
        front: NativeState;
        userState: PageState;
        agentState: PageState;
      }> => {
        const [front, userState, agentState] = await Promise.all([
          native!.call("snapshot"),
          userRpc!.evaluate<PageState>(stateScript),
          agentRpc!.evaluate<PageState>(stateScript),
        ]);
        assert.equal(front.pid, expectedPid, "Native foreground PID changed");
        if (process.platform === "win32")
          assert.equal(
            front.hwnd,
            expected.hwnd,
            "Native foreground HWND changed",
          );
        assert.equal(
          front.drift,
          false,
          "Native foreground drift was observed between checks",
        );
        assert.equal(
          userState.focus,
          "user-input",
          "User document.activeElement changed",
        );
        if (scenario === "chrome-foreground")
          assert.equal(
            userState.hasFocus,
            true,
            "User browser document lost actual keyboard focus",
          );
        assert.equal(
          userState.visibility,
          "visible",
          "User active tab changed",
        );
        assert.equal(
          agentState.visibility,
          "hidden",
          "Agent tab became active",
        );
        assert.deepEqual(
          userState.visibilityEvents,
          userBefore.visibilityEvents,
          "User tab briefly lost visibility",
        );
        assert.deepEqual(
          agentState.visibilityEvents,
          agentBefore.visibilityEvents,
          "Agent tab briefly gained visibility",
        );
        assert.deepEqual(
          userState.focusEvents,
          userBefore.focusEvents,
          "User window focus changed, even if it later returned",
        );
        return { front, userState, agentState };
      };
      const layers =
        scenario === "chrome-behind-sentinel"
          ? (["fixture-data-mutation", "real-os-input"] as const)
          : (["cdp-data-isolation", "real-os-input"] as const);
      for (const layer of layers) {
        phase = `${scenario}:${layer}`;
        const canType = process.platform === "win32" || nativeReady.axTrusted;
        if (layer === "real-os-input" && !canType) {
          reports.push({
            scenario,
            layer,
            status: "unverified",
            reason:
              "AXIsProcessTrusted is false for this helper. No permission was requested; dual-CDP results are not OS-input evidence.",
          });
          if (process.env.ZENX_REQUIRE_OS_INPUT === "1")
            throw new Error(
              "Real OS-input acceptance is required but macOS Accessibility is unavailable",
            );
          continue;
        }
        await guard();
        const userStart: PageState =
          await userRpc.evaluate<PageState>(stateScript);
        const sentinelStart: string =
          (await native.call("snapshot")).sentinelValue ?? "";
        const agentStart: PageState =
          await agentRpc.evaluate<PageState>(stateScript);
        let finished = false;
        let produced = "";
        let batchesWhileAgentRunning = 0;
        const controller = new AbortController();
        let previousNativeValue = "";
        let nativeSettlementReads = 0;
        const settleNativeInput = async (): Promise<void> => {
          if (
            process.platform !== "darwin" ||
            layer !== "real-os-input" ||
            scenario !== "chrome-foreground"
          )
            return;
          const expectedValue = userStart.value + produced;
          nativeSettlementReads += await settleMacFixtureInput({
            previousValue: previousNativeValue,
            expectedValue,
            signal: controller.signal,
            read: async () => {
              const { userState } = await guard();
              controller.signal.throwIfAborted();
              const observed = await native!.call("focusedValue", {
                previousValue: previousNativeValue,
                expectedValue,
              });
              assert.equal(observed.drift, false, "Native foreground drifted");
              return {
                domValue: userState.value,
                nativeValueState: observed.focusedValueState,
              };
            },
          });
          previousNativeValue = expectedValue;
        };
        const agentTask = (async () => {
          try {
            for (let iteration = 0; iteration < 3; iteration++) {
              controller.signal.throwIfAborted();
              let inspection: BrowserInspection =
                await connection!.backend.inspect(
                  sessionId,
                  opened.tabId,
                  controller.signal,
                );
              assert.equal(inspection.screenshot.status, "captured");
              assert.ok(
                inspection.inputViewport,
                "Real captured viewport input is unavailable",
              );
              await connection!.backend.pointerClick!(
                sessionId,
                opened.tabId,
                inspection.observationId,
                50,
                45,
                controller.signal,
              );
              await guard();
              inspection = await connection!.backend.inspect(
                sessionId,
                opened.tabId,
                controller.signal,
              );
              await connection!.backend.pointerClick!(
                sessionId,
                opened.tabId,
                inspection.observationId,
                50,
                140,
                controller.signal,
              );
              inspection = await connection!.backend.inspect(
                sessionId,
                opened.tabId,
                controller.signal,
              );
              const input = inspection.targets.find(
                (target) => target.name === "Agent input",
              );
              assert.ok(input);
              const marker = `AGENT${iteration}`;
              await connection!.backend.type(
                sessionId,
                opened.tabId,
                inspection.observationId,
                input.targetId,
                marker,
                false,
                controller.signal,
              );
              inspection = await connection!.backend.inspect(
                sessionId,
                opened.tabId,
                controller.signal,
              );
              await connection!.backend.keyPress!(
                sessionId,
                opened.tabId,
                inspection.observationId,
                "Space",
                controller.signal,
              );
              inspection = await connection!.backend.inspect(
                sessionId,
                opened.tabId,
                controller.signal,
              );
              await connection!.backend.keyPress!(
                sessionId,
                opened.tabId,
                inspection.observationId,
                "Enter",
                controller.signal,
              );
              await guard();
            }
          } finally {
            finished = true;
          }
        })();
        const userTask = (async () => {
          try {
            let sequence = 0;
            while (!finished) {
              // DOM and Chromium's native AX projection consume OS events
              // asynchronously. Require both to reflect only our exact issued
              // prefix before another batch, then retain the native type guard.
              await settleNativeInput();
              const { userState } = await guard();
              if (finished) break;
              if (
                process.platform === "darwin" &&
                layer === "real-os-input" &&
                scenario === "chrome-foreground"
              )
                assert.equal(
                  userState.value,
                  userStart.value + produced,
                  "Settled native input changed before the next batch",
                );
              const text = `U${sequence++}X`;
              if (layer === "fixture-data-mutation") {
                // Input.insertText focuses Chrome's renderer even while the OS
                // sentinel stays foreground. This layer tests data isolation,
                // not typing; mutate only the exact owned fixture value without
                // focus/events. The separate real-os-input layer still types
                // into the native sentinel under the unchanged ownership guard.
                await userRpc!.evaluate(`(() => {
                  const input = document.querySelector('#user-input');
                  if (input.value !== ${JSON.stringify(userStart.value + produced)})
                    throw new Error('Owned fixture value changed before mutation');
                  input.value += ${JSON.stringify(text)};
                })()`);
              } else if (layer === "cdp-data-isolation")
                await userRpc!.send("Input.insertText", { text });
              else {
                if (scenario === "chrome-foreground")
                  assert.equal(
                    userState.hasFocus,
                    true,
                    "Browser fixture no longer has keyboard focus",
                  );
                await native!.call("type", {
                  text,
                  expectedValue:
                    scenario === "chrome-foreground"
                      ? userState.value
                      : undefined,
                });
              }
              produced += text;
              batchesWhileAgentRunning++;
              await delay(25);
            }
          } catch (error) {
            controller.abort(error);
            throw error;
          }
        })();
        const results = await Promise.allSettled([agentTask, userTask]);
        for (const result of results)
          if (result.status === "rejected") throw result.reason;
        await settleNativeInput();
        await delay(100); // Drain only already-issued native events; never replay.
        const { front, userState, agentState } = await guard();
        assert.ok(
          batchesWhileAgentRunning > 0,
          "No concurrent fixture activity batch was observed",
        );
        assert.equal(agentState.clicks - agentStart.clicks, 3);
        assert.deepEqual(
          agentState.submissions.slice(agentStart.submissions.length),
          ["AGENT0 ", "AGENT1 ", "AGENT2 "],
        );
        assert.equal(agentState.value, "AGENT2 ");
        assert.ok(
          agentState.trustedKeys > agentStart.trustedKeys,
          "Agent trusted keyboard events missing",
        );
        if (
          layer === "real-os-input" &&
          scenario === "chrome-behind-sentinel"
        ) {
          assert.equal(
            front.sentinelValue,
            sentinelStart + produced,
            "OS text missed the exact owned sentinel field",
          );
          assert.equal(front.sentinelFocused, true);
          assert.equal(
            userState.value,
            userStart.value,
            "Sentinel OS input leaked into Chrome",
          );
        } else
          assert.equal(
            userState.value,
            userStart.value + produced,
            "User text leaked/lost or entered another page",
          );
        if (layer === "real-os-input" && scenario === "chrome-foreground")
          assert.ok(
            userState.trustedKeys > userStart.trustedKeys,
            "No trusted OS key events reached user fixture",
          );
        reports.push({
          scenario,
          layer,
          status: "passed",
          batchesWhileAgentRunning,
          ...(layer === "fixture-data-mutation"
            ? { mutatedCharacters: produced.length }
            : { typedCharacters: produced.length }),
          frontmostPid: front.pid,
          frontmostHwnd: front.hwnd,
          nativeSamples: front.samples,
          nativeTitleSamples: front.titleSamples,
          nativeIdleTitleCooldownMs: front.idleTitleCooldownMs,
          nativeSettlementReads,
          userTarget: user.id,
          agentTarget: opened.tabId,
          userActiveElement: userState.focus,
          userVisibility: userState.visibility,
          agentVisibility: agentState.visibility,
          pageDataIsolated: true,
        });
      }
    }
    const contractFront = await native.call("snapshot");
    const contractUser = await userRpc.evaluate<PageState>(stateScript);
    phase = "input-contracts:setup";
    reports.push(
      ...(await runTargetedInputContractSmoke({
        backend: connection.backend,
        sessionId,
        tabId: opened.tabId,
        endpoint,
        origin,
        remoteFrameInput: "supported",
        onFailure: (diagnostic) => {
          remoteFrameFailure = diagnostic;
        },
        onPhase: (value) => {
          phase = value;
        },
        guard: async () => {
          const [front, userState, agentVisibility] = await Promise.all([
            native!.call("snapshot"),
            userRpc!.evaluate<PageState>(stateScript),
            agentRpc!.evaluate<string>("document.visibilityState"),
          ]);
          assert.equal(
            front.pid,
            contractFront.pid,
            "Contract changed native foreground PID",
          );
          assert.equal(
            front.hwnd,
            contractFront.hwnd,
            "Contract changed native foreground HWND",
          );
          assert.equal(
            front.drift,
            false,
            "Contract caused native foreground drift",
          );
          assert.equal(userState.focus, "user-input");
          assert.equal(userState.visibility, "visible");
          assert.equal(
            userState.value,
            contractUser.value,
            "Contract input leaked into user fixture",
          );
          assert.deepEqual(
            userState.visibilityEvents,
            contractUser.visibilityEvents,
          );
          assert.equal(agentVisibility, "hidden");
        },
      })),
    );
    const report = {
      status: reports.some((entry) => entry.status === "unverified")
        ? "partial-unverified"
        : "passed",
      platform: process.platform,
      browser: version.Browser,
      executable,
      disposableProfile: true,
      fixtureOnly: true,
      osPermissionRequested: false,
      reports,
    };
    console.log(JSON.stringify(report, null, 2));
    if (process.env.ZENX_PARALLEL_INPUT_ARTIFACT_DIR) {
      await mkdir(process.env.ZENX_PARALLEL_INPUT_ARTIFACT_DIR, {
        recursive: true,
      });
      await writeFile(
        path.join(
          process.env.ZENX_PARALLEL_INPUT_ARTIFACT_DIR,
          "browser-parallel-input.json",
        ),
        JSON.stringify(report, null, 2),
      );
    }
    diagnosticOutcome = "passed";
  } catch (error) {
    diagnosticOutcome = "failed";
    console.error(
      JSON.stringify({
        status: "failed",
        platform: process.platform,
        reports,
        phase,
        transportDiagnostics,
        transportDropped,
        remoteFrameFailure,
        ownedBrowser: {
          pid: browser?.pid,
          exitCode: browser?.exitCode,
          signalCode: browser?.signalCode,
          killed: browser?.killed,
          stderr: browserError,
        },
        error: error instanceof Error ? error.message : String(error),
        fixtureCdp:
          error instanceof Error && "fixtureCdp" in error
            ? error.fixtureCdp
            : undefined,
      }),
    );
    throw error;
  } finally {
    cdpDiagnostics.mark("cleanup-start");
    try {
      stopTransport?.();
      await native?.call("clear").catch(() => undefined);
      await Promise.resolve(connection?.backend.close()).catch(() => undefined);
      await browserRpc?.send("Browser.close").catch(() => undefined);
      userRpc?.close();
      agentRpc?.close();
      browserRpc?.close();
      if (browser) await stopOwnedChild(browser);
      await native?.close();
      if (server.listening) {
        const closing = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        server.closeAllConnections();
        await closing;
      }
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 150,
      });
      cleanupCompleted = true;
      cdpDiagnostics.mark("cleanup-complete");
    } finally {
      await finishCdpDiagnostic(
        cdpDiagnostics,
        diagnosticOutcome,
        cleanupCompleted,
      );
    }
  }
}

/** Runs only after existing cleanup, without waiting for late replies or close. */
export async function finishCdpDiagnostic(
  observer: UserBrowserCdpDiagnosticObserver,
  outcome: "running" | "passed" | "failed",
  cleanupCompleted: boolean,
  output: {
    write(report: unknown): Promise<void>;
    log(report: unknown): void;
  } = {
    write: async (report) => {
      const directory = process.env.ZENX_PARALLEL_INPUT_ARTIFACT_DIR;
      if (directory === undefined) return;
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "browser-provider-cdp-diagnostic.json"),
        JSON.stringify(report, null, 2),
      );
    },
    log: (report) =>
      console.log("Provider CDP final diagnostic", JSON.stringify(report)),
  },
): Promise<void> {
  // Diagnostic serialization, file and console failures never replace a fixture error.
  try {
    const report = {
      ...observer.stop(),
      outcome,
      cleanupCompleted,
      artifactErrors: 0,
    };
    try {
      await output.write(report);
    } catch {
      report.artifactErrors += 1;
    }
    try {
      output.log(report);
    } catch {
      /* No remaining diagnostic output channel. */
    }
  } catch {
    /* Preserve the original fixture/cleanup outcome. */
  }
}

async function findExecutable(): Promise<string> {
  const candidates = [
    process.env.ZENX_USER_BROWSER_EXECUTABLE,
    ...(process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : windowsBrowserExecutableCandidates(process.env)),
  ];
  for (const candidate of candidates)
    if (candidate) {
      try {
        await access(candidate);
        return candidate;
      } catch {}
    }
  throw new Error(
    "No existing headed browser executable found; set ZENX_USER_BROWSER_EXECUTABLE. This fixture never installs one.",
  );
}
async function poll<T>(
  read: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  if (process.platform === "win32" && child.pid)
    await runFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5_000,
    }).catch(() => undefined);
  else child.kill("SIGTERM");
  await Promise.race([closed, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}
async function startNative(directory: string): Promise<Native> {
  if (process.platform === "darwin") {
    // Read-only discovery first. Missing tools is a blocker, never an install prompt.
    // Cold xcrun lookup can exceed five seconds on a fresh hosted runner. All
    // discovery commands share one budget and each still executes only once.
    const discoveryDeadline = Date.now() + 20_000;
    const discoveryTimeout = (): number => {
      const remaining = discoveryDeadline - Date.now();
      if (remaining <= 0)
        throw new Error("macOS toolchain discovery timed out");
      return remaining;
    };
    await runFile("/usr/bin/xcode-select", ["--print-path"], {
      timeout: Math.min(5_000, discoveryTimeout()),
    });
    const { stdout } = await runFile(
      "/usr/bin/xcrun",
      ["--sdk", "macosx", "--find", "swiftc"],
      { timeout: discoveryTimeout() },
    );
    const compiler = stdout.trim();
    assert.ok(
      path.isAbsolute(compiler),
      "Swift compiler must be an absolute path",
    );
    const { stdout: sdkOutput } = await runFile(
      "/usr/bin/xcrun",
      ["--sdk", "macosx", "--show-sdk-path"],
      { timeout: discoveryTimeout() },
    );
    discoveryTimeout();
    const sdk = sdkOutput.trim();
    assert.ok(path.isAbsolute(sdk), "macOS SDK must be an absolute path");
    const source = path.join(directory, "Native.swift"),
      binary = path.join(directory, "native-fixture");
    await writeFile(source, MAC_NATIVE);
    await runFile(
      compiler,
      [
        "-sdk",
        sdk,
        "-swift-version",
        "5",
        "-module-cache-path",
        path.join(directory, "swift-cache"),
        source,
        "-o",
        binary,
      ],
      { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return new Native(binary, []);
  }
  const source = path.join(directory, "Native.ps1");
  await writeFile(source, WINDOWS_NATIVE);
  // Run this fixed fixture program inline, like the existing Windows smoke.
  // No ExecutionPolicy/security changes; constrained-language/Add-Type denials
  // are real blockers and are never retried through an alternate execution path.
  return new Native("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_NATIVE,
  ]);
}

const MAC_NATIVE = String.raw`import AppKit
import ApplicationServices
import Foundation
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var expectedPid: pid_t = 0
var expectedTitle = ""
var drift = false
var samples = 0
// AX title reads synchronously ask Chrome to service accessibility. Keep cheap
// PID/sentinel observations at 10ms, but leave a quiet interval after each full
// idle read completes. Dispatch/snapshot/value guards never use this cooldown.
let idleTitleCooldown = 0.25
var nextIdleTitleSampleAt = 0.0
var titleSamples = 0
var guardEpoch = 0
var activationObserver: NSObjectProtocol? = nil
var sentinel: NSWindow? = nil
var field: NSTextField? = nil
func currentPid() -> pid_t { NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1 }
func titleFor(_ pid: pid_t) -> String {
  titleSamples += 1
  var window: CFTypeRef?
  guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute as CFString, &window) == .success, let window else { return "" }
  var title: CFTypeRef?
  guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success else { return "" }
  return title as? String ?? ""
}
func owns(checkTitle: Bool = true) -> Bool {
  if expectedPid == 0 { return true }
  guard currentPid() == expectedPid else { return false }
  if expectedPid == getpid() { return sentinel?.isKeyWindow == true && field?.currentEditor() != nil }
  if !checkTitle { return true }
  return !AXIsProcessTrusted() || titleFor(expectedPid).contains(expectedTitle)
}
func sample(checkTitle: Bool = true) {
  if expectedPid != 0 {
    samples += 1
    if !owns(checkTitle: checkTitle) { drift = true }
    if checkTitle { nextIdleTitleSampleAt = ProcessInfo.processInfo.systemUptime + idleTitleCooldown }
  }
}
func sampleIdle() {
  sample(checkTitle: ProcessInfo.processInfo.systemUptime >= nextIdleTitleSampleAt)
}
func resetGuard(_ pid: pid_t = 0, _ title: String = "") {
  guardEpoch += 1
  if let previous = activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(previous) }
  activationObserver = nil
  expectedPid = pid; expectedTitle = title
  drift = false; samples = 0; nextIdleTitleSampleAt = 0; titleSamples = 0
  if pid == 0 { return }
  let epoch = guardEpoch
  activationObserver = NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main) { notification in
    // Ignore a callback already queued by a retired guard. Within this epoch,
    // use the historical owner even if foreground has since returned.
    guard guardEpoch == epoch, expectedPid != 0 else { return }
    if let activated = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, activated.processIdentifier != expectedPid { drift = true }
    sample()
  }
}
func state() -> [String:Any] {
  sample()
  return ["pid":Int(currentPid()),"axTrusted":AXIsProcessTrusted(),"samples":samples,"drift":drift,
          "titleSamples":titleSamples,"idleTitleCooldownMs":idleTitleCooldown * 1000,
          "sentinelValue":field?.stringValue ?? "", "sentinelFocused":sentinel?.isKeyWindow == true && field?.currentEditor() != nil]
}
func emit(_ id: Int, _ result: [String:Any] = [:], _ error: String? = nil) {
  let response: [String:Any] = error == nil ? ["id":id,"result":result] : ["id":id,"error":error!]
  if let data = try? JSONSerialization.data(withJSONObject:response) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
}
func process(_ request: [String:Any]) {
  let id = request["id"] as? Int ?? -1
  let method = request["method"] as? String ?? ""
  switch method {
  case "clear": resetGuard()
  case "activateBrowser":
    resetGuard()
    guard let pid = request["pid"] as? Int, let target = NSRunningApplication(processIdentifier:pid_t(pid)) else { emit(id,[:],"Owned browser process unavailable"); return }
    target.activate(options:[.activateAllWindows,.activateIgnoringOtherApps])
  case "sentinel":
    resetGuard()
    app.setActivationPolicy(.regular)
    if sentinel == nil {
      sentinel = NSWindow(contentRect:NSRect(x:20,y:20,width:360,height:140), styleMask:[.titled,.closable], backing:.buffered,defer:false)
      sentinel!.title = "ZenX Parallel Sentinel"
      field = NSTextField(frame:NSRect(x:20,y:50,width:320,height:35))
      sentinel!.contentView!.addSubview(field!)
    }
    field!.stringValue = ""
    sentinel!.makeKeyAndOrderFront(nil)
    sentinel!.makeFirstResponder(field!)
    app.activate(ignoringOtherApps:true)
  case "guard":
    resetGuard(pid_t(request["pid"] as? Int ?? 0), request["title"] as? String ?? "")
  case "focusedValue":
    // Read-only consumption barrier. A stale prefix is pending, not permission
    // to type. The existing exact-value check still runs immediately in type.
    guard AXIsProcessTrusted(), expectedPid != 0, expectedPid != getpid(), !drift, owns(),
          let expectedValue = request["expectedValue"] as? String,
          let previousValue = request["previousValue"] as? String else {
      emit(id,[:],"Owned focused-value guard rejected observation"); return
    }
    var element: CFTypeRef?; var value: CFTypeRef?
    let focusedStatus = AXUIElementCopyAttributeValue(AXUIElementCreateApplication(expectedPid), kAXFocusedUIElementAttribute as CFString, &element)
    var valueStatus: AXError? = nil
    if focusedStatus == .success, let element {
      valueStatus = AXUIElementCopyAttributeValue(element as! AXUIElement, kAXValueAttribute as CFString, &value)
    }
    var disposition = "invalid"
    if focusedStatus == .success, valueStatus == .success, let observed = value as? String {
      if observed == expectedValue { disposition = "matched" }
      else if observed.hasPrefix(previousValue) && expectedValue.hasPrefix(observed) { disposition = "pending" }
    }
    var result = state()
    guard !drift, owns() else { emit(id,[:],"Foreground changed during focused-value observation"); return }
    result["focusedValueState"] = disposition
    emit(id,result); return
  case "type":
    guard AXIsProcessTrusted() else { emit(id,[:],"OS input unverified: AXIsProcessTrusted is false; no permission requested"); return }
    guard expectedPid != 0, !drift, owns(), let text = request["text"] as? String, text.count <= 32 else { emit(id,[:],"Owned foreground guard rejected input"); return }
    if expectedPid != getpid(), let expectedValue = request["expectedValue"] as? String {
      var element: CFTypeRef?; var value: CFTypeRef?
      let focusedStatus = AXUIElementCopyAttributeValue(AXUIElementCreateApplication(expectedPid), kAXFocusedUIElementAttribute as CFString, &element)
      var valueStatus: AXError? = nil
      if focusedStatus == .success, let element {
        valueStatus = AXUIElementCopyAttributeValue(element as! AXUIElement, kAXValueAttribute as CFString, &value)
      }
      guard focusedStatus == .success, element != nil, valueStatus == .success,
            (value as? String) == expectedValue else {
        // Failure-only metadata: never emit the text, title or element description.
        var role: CFTypeRef?; var roleStatus: AXError? = nil
        if focusedStatus == .success, let element {
          roleStatus = AXUIElementCopyAttributeValue(element as! AXUIElement, kAXRoleAttribute as CFString, &role)
        }
        let knownRoles = ["AXTextField", "AXTextArea", "AXWebArea", "AXComboBox", "AXWindow", "AXButton", "AXApplication"]
        let observedRole = role as? String ?? "missing"
        let boundedRole = knownRoles.contains(observedRole) ? observedRole : "other"
        let valueType = value.map { String(CFGetTypeID($0)) } ?? "missing"
        let observedLength = (value as? String)?.utf16.count ?? -1
        emit(id,[:],"Owned browser's exact focused text value changed before OS input [focusedStatus=\(focusedStatus.rawValue), valueStatus=\(valueStatus?.rawValue ?? -1), roleStatus=\(roleStatus?.rawValue ?? -1), role=\(boundedRole), valueType=\(valueType), valueLength=\(observedLength), expectedLength=\(expectedValue.utf16.count)]")
        return
      }
    }
    for unit in text.utf16 {
      for down in [true,false] {
        sample(); guard !drift, owns() else { emit(id,[:],"Foreground changed before OS event; stopped without replay/release to another owner"); return }
        guard let event = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:down) else { emit(id,[:],"Could not allocate OS key event"); return }
        var value = unit
        event.keyboardSetUnicodeString(stringLength:1,unicodeString:&value)
        event.post(tap:.cghidEventTap)
        usleep(5000)
      }
    }
  case "snapshot": break
  default: emit(id,[:],"Unknown native fixture operation"); return
  }
  emit(id,state())
}
let timer = Timer.scheduledTimer(withTimeInterval:0.01,repeats:true) { _ in sampleIdle() }
emit(0,["pid":Int(getpid()),"axTrusted":AXIsProcessTrusted(),"samples":0,"drift":false])
DispatchQueue.global().async {
  while let line = readLine() {
    if let data = line.data(using:.utf8), let raw = try? JSONSerialization.jsonObject(with:data), let request = raw as? [String:Any] {
      DispatchQueue.main.async { process(request) }
    }
  }
  DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
`;

const WINDOWS_NATIVE = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class NativeFixture {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder value,int length);
  delegate bool EnumProc(IntPtr h,IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr arg);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h,int command);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
  static IntPtr expected = IntPtr.Zero;
  static uint owner;
  static string title = "";
  static int samples,drift;
  static Timer timer = new Timer(_ => Sample(),null,10,10);
  static string Title(IntPtr h) { var b = new StringBuilder(1024); GetWindowText(h,b,b.Capacity); return b.ToString(); }
  static bool Owned() { if(expected == IntPtr.Zero) return true; uint pid; var h=GetForegroundWindow();GetWindowThreadProcessId(h,out pid);return h==expected && pid==owner && Title(h).Contains(title); }
  static void Sample() { if(expected!=IntPtr.Zero) { Interlocked.Increment(ref samples);if(!Owned())Interlocked.Exchange(ref drift,1); } }
  public static Dictionary<string,object> State() { Sample();var h=GetForegroundWindow();uint pid;GetWindowThreadProcessId(h,out pid);return new Dictionary<string,object>{{"pid",pid},{"hwnd",h.ToInt64().ToString()},{"title",Title(h)},{"axTrusted",true},{"samples",samples},{"drift",drift!=0}}; }
  public static void Clear() { expected=IntPtr.Zero;owner=0;drift=0;samples=0; }
  public static void Activate(uint pid,string wanted) { Clear();IntPtr found=IntPtr.Zero;EnumWindows((h,arg)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==pid && Title(h).Contains(wanted))found=h;return true;},IntPtr.Zero);if(found==IntPtr.Zero)throw new Exception("Owned browser HWND not found");ShowWindowAsync(found,9);SetForegroundWindow(found); }
  public static void Guard(uint pid,string hwnd,string wanted) { owner=pid;title=wanted;samples=0;drift=0;expected=new IntPtr(Int64.Parse(hwnd));Sample(); }
  public static void Type(string text) { if(expected==IntPtr.Zero||drift!=0||!Owned()||text.Length>32)throw new Exception("Owned foreground guard rejected input");foreach(char c in text) { Sample();if(drift!=0||!Owned())throw new Exception("Foreground changed before OS key pair; no replay");var inputs=new INPUT[2];inputs[0].type=1;inputs[0].data.key.scan=c;inputs[0].data.key.flags=4;inputs[1].type=1;inputs[1].data.key.scan=c;inputs[1].data.key.flags=6;if(SendInput(2,inputs,Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception("OS key-pair outcome unknown; no replay");Thread.Sleep(10); } }
}
'@
@{id=0;result=@{pid=$PID;axTrusted=$true;samples=0;drift=$false}} | ConvertTo-Json -Compress
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    switch ($request.method) {
      'clear' { [NativeFixture]::Clear() }
      'activateBrowser' { [NativeFixture]::Activate([uint32]$request.pid,[string]$request.title) }
      'guard' { [NativeFixture]::Guard([uint32]$request.pid,[string]$request.hwnd,[string]$request.title) }
      'type' { [NativeFixture]::Type([string]$request.text) }
      'snapshot' { }
      default { throw 'Unsupported native fixture method' }
    }
    @{id=$request.id;result=[NativeFixture]::State()} | ConvertTo-Json -Compress
  } catch { @{id=$request.id;error=$_.Exception.Message} | ConvertTo-Json -Compress }
}
`;

// Imported by the Windows smoke for the shared contract fixture only.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
