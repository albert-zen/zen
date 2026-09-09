import assert from "node:assert/strict";
import test from "node:test";
import { CodeRuntime } from "../src/code-runtime.js";

const execute = async (code: string) =>
  (
    await new CodeRuntime().execute({
      code,
      nested: { invoke: async () => ({ output: "", exitCode: 0 }) },
      signal: new AbortController().signal,
    })
  ).text;

test("native base64 codecs handle binary strings, whitespace and invalid inputs", async () => {
  assert.deepEqual(
    JSON.parse(
      await execute(`
    const errors = [];
    for (const run of [() => atob('a'), () => atob('@@@@'), () => atob('YQ==='), () => btoa('😀'), () => btoa('\\ud800')]) {
      try { run(); errors.push('missing error'); } catch (error) { errors.push([error.name, error instanceof Error]); }
    }
    text([btoa('\\0\\xff'), atob(' AP8=\\n'), atob('YQ'), errors]);
  `),
    ),
    [
      "AP8=",
      "\0\xff",
      "a",
      Array.from({ length: 5 }, () => ["InvalidCharacterError", true]),
    ],
  );
});

test("TextEncoder matches native UTF-8 including lone surrogates and encodeInto boundaries", async () => {
  const source = "A😀中\ud800Z\udc00";
  const expected = new TextEncoder().encode(source);
  assert.deepEqual(
    JSON.parse(
      await execute(`
    const encoder = new TextEncoder();
    const source = ${JSON.stringify(source)};
    const rows = [];
    for (let size = 0; size < 16; size++) {
      const buffer = new Uint8Array(size + 4).fill(99);
      const dest = buffer.subarray(2, size + 2);
      rows.push([encoder.encodeInto(source, dest), [...buffer]]);
    }
    text([encoder.encoding, [...encoder.encode(source)], [...encoder.encode()], rows]);
  `),
    ),
    [
      "utf-8",
      [...expected],
      [],
      Array.from({ length: 16 }, (_, size) => {
        const buffer = new Uint8Array(size + 4).fill(99);
        return [
          new TextEncoder().encodeInto(source, buffer.subarray(2, size + 2)),
          [...buffer],
        ];
      }),
    ],
  );
});

test("TextDecoder uses native labels, BufferSource views, BOM and streaming state", async () => {
  assert.deepEqual(
    JSON.parse(
      await execute(`
    const d = new TextDecoder(' UTF8 ');
    const bytes = new Uint8Array([99, 239, 187, 191, 65, 99]);
    const utf16 = new Uint8Array([99, 65, 0, 66, 0, 99]);
    const stream = new TextDecoder();
    const pieces = [stream.decode(new Uint8Array([240,159]), {stream:true}), stream.decode(new Uint8Array([152]), {stream:true}), stream.decode(new Uint8Array([128]))];
    text([d.encoding, d.fatal, d.ignoreBOM, d.decode(bytes.subarray(1,5)),
      new TextDecoder('utf-8', {ignoreBOM:true}).decode(bytes.subarray(1,5)),
      new TextDecoder('utf-16le').decode(new DataView(utf16.buffer,1,4)),
      new TextDecoder('windows-1252').decode(new Uint8Array([128]).buffer), pieces,
      new TextDecoder().decode(new Uint8Array([255])), new TextDecoder().decode()]);
  `),
    ),
    ["utf-8", false, false, "A", "\ufeffA", "AB", "€", ["", "", "😀"], "�", ""],
  );
});

test("decoder fatal failures reset correctly and invalid inputs remain guest errors", async () => {
  assert.deepEqual(
    JSON.parse(
      await execute(`
    const errors = [];
    const fatal = new TextDecoder('utf-8', {fatal:true});
    fatal.decode(new Uint8Array([240]), {stream:true});
    for (const run of [() => fatal.decode(), () => new TextDecoder('made-up'),
      () => new TextDecoder().decode([65]), () => new TextEncoder().encodeInto('x', new Uint16Array(2)),
      () => TextEncoder.prototype.encode.call({}), () => TextDecoder.prototype.decode.call({})]) {
      try { run(); errors.push('missing error'); } catch (e) { errors.push([e.name, e instanceof Error]); }
    }
    text([errors, fatal.decode(new Uint8Array([65]))]);
  `),
    ),
    [
      [
        ["TypeError", true],
        ["RangeError", true],
        ["TypeError", true],
        ["TypeError", true],
        ["TypeError", true],
        ["TypeError", true],
      ],
      "A",
    ],
  );
});

test("repeated import.meta access rejects without caching an empty object or host constructors", async () => {
  assert.equal(
    await execute(`
    for (let i = 0; i < 2; i++) {
      try { text(import.meta); } catch (error) {
        text([error instanceof Error, error.message]);
        try { error.constructor.constructor('return process')(); text('escape'); }
        catch (blocked) { text(blocked.name); }
      }
    }
  `),
    Array(2)
      .fill(
        '[true,"import.meta is unavailable in run_code; use tools instead"]\nEvalError',
      )
      .join("\n"),
  );
});

test("codec functions, instances, byte arrays and failures cannot expose host constructors", async () => {
  assert.equal(
    await execute(`
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const targets = [atob, btoa, TextEncoder, TextDecoder, encoder, decoder,
      encoder.encode, encoder.encodeInto, decoder.decode, encoder.encode('hello'),
      encoder.encode('hello').buffer, encoder.encodeInto('a', new Uint8Array(1))];
    for (const cls of [TextEncoder, TextDecoder]) {
      for (const key of Object.getOwnPropertyNames(cls.prototype)) {
        const property = Object.getOwnPropertyDescriptor(cls.prototype, key);
        if (property.get) targets.push(property.get);
      }
    }
    for (const run of [() => atob('@'), () => btoa('中'), () => new TextDecoder('bogus'),
      () => new TextDecoder('utf-8', {fatal:true}).decode(new Uint8Array([255])),
      () => decoder.decode({}), () => encoder.encodeInto('a', {})]) {
      try { run(); } catch (error) { if (!(error instanceof Error)) throw new Error('foreign error'); targets.push(error); }
    }
    for (const target of targets) {
      try { target.constructor.constructor('return process')(); throw new Error('escape'); }
      catch (error) { if (!(error instanceof EvalError)) throw error; }
    }
    text([typeof process, typeof require, typeof Buffer, typeof fetch, typeof URL, typeof Blob, typeof crypto]);
  `),
    '["undefined","undefined","undefined","undefined","undefined","undefined","undefined"]',
  );
});

test("view offsets are intrinsic and decoder streams are independent", async () => {
  assert.deepEqual(
    JSON.parse(
      await execute(`
    const buffer = new Uint8Array([99,65,66,99]);
    const view = buffer.subarray(1,3);
    Object.defineProperties(view, {buffer:{value:new ArrayBuffer(0)}, byteOffset:{value:0}, byteLength:{value:0}});
    const first = new TextDecoder();
    const second = new TextDecoder();
    const a = first.decode(new Uint8Array([226]), {stream:true});
    const b = second.decode(new Uint8Array([65]));
    const c = first.decode(new Uint8Array([130,172]));
    text([new TextDecoder().decode(view), new TextEncoder().encodeInto('XY', view), [...buffer], a,b,c]);
  `),
    ),
    ["AB", { read: 2, written: 2 }, [99, 88, 89, 99], "", "A", "€"],
  );
});

test("native decoder streaming errors and split BOM match across calls", async () => {
  const scenarios = [
    { fatal: false, ignoreBOM: false, chunks: [[239], [187], [191, 65], []] },
    { fatal: false, ignoreBOM: true, chunks: [[239], [187], [191, 65], []] },
    { fatal: false, ignoreBOM: false, chunks: [[240], [65], [], [66]] },
    { fatal: true, ignoreBOM: false, chunks: [[240], [65], [], [66]] },
  ];
  const expected = scenarios.map(({ fatal, ignoreBOM, chunks }) => {
    const decoder = new TextDecoder("utf-8", { fatal, ignoreBOM });
    return chunks.map((chunk, i) => {
      try {
        return decoder.decode(new Uint8Array(chunk), {
          stream: i !== chunks.length - 1,
        });
      } catch (error) {
        return { error: (error as Error).name };
      }
    });
  });
  assert.deepEqual(
    JSON.parse(
      await execute(`
    text(${JSON.stringify(scenarios)}.map(({fatal,ignoreBOM,chunks}) => {
      const decoder = new TextDecoder('utf-8', {fatal,ignoreBOM});
      return chunks.map((chunk,i) => {
        try { return decoder.decode(new Uint8Array(chunk), {stream:i !== chunks.length - 1}); }
        catch (error) { return {error:error.name}; }
      });
    }));
  `),
    ),
    expected,
  );
});
