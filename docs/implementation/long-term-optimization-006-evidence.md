# Long-Term Optimization 006 Evidence

## Codex Worker Note

Round: 1
Issue: long-term-optimization-006 Enforce deep module groups and explicit entrypoints
Local tracker state transition: Ready -> In Progress -> Agent Review
Branch: `codex/long-term-optimization-006`
PR URL: not configured
Base revision/diff scope: `00a87a5fa1a6ac1751e459b046455785647b2e79`; mechanical module boundaries, entrypoints, package/build surfaces, acceptance relocation, docs, and characterization tests only.
Summary of behavior delivered: Reorganized the single package into kernel, product, Node adapter, presentation, and TUI groups with explicit package subpath entrypoints. Split the ThreadJournal port from the filesystem journal adapter and relocated the dogfood harness outside production source.
Final scope summary: Completed issue 006 only. No product behavior, lint/coverage, Playwright, or issue 007 quality-gate work was added.
Changed files/modules: `src/kernel/`; `src/product/`; `src/adapters/node/`; `src/presentation/`; `src/tui/`; `acceptance/dogfood-acceptance.ts`; `package.json`; TypeScript/Vite/Vitest configuration; architecture and ALB-94 harness docs; affected tests plus `test/module-boundaries.test.ts`.
Tests added/updated: Compiler-AST dependency-direction/package export/Web alias/acceptance exclusion coverage; root entrypoint characterization; affected behavior tests redirected through group entrypoints or test-only composed support.
Acceptance criteria status: Root entrypoint exports kernel only: pass. Explicit product/node/presentation/TUI entrypoints and package exports: pass. Kernel outward imports prohibited by AST test: pass. Web aliases replace arbitrary `../../src` production imports: pass. Acceptance implementation and production declarations separated: pass. Existing behavior, boundary, typecheck, and build feedback: pass.
Commands run and results: `npx vitest run test/module-boundaries.test.ts test/kernel-entrypoint.test.ts` passed (2 files/4 tests). `npm test` passed (33 files/221 tests). `npm run typecheck` passed. `npm run typecheck:web` passed. `npm run build` passed. `npm run build:acceptance` passed. `npm run web:build` passed. `git diff --check` passed. Package self-import of `.`, `./product`, `./node`, `./presentation`, and `./tui` passed; production `dist` contained no dogfood declarations or artifacts.
Validation log paths: none
Required check status or local-check handoff reason: Current required issue-006 checks pass. Issue-007 `npm run check`, lint, coverage, and Playwright are explicitly out of scope.
Evidence links/paths: `docs/architecture.md`; `test/module-boundaries.test.ts`; `tsconfig.acceptance.json`; `docs/implementation/alb-94-dogfood-acceptance.mjs`.
Decisions made: Node provider composition remains at the executable TUI edge; all shared production cross-group imports use explicit group indexes. The test-only aggregation exists only to keep legacy characterization coverage composed without reopening the package root.
Standards notes: The kernel remains item-first and provider/persistence/UI neutral; the product owns the journal port while the Node adapter owns filesystem details.
Reviewer notes: Ready for fresh-context strict review; no self-review performed.
Open questions: none
Known residual risks: The provider-backed dogfood command was stopped after it entered a non-deterministic external model scenario. Its build/import surface passed; live provider behavior remains environment-dependent.
Blocker or context escalation details: none

## Codex Review Note

Round: 2
Issue: long-term-optimization-006 Enforce deep module groups and explicit entrypoints
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-006 @ b0e01fecf0a6e4ed3f768fb65d22ae6c4a44c530`
Base revision/diff scope: `00a87a5fa1a6ac1751e459b046455785647b2e79..b0e01fecf0a6e4ed3f768fb65d22ae6c4a44c530`
Standards Review blocking: none
Standards Review non-blocking: none
Standards Review missing evidence: none
Spec Review blocking: none
Spec Review non-blocking: none
Spec Review missing evidence: none
Local tracker state decision: Complete
State decision reason: STRICT PASS. No blocking, no material non-blocking, and no missing architecture evidence. The unrelated TUI timing flake is deferred to 007; isolated acceptance output is accepted because production declarations are clean.

## Codex Review Note

Round: 1
Issue: long-term-optimization-006 Enforce deep module groups and explicit entrypoints
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-006 @ fb8d94a888b077a14374672182c2a2c6de4bd012`
Base revision/diff scope: `00a87a5fa1a6ac1751e459b046455785647b2e79..fb8d94a888b077a14374672182c2a2c6de4bd012`
Standards Review blocking: `web/vite.config.ts` directly imports the physical `../src/adapters/node/index.js` path, so the Web boundary is not represented by a package-internal explicit Node entrypoint.
Standards Review non-blocking: none
Standards Review missing evidence: The AST boundary test did not inspect `web/vite.config.ts` or prove that a direct adapter implementation import fails.
Spec Review blocking: Replace the Vite physical Node import with a clean-source package-internal explicit alias/self-reference and enforce browser/Vite alias parity.
Spec Review non-blocking: none
Spec Review missing evidence: Add a negative boundary assertion for a direct adapter implementation import.
Local tracker state decision: Rework
State decision reason: One narrowly scoped architecture-boundary correction is required.

## Codex Worker Note

Round: 2
Issue: long-term-optimization-006 Enforce deep module groups and explicit entrypoints
Local tracker state transition: Rework -> In Progress -> Agent Review
Branch: `codex/long-term-optimization-006`
PR URL: not configured
Base revision/diff scope: `fb8d94a888b077a14374672182c2a2c6de4bd012`; Vite package-internal source-entry alias only, Web alias parity tests, and corresponding configuration/evidence.
Summary of behavior delivered: Replaced Vite's direct physical Node source import with the package-internal `#zen/node` source-entry mapping. Browser code now uses only `#zen/product` and `#zen/presentation`; Vite uses only `#zen/node` for Zen group imports.
Final scope summary: Completed the manager-authorized Review Round 1 fix only. No runtime behavior, module ownership, lint/coverage, Playwright, or issue-007 work was added.
Changed files/modules: `package.json` package-internal import mappings; `web/vite.config.ts`; `web/src/demo-app-server.ts`; `web/src/workspace.tsx`; `web/tsconfig.json`; `vitest.config.ts`; `test/module-boundaries.test.ts`; this evidence document and tracker register.
Tests added/updated: AST coverage now inspects every `web/src` source plus `web/vite.config.ts`; browser aliases are restricted to `#zen/product`/`#zen/presentation`; Vite is restricted to `#zen/node`; a negative direct adapter implementation fixture is asserted to fail.
Acceptance criteria status: Physical Node import removed from Vite: pass. Clean source checkout package-internal mappings declared in `package.json` and `web/tsconfig.json`: pass. Browser source has no Node dependency: pass. Web AST parity and negative assertion: pass.
Commands run and results: `npx vitest run test/module-boundaries.test.ts` passed (1 file/4 tests). `npm run typecheck` passed. `npm run typecheck:web` passed. `npm run build` passed. `npm run web:build` passed. Package self-import smoke for all five exports passed. `git diff --check` passed. `npm test` initially had 221 passing tests and one timing-sensitive TUI failure; immediate `npx vitest run test/zen-tui-app.test.ts` rerun passed (1 file/15 tests).
Validation log paths: none
Required check status or local-check handoff reason: Full gate was run because source/package import resolution changed. The focused rerun passed after one unrelated timing-sensitive TUI assertion in the full suite.
Evidence links/paths: `package.json`; `web/vite.config.ts`; `web/tsconfig.json`; `test/module-boundaries.test.ts`.
Decisions made: `#zen/*` is the package-internal source-entry alias family. It resolves package imports from the clean source checkout and does not add browser access to Node adapters.
Standards notes: The Vite integration consumes the Node group through its explicit entrypoint only; browser code remains restricted to product/presentation interfaces.
Reviewer notes: Review Round 1 blocking finding addressed; ready for a new fresh-context review.
Open questions: none
Known residual risks: The unchanged full-suite TUI timing assertion flaked once and passed immediately when isolated; this issue does not modify TUI code.
Blocker or context escalation details: none
