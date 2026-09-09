import assert from "node:assert/strict";
import test from "node:test";
import { CodeRuntime } from "../src/code-runtime.js";

const execute = async (code: string) =>
  (
    await new CodeRuntime().execute({
      code,
      nested: {
        invoke: async () => {
          throw new Error("Unexpected I/O");
        },
      },
      signal: new AbortController().signal,
    })
  ).text;

test("URL uses native Unicode, base, query and fragment semantics", async () => {
  assert.deepEqual(
    JSON.parse(
      await execute(`
    const url = new URL('../中?q=hello world&q=2#片段', 'https://用户:密码@例子.测试:443/a/b');
    text([url.href, url.origin, url.protocol, url.username, url.password, url.host,
      url.hostname, url.port, url.pathname, url.search, url.hash, url.toString(), url.toJSON()]);
  `),
    ),
    (() => {
      const url = new URL(
        "../中?q=hello world&q=2#片段",
        "https://用户:密码@例子.测试:443/a/b",
      );
      return [
        url.href,
        url.origin,
        url.protocol,
        url.username,
        url.password,
        url.host,
        url.hostname,
        url.port,
        url.pathname,
        url.search,
        url.hash,
        url.toString(),
        url.toJSON(),
      ];
    })(),
  );
});

async function matchesNative(code: string): Promise<void> {
  let expected: unknown;
  new Function("text", code)((value: unknown) => {
    expected = value;
  });
  assert.deepEqual(JSON.parse(await execute(code)), expected);
}

test("URL setters and searchParams retain two-way linkage and stable identity", async () => {
  await matchesNative(`
    const u = new URL('https://example.com/a?z=hello%20world&z=2#old');
    const p = u.searchParams, rows = [];
    const row = () => rows.push([u.href, u.origin, [...p], p === u.searchParams]);
    p.append('中', 'a+b'); row();
    p.set('z', 'new value'); row();
    u.search = '?b=2&a=1&a=3'; row();
    p.sort(); row();
    p.delete('a', '1'); row();
    u.href = 'http://user:pass@other.test:81/new?x=1#end'; row();
    for (const [key, value] of [
      ['protocol','https:'], ['username','a b'], ['password','密'],
      ['host','例子.测试:443'], ['hostname','another.test'], ['port','8443'],
      ['pathname','/space here/中'], ['hash','#片'], ['search','?u=+'], ['port','invalid']
    ]) { u[key] = value; row(); }
    p.delete('u'); row();
    text(rows);
  `);
});

test("URLSearchParams normalizes strings, iterable pairs and records inside the guest", async () => {
  await matchesNative(String.raw`
    const inputs = [undefined, null, '', '?a=hello+world&a=%FF&b=%E4%B8%AD', 12,
      [['a',1],['a',null],['\ud800','\udc00']], new Map([['a','x'], ['b','y']]),
      { a: 1, b: null, c: undefined, '\ud800': 'one', '\udc00': 'two' },
      Object.assign(Object.create(null), {x:'&=+'}),
      { *[Symbol.iterator]() { yield ['x', {toString(){return 'hello';}}]; yield new Set(['a','b']); } },
      new URLSearchParams('a=1&a=2')];
    const rows = inputs.map(input => {
      const p = new URLSearchParams(input);
      return [p.toString(), [...p], p.size, p.get('a'), p.get('missing'), p.getAll('a'), [...p.keys()], [...p.values()]];
    });
    const p = new URLSearchParams('x=1&x=2&x=1&z=0');
    rows.push([p.has('x'), p.has('x', '2'), p.has('x', '3'), p.has('x', undefined)]);
    p.delete('x', '1'); rows.push([...p]);
    p.append('x', '3'); p.set('z', 'new'); p.delete('x', undefined); rows.push([...p]);
    text(rows);
  `);
});

test("iterators and forEach observe append, delete, sort and URL replacement live", async () => {
  await matchesNative(`
    const u = new URL('https://e.test/?b=1&a=2&c=3'), p = u.searchParams;
    const entries = p.entries(), keys = p.keys(), values = p.values(), rows = [];
    rows.push(entries.next(), keys.next(), values.next());
    p.delete('b'); rows.push(entries.next(), keys.next(), values.next());
    p.append('d', '4'); p.sort(); rows.push(entries.next(), keys.next(), values.next());
    u.search = '?q=1&w=2&e=3&r=4'; rows.push(entries.next(), keys.next(), values.next());
    rows.push(entries.next()); p.append('t','5'); rows.push(entries.next());
    const seen = [], receiver = {};
    const f = new URLSearchParams('a=1&b=2');
    f.forEach(function(value, key, self) {
      seen.push([key, value, self === f, this === receiver]);
      if (key === 'a') f.append('c','3');
      if (key === 'b') { f.delete('a'); f.append('d','4'); }
    }, receiver);
    text(JSON.parse(JSON.stringify([rows, seen, [...f], p[Symbol.iterator] === p.entries])));
  `);
});

test("iterable pair conversion runs while consuming values", async () => {
  await matchesNative(`
    const events = [];
    const pair = { *[Symbol.iterator]() {
      events.push('first'); yield {toString(){events.push('string1'); return 'a';}};
      events.push('second'); yield {toString(){events.push('string2'); return 'b';}};
      events.push('done');
    } };
    text([new URLSearchParams([pair]).toString(), events]);
  `);
});

test("URL static parse helpers reflect native availability and parsing failures", async () => {
  await matchesNative(`
    const rows = [typeof URL.canParse, typeof URL.parse];
    for (const args of [['https://例子.测试/中'], ['../a','https://example.com/x/'],
      ['bad'], ['https://example.com','bad'], ['http://[broken'], ['data:text/plain,hi']]) {
      if (URL.canParse) rows.push(URL.canParse(...args));
      if (URL.parse) rows.push(URL.parse(...args)?.href ?? null);
    }
    text(rows);
  `);
});

test("URL and params failures are guest TypeErrors, including receiver and conversion errors", async () => {
  assert.equal(
    await execute(`
    const cases = [() => new URL(), () => URL('https://example.com'), () => new URL('invalid'),
      () => new URL('/x', 'invalid'), () => new URL(Symbol()),
      () => new URLSearchParams([[1]]), () => new URLSearchParams([[1,2,3]]),
      () => new URLSearchParams(['ab']), () => new URLSearchParams({[Symbol()]: 'x'}),
      () => new URLSearchParams({[Symbol.iterator]: 1}),
      () => new URLSearchParams(Symbol()), () => new URLSearchParams().append('x'),
      () => new URLSearchParams().set('x'), () => new URLSearchParams().has(),
      () => new URLSearchParams().delete(), () => new URLSearchParams().get(),
      () => new URLSearchParams().getAll(), () => new URLSearchParams().forEach(null),
      () => URL.prototype.toString.call({}), () => URL.prototype.toJSON.call({}),
      () => URLSearchParams.prototype.get.call({}, 'x'), () => URLSearchParams.prototype.entries.call({}),
      () => Object.getOwnPropertyDescriptor(URL.prototype,'href').get.call({}),
      () => Object.getOwnPropertyDescriptor(URL.prototype,'href').set.call({}, 'https://e.test'),
      () => Object.getOwnPropertyDescriptor(URLSearchParams.prototype,'size').get.call({}),
      () => { const u = new URL('https://e.test'); u.href = 'broken'; }];
    if (URL.parse) cases.push(() => URL.parse(), () => URL.parse(Symbol()));
    if (URL.canParse) cases.push(() => URL.canParse(), () => URL.canParse(Symbol()));
    for (const run of cases) {
      try { run(); throw new Error('missing error'); }
      catch (error) {
        if (!(error instanceof TypeError)) throw error;
        try { error.constructor.constructor('return process')(); throw new Error('escape'); }
        catch (blocked) { if (!(blocked instanceof EvalError)) throw blocked; }
      }
    }
    const sentinel = new Error('conversion');
    for (const fn of [URL.parse, URL.canParse].filter(Boolean)) {
      try { fn({toString(){throw sentinel;}}); throw new Error('missing error'); }
      catch (error) { if (error !== sentinel) throw error; }
    }
    text('guest errors');
  `),
    "guest errors",
  );
});

test("all URL surfaces and UUID stay guest-owned without extra crypto or I/O", async () => {
  assert.deepEqual(
    JSON.parse(
      await execute(`
    const u = new URL('https://example.com/?x=1'), p = u.searchParams;
    const targets = [URL, URLSearchParams, u, p, crypto, crypto.randomUUID,
      p.getAll('x'), p.entries(), p.entries().next(), p.entries().next().value,
      Object.getPrototypeOf(p.entries()).next, Object.getPrototypeOf(p.entries())[Symbol.iterator]];
    for (const object of [URL, URLSearchParams, URL.prototype, URLSearchParams.prototype, Object.getPrototypeOf(p.entries())]) {
      for (const key of Reflect.ownKeys(object)) {
        const d = Object.getOwnPropertyDescriptor(object, key);
        for (const value of [d.value, d.get, d.set]) if (typeof value === 'function') targets.push(value);
      }
    }
    for (const target of targets) {
      try { target.constructor.constructor('return process')(); throw new Error('escape'); }
      catch (error) { if (!(error instanceof EvalError)) throw error; }
    }
    const ids = Array.from({length:128}, () => crypto.randomUUID());
    if (ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) || new Set(ids).size !== ids.length)
      throw new Error('Invalid UUID');
    text([Object.keys(crypto), typeof crypto.subtle, typeof crypto.getRandomValues, typeof URL.createObjectURL,
      typeof URL.revokeObjectURL, typeof process, typeof require, typeof Buffer, typeof fetch, typeof Blob,
      Reflect.ownKeys(u), Reflect.ownKeys(p)]);
  `),
    ),
    [["randomUUID"], ...Array(9).fill("undefined"), [], []],
  );
});

test("discarded URL utilities do not accumulate a host registry", async () => {
  assert.equal(
    await execute(`
    for (let i = 0; i < 100000; i++) {
      new URL('https://example.com/?a=1').searchParams.entries().next();
      new URLSearchParams('x=1&x=2');
    }
    text('done');
  `),
    "done",
  );
});
