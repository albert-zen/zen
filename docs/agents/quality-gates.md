# Quality Gates

This repo is currently documentation-only. Add concrete commands when the first implementation scaffold is introduced.

Engineering and commit standards are defined in `docs/agents/engineering-standards.md`.

## Commands

| Gate | Command | Required? | Notes |
| --- | --- | --- | --- |
| Format | `<not configured>` | no | Required once implementation tooling exists. |
| Lint | `<not configured>` | no | Required once implementation tooling exists. |
| Typecheck | `<not configured>` | no | Required once TypeScript or another typed implementation exists. |
| Unit tests | `<not configured>` | no | Required for the first kernel implementation. |
| Integration tests | `<not configured>` | no | Required for end-to-end agent loop behavior. |
| E2E/browser | `<not configured>` | no | Not relevant until UI exists. |
| Commit message | Manual review | yes | Must follow `docs/agents/engineering-standards.md`. |

## Evidence

Implementation evidence must include:

- Commands run and results.
- Explanation for any skipped gate.
- Summary of behavior delivered.
- Changed files/modules.
- Tests added or updated.
- Commit message format when a commit is produced.
- Spec gaps or open questions.

## Skip Policy

A gate may be skipped only when:

- The command does not exist yet.
- The gate is irrelevant to the touched area.
- The user explicitly accepts the risk.

Skipped gates must be listed in the evidence package.
