import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Execute the exact shipped initializers, including inaccessible-storage fallback.
// Packaged App acceptance separately verifies the real default rendering path.
test("virtual transcript and Find default on with independent per-tab DOM fallback", async () => {
  const source = await readFile(
    new URL("../src/renderer/src/ThreadView.tsx", import.meta.url),
    "utf8",
  );
  for (const name of ["virtualTranscript", "virtualTranscriptFind"]) {
    const start = source.indexOf(`const [${name}] = useState(() => {`);
    assert.ok(start >= 0);
    const body = source.slice(
      start + `const [${name}] = useState(() => {`.length,
      source.indexOf("\n  });", start),
    );
    const run = new Function("window", body);
    const key = `zenx.experimental.${name}`;
    for (const value of [null, "1", "unknown"]) {
      const reads: string[] = [];
      assert.equal(
        run({
          ResizeObserver: class {},
          sessionStorage: {
            getItem: (name: string) => {
              reads.push(name);
              return value;
            },
          },
        }),
        true,
      );
      assert.deepEqual(reads, [key]);
    }
    assert.equal(
      run({ ResizeObserver: class {}, sessionStorage: { getItem: () => "0" } }),
      false,
    );
    assert.equal(
      run({
        ResizeObserver: class {},
        sessionStorage: {
          getItem: () => {
            throw new Error("storage unavailable");
          },
        },
      }),
      false,
    );
    assert.equal(run(undefined), false);
    if (name === "virtualTranscript")
      assert.equal(run({ sessionStorage: { getItem: () => null } }), false);
  }
});
