import { randomUUID } from "node:crypto";
import { type Context, Script } from "node:vm";

type WebBridge = (operation: string, request: string) => string;
const urlFields = [
  "href",
  "origin",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const;
type URLField = (typeof urlFields)[number];

function packet(run: () => unknown): string {
  try {
    return JSON.stringify({ value: run() });
  } catch (error) {
    return JSON.stringify({
      error: { name: (error as Error).name, message: (error as Error).message },
    });
  }
}

// Each native instance is owned by its guest's private callback. There is no
// registry retaining abandoned URLs, params, or their native state.
function createWebBridge(kind: string, configuration: string): WebBridge {
  try {
    const config = JSON.parse(configuration);
    const url = kind === "url" ? new URL(config.input, config.base) : undefined;
    const params = url?.searchParams ?? new URLSearchParams(config);
    let entries: [string, string][] | undefined;
    return (operation, request) =>
      packet(() => {
        const args = JSON.parse(request);
        if (operation === "get" || operation === "set") {
          const key = args[0] as URLField;
          if (!url || !urlFields.includes(key))
            throw new TypeError("Invalid URL property");
          if (operation === "get") return url[key];
          if (key === "origin") throw new TypeError("URL origin is read-only");
          entries = undefined;
          url[key] = args[1];
          return;
        }
        switch (operation) {
          case "init":
            return;
          case "size":
            return params.size;
          case "string":
            return params.toString();
          case "append":
            entries = undefined;
            return params.append(args[0], args[1]);
          case "delete":
            entries = undefined;
            return params.delete(args[0], args[1]);
          case "has":
            return params.has(args[0], args[1]);
          case "getParam":
            return params.get(args[0]);
          case "getAll":
            return params.getAll(args[0]);
          case "setParam":
            entries = undefined;
            return params.set(args[0], args[1]);
          case "sort":
            entries = undefined;
            return params.sort();
          case "entry": {
            // Read the current list, not an iterator-time snapshot: mutations must
            // affect subsequent next()/forEach steps just as native iterators do.
            // Cache only until mutation so ordinary iteration remains linear.
            entries ??= [...params];
            return entries[args[0]] ?? null;
          }
          default:
            throw new TypeError("Unknown web operation");
        }
      });
  } catch (error) {
    const failure = packet(() => {
      throw error;
    });
    return () => failure;
  }
}

/** Install after the runtime bootstrap and before evaluating the user module. */
export function installCodeWebGlobals(context: Context): void {
  const install = new Script(String.raw`
((createBridge, uuidBridge, configuration) => {
  const { Object, String, TypeError, Error, JSON, Reflect, Symbol } = globalThis;
  const parse = JSON.parse, stringify = JSON.stringify, apply = Reflect.apply;
  const config = parse(configuration);
  const string = value => {
    if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    return String(value);
  };
  const unpack = encoded => {
    const result = parse(encoded);
    if (result.error) {
      const error = new (result.error.name === 'TypeError' ? TypeError : Error)(result.error.message);
      error.name = result.error.name;
      throw error;
    }
    return result.value;
  };
  const required = (actual, count) => {
    if (actual < count) throw new TypeError('Not enough arguments');
  };
  const normalize = init => {
    if (init === undefined || init === null) return '';
    if (typeof init !== 'object' && typeof init !== 'function') return string(init);
    const iterator = init[Symbol.iterator];
    if (iterator != null) {
      if (typeof iterator !== 'function') throw new TypeError('Expected an iterable');
      const pairs = [];
      // Use the already-read iterator method, including its guest receiver.
      for (const pair of { [Symbol.iterator]: () => apply(iterator, init, []) }) {
        if (pair === null || (typeof pair !== 'object' && typeof pair !== 'function'))
          throw new TypeError('Expected an iterable pair');
        const values = [];
        for (const value of pair) values.push(string(value));
        if (values.length !== 2) throw new TypeError('Expected exactly two items');
        pairs.push(values);
      }
      return pairs;
    }
    const record = Object.create(null);
    for (const key of Reflect.ownKeys(init)) {
      if (Object.getOwnPropertyDescriptor(init, key)?.enumerable)
        record[string(key)] = string(init[key]);
    }
    return record;
  };
  class ParamsIterator {
    #read; #index = 0; #kind;
    constructor(read, kind) { this.#read = read; this.#kind = kind; }
    next() {
      const pair = this.#read(this.#index);
      if (pair === null) {
        return { value: undefined, done: true };
      }
      this.#index++;
      return { value: this.#kind === 'keys' ? pair[0] : this.#kind === 'values' ? pair[1] : pair, done: false };
    }
    [Symbol.iterator]() { return this; }
    get [Symbol.toStringTag]() { return 'URLSearchParams Iterator'; }
  }
  let linkedParams;
  class URLSearchParams {
    #bridge;
    constructor(init = '') {
      this.#bridge = createBridge('params', stringify(normalize(init)));
      this.#call('init');
    }
    #call(operation, args = []) { return unpack(this.#bridge(operation, stringify(args))); }
    static {
      linkedParams = bridge => {
        const params = new URLSearchParams();
        params.#bridge = bridge;
        return params;
      };
    }
    get size() { return this.#call('size'); }
    append(name, value) { void this.#bridge; required(arguments.length, 2); this.#call('append', [string(name), string(value)]); }
    delete(name, value = undefined) {
      void this.#bridge; required(arguments.length, 1);
      this.#call('delete', value === undefined ? [string(name)] : [string(name), string(value)]);
    }
    has(name, value = undefined) {
      void this.#bridge; required(arguments.length, 1);
      return this.#call('has', value === undefined ? [string(name)] : [string(name), string(value)]);
    }
    get(name) { void this.#bridge; required(arguments.length, 1); return this.#call('getParam', [string(name)]); }
    getAll(name) { void this.#bridge; required(arguments.length, 1); return this.#call('getAll', [string(name)]); }
    set(name, value) { void this.#bridge; required(arguments.length, 2); this.#call('setParam', [string(name), string(value)]); }
    sort() { this.#call('sort'); }
    toString() { return this.#call('string'); }
    #iterator(kind) { void this.#bridge; return new ParamsIterator(index => this.#call('entry', [index]), kind); }
    entries() { return this.#iterator('entries'); }
    keys() { return this.#iterator('keys'); }
    values() { return this.#iterator('values'); }
    forEach(callback, thisArg = undefined) {
      void this.#bridge;
      if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
      for (const [key, value] of this.#iterator('entries')) apply(callback, thisArg, [value, key, this]);
    }
    get [Symbol.toStringTag]() { return 'URLSearchParams'; }
  }
  Object.defineProperty(URLSearchParams.prototype, Symbol.iterator, {
    value: URLSearchParams.prototype.entries, writable: true, configurable: true,
  });
  class URL {
    #bridge; #params;
    constructor(input, base = undefined) {
      required(arguments.length, 1);
      input = string(input);
      if (base !== undefined) base = string(base);
      this.#bridge = createBridge('url', stringify({ input, base }));
      unpack(this.#bridge('init', '[]'));
      this.#params = linkedParams(this.#bridge);
    }
    get searchParams() { return this.#params; }
    toString() { return unpack(this.#bridge('get', '["href"]')); }
    toJSON() { return unpack(this.#bridge('get', '["href"]')); }
    get [Symbol.toStringTag]() { return 'URL'; }
    static {
      for (const key of config.fields) Object.defineProperty(this.prototype, key, {
        configurable: true, enumerable: true,
        get() { return unpack(this.#bridge('get', stringify([key]))); },
        ...(key === 'origin' ? {} : { set(value) {
          const bridge = this.#bridge;
          unpack(bridge('set', stringify([key, string(value)])));
        } }),
      });
    }
  }
  // Conversion exceptions must propagate, while native parsing failures become
  // false/null. Convert outside the catch to preserve that distinction.
  const tryURL = args => {
    required(args.length, 1);
    const input = string(args[0]);
    const base = args[1] === undefined ? undefined : string(args[1]);
    try { return new URL(input, base); } catch { return null; }
  };
  if (config.canParse) Object.defineProperty(URL, 'canParse', {
    configurable: true, writable: true, value: function canParse(input) { return tryURL(arguments) !== null; },
  });
  if (config.parse) Object.defineProperty(URL, 'parse', {
    configurable: true, writable: true, value: function parse(input) { return tryURL(arguments); },
  });
  const crypto = { randomUUID() { return unpack(uuidBridge()); } };
  Object.assign(globalThis, { URL, URLSearchParams, crypto });
})
  `).runInContext(context) as (
    factory: typeof createWebBridge,
    uuid: () => string,
    configuration: string,
  ) => void;
  install(
    createWebBridge,
    () => packet(() => randomUUID()),
    JSON.stringify({
      fields: urlFields,
      canParse: typeof URL.canParse === "function",
      parse: typeof URL.parse === "function",
    }),
  );
}
