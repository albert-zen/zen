# Engineering Standards

This document records repo-local engineering standards for Zen agent work. PRDs, issue DAGs, worker assignments, reviews, and implementation evidence should reference this file instead of restating these rules.

Linear mirror: https://linear.app/alberts-house/document/engineering-standards-98d057144340

## Commit Messages

Use concise imperative commit messages:

```text
<type>: <imperative summary>
```

Examples:

```text
docs: add item-first kernel PRD
test: cover item list append ordering
feat: add in-memory item list
fix: preserve item sequence during observer failure
refactor: isolate model event conversion
```

Allowed types:

- `feat`: user-visible or public-interface behavior.
- `fix`: behavior correction.
- `test`: tests or test utilities.
- `refactor`: behavior-preserving code restructuring.
- `docs`: documentation and planning artifacts.
- `chore`: repository maintenance.
- `build`: package, dependency, or build tooling.
- `ci`: CI configuration.

Rules:

- Keep the subject under 72 characters when practical.
- Use imperative mood: `add`, `fix`, `preserve`, not `added` or `fixes`.
- Prefer one coherent change per commit.
- Mention Linear issue IDs in the body when a commit completes or materially advances an issue.
- Add a body when the why is not obvious, when there is a tradeoff, or when tests/evidence matter.

Recommended body shape:

```text
Why:
- Short context for the decision.

What:
- Concrete behavior or artifact changed.

Evidence:
- npm test
- npm run typecheck

Refs: ALB-72
```

## Deep Module Standard

Zen should prefer deep modules: small interfaces that hide meaningful behavior and concentrate knowledge.

Use these terms consistently:

- **Module**: anything with an interface and implementation.
- **Interface**: everything a caller must know to use the module, including invariants, ordering, config, and error modes.
- **Seam**: the place where behavior can be altered without editing callers in place.
- **Adapter**: a concrete implementation behind a seam.
- **Depth**: how much useful behavior sits behind a small interface.
- **Locality**: how concentrated change, bugs, and knowledge are.

Standards:

- Prefer a small public interface with clear invariants over many shallow helpers.
- A module earns its existence when deleting it would force complexity to reappear across multiple callers.
- Do not introduce a seam for one hypothetical adapter unless it protects a clear future replacement boundary already named in the architecture.
- Keep product adapters outside the kernel. The kernel owns item append semantics, context compilation, model/tool interfaces, hooks, and observers.
- Avoid parallel state systems inside the kernel. `ItemList` remains the source of truth.

Deletion test:

```text
If this module disappeared, would complexity vanish or spread?
```

If complexity only vanishes, the module is likely shallow. If complexity spreads across callers, the module is probably earning its keep.

## Comment Standard

Comments should explain why a non-obvious decision exists, not narrate what the code already says.

Write comments for:

- Invariants that callers or maintainers must preserve.
- Non-obvious ordering, lifecycle, or concurrency constraints.
- Provider quirks or compatibility behavior that would be surprising later.
- Security, persistence, or traceability tradeoffs.
- Intentional deviations from the obvious implementation.

Avoid comments that:

- Restate the function or variable name.
- Describe every line of straightforward code.
- Explain stale historical context that is no longer useful.
- Hide unclear code instead of simplifying the interface.

Good:

```ts
// Completed items are authoritative; deltas are progress facts only.
```

Bad:

```ts
// Loop over items and push matching items to result.
```

## Clean Code Standard

Clean code in this repo means code whose behavior is easy to verify through public interfaces and whose architecture preserves the item-first model.

Standards:

- Prefer behavior tests over implementation tests.
- Keep each implementation issue as a vertical slice with observable acceptance criteria.
- Name concepts using project domain language: `Item`, `ItemList`, `ContextCompiler`, `ModelGateway`, `ToolRuntime`, `HookRuntime`.
- Keep functions short enough to understand, but do not extract pass-through helpers that reduce locality.
- Keep error modes explicit and testable.
- Keep provider, tool, persistence, sandbox, and UI adapters replaceable.
- Avoid hidden mutation. If meaningful behavior changes, represent it as an item or an explicit returned decision that becomes an item.
- Do not add abstractions only to look tidy. Add them when they deepen a module, isolate a real seam, or remove meaningful duplication.

## TDD Standard

Use red-green-refactor for implementation issues:

1. Write one behavior test through a public interface.
2. Implement the smallest behavior that passes.
3. Repeat for the next behavior.
4. Refactor only while tests are green.

Tests should assert public behavior, not private structure. For Zen, the most important public evidence is usually the item sequence, compiled context, or fake-run result.

## Review Standard

A review should check both axes:

- **Spec Review**: Does the work satisfy the PRD, issue brief, acceptance criteria, dependencies, and out-of-scope boundaries?
- **Standards Review**: Does the work preserve deep modules, clean public interfaces, item-first state, explicit hooks, and testable behavior?

Blocking review findings should cite the violated standard and the concrete consequence.
