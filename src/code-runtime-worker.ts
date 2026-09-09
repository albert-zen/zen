import { createContext, Script, SourceTextModule } from "node:vm";
import { type MessagePort, workerData } from "node:worker_threads";

interface WorkerInput {
  code: string;
  maxTextBytes: number;
  maxStateValueBytes: number;
  maxStateBytes: number;
  maxStateKeys: number;
  maxStateWrites: number;
  maxMediaBytes: number;
  tools: readonly { name: string; description: string }[];
  storedValues: Record<string, unknown>;
  port: MessagePort;
}

const input = workerData as WorkerInput;
const port = input.port;
const timers = new Map<number, NodeJS.Timeout>();
// Only primitives cross into the context. The sole host function is captured by
// context-owned closures during bootstrap, never installed on the guest global.
// In particular, imports must reject with a *context-owned* Error, not a Node Error.
const context = createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});
interface GuestControl {
  receive(encoded: string): void;
  finish(): void;
  fail(message: string): void;
  error(message: string): Error;
}
const bootstrap = new Script(String.raw`
((bridge, configuration) => {
  const { Object, Array, Number, String, JSON, Reflect, Map, Set, Promise, Error, Math } = globalThis;
  // A guest toJSON on an intrinsic prototype must not rewrite bridge envelopes.
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const config = parse(configuration);
  const pending = new Map();
  const requests = new Map();
  const timers = new Map();
  const values = new Map(Object.entries(config.storedValues));
  const exitSignal = {};
  let sequence = 0;
  let timerSequence = 0;
  let textBytes = 0;
  let hasText = false;
  let truncated = false;
  let mediaBytes = 0;
  let stateWrites = 0;
  let finished = false;
  const send = message => {
    if (finished) return;
    const failure = bridge(stringify(message));
    if (failure !== undefined) throw new Error(failure);
  };
  const bytes = value => {
    let size = 0;
    for (const char of value) {
      const point = char.codePointAt(0);
      size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    return size;
  };
  const json = value => {
    const seen = new Set();
    const visit = (entry, depth) => {
      if (depth > 100) throw new Error('JSON nesting exceeds 100 levels');
      if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
      if (typeof entry === 'number' && Number.isFinite(entry) && !Object.is(entry, -0)) return;
      if (typeof entry !== 'object' || entry === null || seen.has(entry)) throw new Error('Value is not lossless JSON');
      if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) throw new Error('Value is not lossless JSON');
      seen.add(entry);
      if (Array.isArray(entry)) {
        for (let i = 0; i < entry.length; ++i) {
          if (!Object.hasOwn(entry, i)) throw new Error('Value is not lossless JSON');
          visit(entry[i], depth + 1);
        }
      } else {
        for (const key of Reflect.ownKeys(entry)) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, key);
          if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Value is not lossless JSON');
          visit(descriptor.value, depth + 1);
        }
      }
      seen.delete(entry);
    };
    visit(value, 0);
    const encoded = stringify(value);
    if (encoded === undefined) throw new Error('Value is not lossless JSON');
    return encoded;
  };
  const stateSize = () => {
    if (values.size > config.maxStateKeys) throw new Error('Stored state exceeds key limit');
    for (const [key, value] of values) {
      if (key.length < 1 || key.length > 160) throw new Error('Store key must contain 1-160 characters');
      const encoded = json(value);
      if (bytes(encoded) > config.maxStateValueBytes) throw new Error('Stored value exceeds byte limit');
    }
    if (bytes(json(Object.fromEntries(values))) > config.maxStateBytes) throw new Error('Stored state exceeds byte limit');
  };
  stateSize();
  const tools = new Proxy(Object.create(null), {
    get(_target, name) {
      if (typeof name !== 'string') return undefined;
      return args => {
        const cloned = parse(json(args));
        if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) throw new Error('Tool arguments must be an object');
        const requestId = 'nested-' + (++sequence);
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        // A fire-and-forget rejection must not crash Node before the final
        // unawaited-call diagnostic can be delivered.
        promise.catch(() => {});
        const record = { observed: false, resolve, reject };
        pending.set(requestId, record);
        requests.set(requestId, record);
        send({ type: 'tool_call', requestId, name, arguments: cloned });
        const observe = () => {
          if (record.observed) return;
          record.observed = true;
          send({ type: 'tool_observed', requestId });
        };
        return {
          then(yes, no) { observe(); return promise.then(yes, no); },
          catch(no) { observe(); return promise.catch(no); },
          finally(callback) { observe(); return promise.finally(callback); },
        };
      };
    },
  });
  const text = value => {
    if (value === undefined || truncated) return;
    const part = typeof value === 'string' ? value : stringify(value);
    if (part === undefined) return;
    let delta = (hasText ? '\n' : '') + part;
    const available = config.maxTextBytes - textBytes;
    if (bytes(delta) > available) {
      let prefix = '', used = 0;
      for (const char of delta) {
        const length = bytes(char);
        if (used + length > available) break;
        prefix += char;
        used += length;
      }
      delta = prefix;
      truncated = true;
    }
    textBytes += bytes(delta);
    hasText = true;
    send({ type: 'text', delta, truncated });
  };
  const media = (type, value) => {
    const encoded = json(value);
    const size = bytes(encoded);
    if (mediaBytes + size > config.maxMediaBytes) throw new Error('Media descriptors exceed byte limit');
    mediaBytes += size;
    send({ type: 'media', kind: type, value: parse(encoded) });
  };
  const store = (key, value) => {
    if (stateWrites >= config.maxStateWrites) throw new Error('Stored state exceeds write limit');
    if (typeof key !== 'string' || key.length < 1 || key.length > 160) throw new Error('Store key must contain 1-160 characters');
    const cloned = parse(json(value));
    const existed = values.has(key), previous = values.get(key);
    values.set(key, cloned);
    try { stateSize(); } catch (error) {
      if (existed) values.set(key, previous); else values.delete(key);
      throw error;
    }
    ++stateWrites;
    send({ type: 'store', key, value: cloned });
  };
  const load = key => {
    if (typeof key !== 'string') throw new Error('Load key must be a string');
    return values.has(key) ? parse(json(values.get(key))) : undefined;
  };
  const finish = () => {
    if (finished) return;
    send({ type: 'completed', unawaitedRequestIds: [...requests].filter(([, r]) => !r.observed).map(([id]) => id) });
    finished = true;
  };
  const fail = message => {
    if (finished) return;
    send({ type: 'failed', code: 'EXECUTION_FAILED', message, unawaitedRequestIds: [...requests].filter(([, r]) => !r.observed).map(([id]) => id) });
    finished = true;
  };
  Object.assign(globalThis, {
    tools, text, store, load,
    image: value => media('image', value),
    audio: value => media('audio', value),
    ALL_TOOLS: Object.freeze(config.tools.map(tool => Object.freeze(tool))),
    exit: () => { finish(); throw exitSignal; },
    yield_control: async () => { send({ type: 'yield' }); },
    setTimeout: (callback, delay = 0, ...args) => {
      if (typeof callback !== 'function') throw new Error('Timer callback must be a function');
      const id = ++timerSequence;
      timers.set(id, () => callback(...args));
      send({ type: 'timer', id, delay: Math.min(2147483647, Math.max(0, Number(delay) || 0)) });
      return id;
    },
    clearTimeout: id => { timers.delete(id); send({ type: 'clear_timer', id: Number(id) || 0 }); },
  });
  return {
    finish, fail,
    error: message => new Error(message),
    receive(encoded) {
      if (finished) return;
      const message = parse(encoded);
      if (message.type === 'timer') {
        const callback = timers.get(message.id);
        timers.delete(message.id);
        if (callback) {
          try {
            Promise.resolve(callback()).catch(error => fail(String(error?.message ?? error)));
          } catch (error) { if (error !== exitSignal) fail(String(error?.message ?? error)); }
        }
        return;
      }
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      if (message.type === 'tool_result') request.resolve(message.result);
      else {
        const error = new Error(message.message);
        error.name = message.code;
        request.reject(error);
      }
    },
  };
})
`).runInContext(context) as (
  bridge: (message: string) => string | undefined,
  configuration: string,
) => GuestControl;

let guest: GuestControl;
try {
  guest = bootstrap(
    (encoded) => {
      // Never let a host exception cross the context boundary.
      try {
        const message = JSON.parse(encoded) as Record<string, unknown>;
        if (message.type === "timer") {
          const id = message.id as number;
          timers.set(
            id,
            setTimeout(() => {
              timers.delete(id);
              guest.receive(JSON.stringify({ type: "timer", id }));
            }, message.delay as number),
          );
        } else if (message.type === "clear_timer") {
          const id = message.id as number;
          clearTimeout(timers.get(id));
          timers.delete(id);
        } else {
          port.postMessage(encoded);
        }
        return undefined;
      } catch {
        return "Host bridge failed";
      }
    },
    JSON.stringify({
      maxTextBytes: input.maxTextBytes,
      maxStateValueBytes: input.maxStateValueBytes,
      maxStateBytes: input.maxStateBytes,
      maxStateKeys: input.maxStateKeys,
      maxStateWrites: input.maxStateWrites,
      maxMediaBytes: input.maxMediaBytes,
      tools: input.tools,
      storedValues: input.storedValues,
    }),
  );
  port.on("message", (encoded: unknown) => {
    if (typeof encoded === "string") guest.receive(encoded);
  });
  const module = new SourceTextModule(input.code, {
    context,
    identifier: "run_code",
    importModuleDynamically: () => {
      throw guest.error(
        "Imports are unavailable in run_code; use tools instead",
      );
    },
  });
  await module.link(() => {
    throw new Error("Imports are unavailable in run_code; use tools instead");
  });
  await module.evaluate();
  guest.finish();
} catch (error) {
  let message = "JavaScript execution failed";
  try {
    message = String((error as { message?: unknown })?.message ?? error);
  } catch {
    /* Guest error formatting may itself throw. */
  }
  if (guest!) guest.fail(message);
  else
    port.postMessage(
      JSON.stringify({
        type: "failed",
        code: "EXECUTION_FAILED",
        message,
        unawaitedRequestIds: [],
      }),
    );
}
