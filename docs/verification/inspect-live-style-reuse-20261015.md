# Inspection-local live style reuse

## Scope

The single stopped [first-inspect diagnostic #400](https://github.com/albert-zen/zen/pull/400)
observed a successful 1591.706 ms reply with 1460.400 ms inside the inspection's
timing envelope, on an 11-node synthetic page. That elapsed wall time does not
identify a specific DOM operation, CPU cost, or the cause of earlier unknowns.
This change removes demonstrable duplicate object acquisition; it is not a claim
to fix that latency or the remaining intermittent startup failures.

`visible()` obtains computed style once per candidate. `clickable()` previously
obtained it again during filtering and action projection. The three clickable
fixture controls therefore caused nine `getComputedStyle` calls.

Keep a `WeakMap` local to this invocation of `browserInspectScript`. Each element
gets one live computed-style object. Every original property read still occurs
at its original call site; visibility and action booleans are not cached. The
map does not enter either persistent document registry or another inspection.
The [CSSOM getComputedStyle algorithm](https://drafts.csswg.org/cssom/#dom-window-getcomputedstyle)
specifies a live, read-only style object; the expression never exposes its object
identity to page code or its caller.

Rendered `innerText`, geometry, target ordering, input snapshots, shadow traversal,
native-surface rejection, isolated-world identity, action guards and CDP budgets
are unchanged. No diagnostic wrapper or workflow is included in this change.

## Verification

The actual expression is compared with the same expression with only the local
style-object reuse removed. Deterministic synthetic registries allow full result
comparison, including input evidence and target identities.

- Three visible clickable controls obtain 3 style objects instead of 9, while
  retaining 3 geometry reads, 1 rendered-text read and 6 pointer-events reads.
- Live pointer-events changes between filtering and projection are read again;
  results match the uncached expression rather than retaining old action flags.
- Each later inspection obtains fresh objects and rechecks changed visibility.
- Hidden/disabled controls, labels, passwords, select state, focused native
  surfaces and open/closed shadow focus retain equivalent results.
- Style/geometry failures propagate once without a fallback or replay.

JSDOM geometry, rendered text and live CSS objects are explicit test doubles.
These tests establish source-level equivalence and call counts, not native
latency. The ordinary exact-head CI provides headed functional coverage; it
must not be described as proof of an intermittent-performance root cause.

Local validation: 12 new tests passed; the exact `280df77f` implementation fails
the three object-acquisition assertions (9 instead of 3), with the other nine
tests passing. The complete selected browser, targeted-input, native-guard and
parallel-input contract suite passed 622 tests with one Mac-only local skip.
Full ZenX Node TypeScript, formatting and diff checks passed. Removing the reuse
increment restores the original 11526-byte expression SHA-256
`1ae368145e3e1f2650f52e283745385b9b9178e530efc9b15b27e6ef297c8c2a`.
