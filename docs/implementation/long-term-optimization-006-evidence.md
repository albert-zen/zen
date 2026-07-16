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
