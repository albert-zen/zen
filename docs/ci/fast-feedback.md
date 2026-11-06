# Early feedback, not acceptance

`fast-feedback.yml` runs independently on every PR and main push, without path
filters or dependencies on the full CI jobs. It checks the exact PR head (or push
SHA), whereas the existing CI retains its existing checkout/merge behavior.

The lane runs the SDK declaration build, Core/CLI typecheck, ZenX main/renderer
typecheck and repository Prettier check. Dependency lifecycle scripts are disabled:
static checking needs no Electron download, native PTY preparation, browser, fonts,
private Python dependency, app bundle or synthetic capture. SDK declarations are
built explicitly. Typecheck and format results remain independent after dependency
preparation, so a Core error does not hide ZenX or formatting errors.

This is intentionally incomplete feedback: Python, mobile typechecks, unit tests,
production builds, integration, native platforms and UI evidence still belong to
existing full CI. No existing workflow, test selection or branch protection is
changed. A green fast lane is not permission to merge.

## Shadow impact report

The artifact records event-pinned base/head SHAs, the actual checkout SHA, every
changed path and candidate broad lanes. It uses a local Git endpoint diff, not the
GitHub changed-file API, so there is no 300-file truncation. Endpoint comparison
can over-report changes relative to a PR merge-base diff, which is acceptable for
this conservative report. Rename detection is disabled so both old and new paths
participate; deleted paths and filenames with whitespace/newlines are retained.

Only renderer source, mobile source and documentation have broad candidate labels.
These are not proven dependency closures and do not select tests. Shared files,
Core, configuration, dependency manifests, test/harness changes and all unknown
paths fall back to `full`. An empty range, missing base (including a zero push
base), invalid SHA, failed Git read or oversized diff also falls back to `full`.
Diff errors never publish a partial path list as a selective recommendation.

No workflow consumes this report as an output, condition or matrix. Full acceptance
is always required. Further selection requires separate dependency/coverage evidence
and review; this change provides no authorization for that future change.

## Reproduce

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test scripts/test/ci-impact-shadow.test.mjs
npm run build --workspace @zenx/plugin-sdk
npm run typecheck
npm --workspace apps/zenx run typecheck:prepared
npx --no-install prettier --check .
CI_BASE_SHA=<40-character-sha> CI_HEAD_SHA=<40-character-sha> \
  node scripts/ci-impact-shadow.mjs /tmp/impact-shadow.json
```

Measure hosted dependency-install and check durations before making a wall-clock
speed claim. The ten-minute timeout is a failure bound, not an acceptance SLA.
