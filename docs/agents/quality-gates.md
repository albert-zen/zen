# Quality Gates

This repo has a minimal TypeScript implementation scaffold. Keep concrete commands current as tooling changes.

Engineering and commit standards are defined in `docs/agents/engineering-standards.md`.

Worker/reviewer note and state-transition discipline is part of the quality gate for automated work.

## Commands

| Gate             | Command                                                          | Required? | Notes                                                                                         |
| ---------------- | ---------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| Format           | `npm run format:check`                                           | yes       | Prettier checks source, tests, configs, Web, acceptance, and E2E code.                        |
| Lint             | `npm run lint`                                                   | yes       | ESLint flat config with TypeScript-aware production/Web rules and React Hooks rules.          |
| Typecheck        | `npm run typecheck && npm run typecheck:web`                     | yes       | Core and Web TypeScript checks.                                                               |
| Unit/integration | `npm test`                                                       | yes       | Serialized Vitest suite for deterministic Windows execution.                                  |
| Builds           | `npm run build && npm run build:acceptance && npm run web:build` | yes       | Production, acceptance, and Web builds.                                                       |
| Coverage         | `npm run coverage`                                               | yes       | Each kernel/product/presentation group needs 85% statements/functions/lines and 80% branches. |
| E2E/browser      | `npm run e2e`                                                    | yes       | Playwright Chromium real-proxy workflow. Run `npx playwright install chromium` once first.    |
| Release gate     | `npm run check`                                                  | yes       | Fail-fast sequence of every gate above.                                                       |
| Commit message   | Manual review                                                    | yes       | Must follow `docs/agents/engineering-standards.md`.                                           |
| Worker note      | Local append-only evidence document                              | yes       | Required before `Agent Review`.                                                               |
| Review note      | Local append-only evidence document                              | yes       | Required before `Integrated`, `Rework`, `Needs Human Context`, or `Blocked`.                  |

## Evidence

Implementation evidence must include:

- Commands run and results.
- Explanation for any skipped gate.
- Summary of behavior delivered.
- Changed files/modules.
- Tests added or updated.
- Commit message format when a commit is produced.
- Latest `## Codex Worker Note` or `## Codex Review Note` when automation ran.
- Branch or PR reference.
- Spec gaps or open questions.

## Skip Policy

A gate may be skipped only when:

- The command does not exist yet.
- The gate is irrelevant to the touched area.
- The user explicitly accepts the risk.

Skipped gates must be listed in the evidence package.

## Review Readiness

An issue must stay out of `Agent Review` unless:

- the worker scope is complete or explicitly blocked,
- validation evidence exists,
- the latest worker note includes branch/PR reference and acceptance criteria status,
- required checks are passing, or the current local-branch/local-review mode explicitly records why GitHub PR/check handoff is not used yet.
