# Programmable Browser and Computer objects

`run_code` is the primary programmable entry point. Each program is a fresh
JavaScript module, not a persistent REPL. Discover the providers in the frozen
eligible catalog, then selectively retrieve method documentation:

```js
text(capabilities.list());
text(ALL_TOOLS.filter((t) => t.objectBinding?.kind === "browser"));
```

Each catalog entry's `objectBinding` gives its provider, method path, and optional
reference factory/argument. The exact `inputSchema` and `fullDescription` remain
lazy catalog details. Nothing enumerates sessions or historical references into
the stable `run_code` description.

```js
const browser = capabilities.browser("workspace");
const tab = browser.tab("r1"); // use an actual reference returned by this provider
const result = await tab.inspect({ query: "Save" });
if (result.exitCode !== 0) text(result);
else text(result.structuredContent); // select only what the model needs
```

Names in this example exist only when the provider declares them. Different
providers expose their real extensions, not emulated lowest-common-denominator
methods. Inspect matching catalog entries before invoking an extension. A
reference-bound method injects the declared reference argument and rejects a
conflicting explicit argument. Arguments otherwise follow the standalone tool's
exact schema. Results, including nonzero exit codes and provider errors, are
unchanged; callers must check `exitCode`.

## Ownership and compatibility

- Browser sessions own tabs and event buffers; native Computer providers own
  application/window observations and input bindings. Reacquire disposable
  objects from current short references in each program. A facade is not a new
  session, permission, cached observation, persistent JS object or live handle.
- Existing reference ownership, expiry, exact target checks and provider
  generations still apply. Native selection can invalidate older bindings;
  keeping a JavaScript object does not keep a binding valid.
- Every method calls the existing nested tool bridge with the original tool
  name. Authorization, routing, cancellation, concurrency and actual nested
  Trace observations remain identical to `tools.<name>(args)` and standalone
  tool calls. No additional execution engine or execution-state store exists.
- Only declared methods are installed. Missing providers fail explicitly;
  unsupported methods are absent. There is no fallback or automatic replay.
- Cursor-only operations or other forms that do not fit a bound reference can
  still use `tools.*` with the exact schema. Standalone tools remain compatible
  entry points to the same capability implementation.
- Nested return values stay inside the program unless selected using existing
  output helpers (subject to existing media/tool-result behavior). Actual nested
  observations are recorded independently of what the model chooses to print.
