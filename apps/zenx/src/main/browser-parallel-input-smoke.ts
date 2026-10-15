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
import { BrowserInputUnsupportedError } from "./capabilities/browser-targeted-input.js";
import type {
  BrowserInspection,
  ZenXBrowserBackend,
} from "./capabilities/browser-provider.js";
import {
  connectUserBrowserCdp,
  UserBrowserDocumentChangedBeforeDispatchError,
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

class Rpc {
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
      };
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error)
        pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result ?? {});
    });
    const fail = () => {
      for (const pending of this.#pending.values())
        pending.reject(new Error("Fixture CDP socket closed"));
      this.#pending.clear();
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
  ): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} fixture timeout; never replay an input`));
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
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
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
<script>
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

/** Served only by the disposable local smoke servers, before any tracker exists. */
export function targetedInputContractPage(requestUrl: string): string {
  const mode = new URL(requestUrl, "http://127.0.0.1").searchParams.get("mode");
  return `<!doctype html><meta charset="utf-8"><title>ZenX targeted input contract</title>
<style>body{margin:0;font:16px system-ui}#contract-host{position:absolute;left:20px;top:20px;width:620px;height:480px}#status{position:absolute;top:530px}</style>
<div id="contract-host"></div><p id="status">Disposable targeted input contract</p>
<script>
const mode=${JSON.stringify(mode)};
const host=document.querySelector('#contract-host');
let root=host;
if(mode==='shadow'||mode==='closed-shadow')root=host.attachShadow({mode:mode==='shadow'?'open':'closed'});
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
for(const type of eventTypes)window.addEventListener(type,event=>events.push({type,trusted:event.isTrusted,target:event.composedPath()[0]?.id||''}),true);
if(mode==='stop-propagation'||mode==='stop-immediate'){
  for(const type of eventTypes)window.addEventListener(type,event=>{
    if(mode==='stop-immediate')event.stopImmediatePropagation();else event.stopPropagation();
  },true);
}
window.contract={mode,events,clicks:0,widgets:{},
  point(id){const element=node(id);if(!element)throw Error('Missing fixture node '+id);const hit=id.startsWith('label-')?element.querySelector('span'):element;const r=hit.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}},
  focus(id){const element=node(id);element.focus();if(element.isContentEditable){const range=document.createRange();range.selectNodeContents(element);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)}return {outer:document.activeElement?.id,inner:element.getRootNode().activeElement?.id||document.activeElement?.id}},
  state(){return {mode,events:[...events],clicks:this.clicks,widgets:{...this.widgets},values:{'text-a':node('text-a')?.value,'text-b':node('text-b')?.value,editor:node('editor')?.textContent.replaceAll(String.fromCharCode(160),' ')},a:node('text-a')?.value,b:node('text-b')?.value,visibility:document.visibilityState,outer:document.activeElement?.id}},
};
if(node('canvas'))node('canvas').onclick=event=>{if(!event.isTrusted)throw Error('Untrusted fixture click');contract.clicks++;event.currentTarget.focus()};
for(const id of ['button-span','widget'])if(node(id))node(id).addEventListener('pointerdown',event=>{if(!event.isTrusted)throw Error('Untrusted widget pointer');contract.widgets[id]=(contract.widgets[id]||0)+1});
node(mode==='ordinary-dom'?'editor':'text-a').focus();
</script>`;
}

interface ContractState {
  mode: string;
  widgets: Record<string, number>;
  values: Record<string, string | undefined>;
  events: { type: string; trusted: boolean; target: string }[];
  clicks: number;
  a?: string;
  b?: string;
  visibility: string;
  outer: string;
}
interface ContractInput {
  method: string;
  type: string;
  sessionId: string;
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
  const inputs: ContractInput[] = [];
  const reports: Record<string, unknown>[] = [];
  // A passive, scoped tap on actual outgoing ws messages. No mock transport,
  // rewritten events, retries, tracker access or synthetic trusted-event shims.
  // Only the provider's browser socket/session-scoped Input is counted.
  const originalSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, ...args: unknown[]) {
    if (
      this.url === version.webSocketDebuggerUrl &&
      typeof args[0] === "string"
    ) {
      const message = JSON.parse(args[0]) as {
        method?: string;
        sessionId?: string;
        params?: { type?: string };
      };
      if (message.method?.startsWith("Input.")) {
        assert.ok(
          message.sessionId,
          "Provider Input must bind an exact CDP session",
        );
        inputs.push({
          method: message.method,
          type: message.params?.type ?? "",
          sessionId: message.sessionId,
        });
      }
    }
    return Reflect.apply(originalSend, this, args);
  };
  const state = async () =>
    await rpc.evaluate<ContractState>("window.contract.state()");
  const inspect = async () => {
    const observation = await backend.inspect(sessionId, tabId);
    assert.equal(observation.screenshot.status, "captured");
    assert.ok(
      observation.inputViewport,
      "Contract requires a real coherent screenshot",
    );
    return observation;
  };
  const focus = async (id: string) =>
    await rpc.evaluate<{ outer: string; inner: string }>(
      `window.contract.focus(${JSON.stringify(id)})`,
    );
  const point = async (id: string) =>
    await rpc.evaluate<{ x: number; y: number }>(
      `window.contract.point(${JSON.stringify(id)})`,
    );
  const paired = async (kind: "click" | "key", id: string) => {
    if (kind === "key") assert.equal((await focus(id)).inner, id);
    const position = kind === "click" ? await point(id) : undefined;
    const observation = await inspect();
    if (kind === "key") assert.equal(observation.focusedInputAvailable, true);
    const before = await state();
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
      await backend.keyPress!(
        sessionId,
        tabId,
        observation.observationId,
        "Space",
      );
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
    const after = await state();
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
    else assert.equal(after.values[id], before.values[id] + " ");
    if (kind === "click" && ["button-span", "widget"].includes(id))
      assert.equal(after.widgets[id], (before.widgets[id] ?? 0) + 1);
    await guard();
    return dispatched;
  };
  const rejected = async (
    label: string,
    action: () => Promise<unknown>,
    expected: RegExp | "native-surface" | "shadow-surface",
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
    for (const mode of [
      "stop-propagation",
      "stop-immediate",
      "shadow",
      "light-native",
      "closed-shadow",
      "deep-shadow",
      "ordinary-dom",
    ]) {
      options.onPhase?.(`input-contracts:${mode}:navigate`);
      await guard();
      await backend.navigate(
        sessionId,
        tabId,
        `${origin}/input-contract?mode=${mode}`,
      );
      await poll(async () => {
        try {
          return (await rpc.evaluate<boolean>(
            `window.contract?.mode === ${JSON.stringify(mode)}`,
          ))
            ? true
            : undefined;
        } catch {
          return undefined;
        } // Only read-only document readiness is retried.
      }, `contract ${mode} document`);
      options.onPhase?.(`input-contracts:${mode}:actions`);
      assert.equal(
        (await state()).visibility,
        "hidden",
        "Contract page must stay inactive",
      );
      const cases: Record<string, unknown>[] = [];
      if (mode === "stop-propagation" || mode === "stop-immediate") {
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
      } else if (mode === "shadow" || mode === "light-native") {
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
        if (mode === "shadow") {
          const a = await focus("text-a");
          const old = await inspect();
          const b = await focus("text-b");
          assert.equal(
            a.outer,
            b.outer,
            "Focus regression needs the SAME outer shadow host",
          );
          assert.equal(a.inner, "text-a");
          assert.equal(b.inner, "text-b");
          cases.push(
            await rejected(
              "shadow-focus-A-to-B-stale",
              () =>
                backend.keyPress!(sessionId, tabId, old.observationId, "Space"),
              /changed|stale|inspect again/iu,
            ),
          );
          cases.push({
            case: "fresh-shadow-focus-B",
            pair: await paired("key", "text-b"),
          });
        }
        for (const type of ["file", "color", "date", "select"]) {
          for (const id of [`native-${type}`, `label-${type}`]) {
            const position = await point(id);
            let observation = await inspect();
            cases.push(
              await rejected(
                `${id}-pointer`,
                () =>
                  backend.pointerClick!(
                    sessionId,
                    tabId,
                    observation.observationId,
                    position.x,
                    position.y,
                  ),
                "native-surface",
              ),
            );
            assert.equal(
              (await focus(id)).inner,
              id,
              "Native/label key test must focus that exact fixture node",
            );
            for (const key of ["Enter", "Space"] as const) {
              observation = await inspect();
              assert.equal(
                observation.focusedInputAvailable,
                false,
                "Native/label focus must not advertise keyboard support",
              );
              cases.push(
                await rejected(
                  `${id}-${key}`,
                  () =>
                    backend.keyPress!(
                      sessionId,
                      tabId,
                      observation.observationId,
                      key,
                    ),
                  "native-surface",
                ),
              );
            }
          }
        }
        cases.push({
          case: "ordinary-after-rejection",
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
      if (mode === "closed-shadow") {
        for (const type of ["file", "color", "date", "select"]) {
          const id = `native-${type}`;
          const position = await point(id);
          await focus(id);
          const observed = await inspect();
          assert.equal(observed.focusedInputAvailable, false);
          cases.push(
            await rejected(
              `${id}-closed-pointer`,
              () =>
                backend.pointerClick!(
                  sessionId,
                  tabId,
                  observed.observationId,
                  position.x,
                  position.y,
                ),
              "shadow-surface",
            ),
          );
          cases.push(
            await rejected(
              `${id}-closed-Space`,
              () =>
                backend.keyPress!(
                  sessionId,
                  tabId,
                  observed.observationId,
                  "Space",
                ),
              "shadow-surface",
            ),
          );
        }
      }
      await guard();
      reports.push({
        scenario: mode,
        layer: "headed-real-cdp-contract",
        status: "passed",
        cases,
      });
    }
    return reports;
  } finally {
    WebSocket.prototype.send = originalSend;
    rpc.close();
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
    "Page.navigatedWithinDocument",
    "Page.frameStoppedLoading",
    "Runtime.enable",
    "Runtime.evaluate",
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
  let browser: ChildProcess | undefined;
  let browserError = "";
  let phase = "startup";
  const transportDiagnostics: unknown[] = [];
  let transportDropped = 0;
  let stopTransport: (() => void) | undefined;
  let native: Native | undefined;
  let connection: UserBrowserConnection | undefined;
  let browserRpc: Rpc | undefined,
    userRpc: Rpc | undefined,
    agentRpc: Rpc | undefined;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (request.url?.startsWith("/input-contract")) {
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
      try {
        return (await userRpc!.evaluate<boolean>(
          "Boolean(window.fixture && document.querySelector('#user-input'))",
        ))
          ? true
          : undefined;
      } catch {
        return undefined;
      } // Read-only readiness may race initial navigation.
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
    connection = await connectUserBrowserCdp(endpoint);
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
      try {
        return (await agentRpc!.evaluate<boolean>(
          "Boolean(window.fixture && document.querySelector('#agent-input'))",
        ))
          ? true
          : undefined;
      } catch {
        return undefined;
      }
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
      for (const layer of ["cdp-data-isolation", "real-os-input"] as const) {
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
              if (layer === "cdp-data-isolation")
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
          "No concurrent user-input batch was observed",
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
          typedCharacters: produced.length,
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
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "failed",
        platform: process.platform,
        reports,
        phase,
        transportDiagnostics,
        transportDropped,
        ownedBrowser: {
          pid: browser?.pid,
          exitCode: browser?.exitCode,
          signalCode: browser?.signalCode,
          killed: browser?.killed,
          stderr: browserError,
        },
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  } finally {
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
