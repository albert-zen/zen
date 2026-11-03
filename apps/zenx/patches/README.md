# LegendList web-only patch

The patch starts with the **react.mjs section only** of
[pingdotgg/t3code's @legendapp/list 3.3.5 patch at cefb544af3c98224874419198c0359b652ca3c94](https://github.com/pingdotgg/t3code/blob/cefb544af3c98224874419198c0359b652ca3c94/patches/@legendapp__list@3.3.5.patch).
The upstream baseline is retained, with the narrow Zen selection guard described below.
It is not T3's mobile/CJS/type patch or the entire T3 timeline implementation.

- npm package integrity remains pinned by package-lock.json.
- Original react.mjs git blob: 95465f2ab89ce41a10553f58af83618f7310e83c.
- T3-only react.mjs git blob: 252a9d5b23e271c089d30c357a78dff754f1c899.
- Final T3-plus-Zen react.mjs git blob: 306a3f71b9b19ae6047f88f0f743ae5d5677c559.
- `prepare-legend-list.mjs` verifies both exact blobs and applies once, using Git
  already required for working in this repository. It refuses symlinked or
  external dependencies rather than changing a shared node_modules tree.
- The existing workspace postinstall runs it during npm ci. If lifecycle scripts
  were disabled, run `npm run prepare:legend-list --workspace @zen/zenx` before
  dev/build. No dependency was added for patch application.

The patch updates offscreen pin positions, bounds synchronous measurement chains,
uses offset measurements, and keeps DOM order with state-preserving moveBefore
when supported. Neither moveBefore nor fallback insertBefore preserves live DOM Range boundaries.
The Zen-only useDOMOrder guard therefore defers DOM sorting while a noncollapsed
Selection range intersects the container, including cross-boundary selections.
It does not reconstruct, restore or change the Selection. Once selectionchange
releases that range, it rechecks current indices and the upstream 150 ms scroll
settle condition before sorting. Layout replacement and unmount remove the listener
and pending timer. External selections and collapsed carets do not block sorting.
The adapter still owns row pinning, Find and navigation. Native acceptance is
required; deterministic hook tests do not prove the macOS failure had one cause.

Both upstream MIT notices are retained alongside the copied patch:
[LegendList license](https://github.com/LegendApp/legend-list/blob/d5a9dab3b93003c0848dda5ad78e6df1ebb59a35/LICENSE),
[T3 license](https://github.com/pingdotgg/t3code/blob/cefb544af3c98224874419198c0359b652ca3c94/LICENSE).

## Narrow whitespace-check exception

The patch contains lines with a single ASCII space. Each is the mandatory
unified-diff context prefix for a blank source line. A commit-range `git diff --check` reports them as trailing whitespace
in the patch artifact. They are preserved so Git can apply the reviewed patch;
they are not whitespace added to the resulting JavaScript.

The non-vendor source check excludes only this patch artifact:
`git diff --check BASE HEAD -- . ':(exclude)apps/zenx/patches/legend-list-3.3.5-react.patch'`.
The full commit diff is not claimed whitespace-clean. An earlier worktree-only
check did not inspect committed contents and was insufficient for that claim.
