# LegendList web-only T3 patch

The patch is the **unchanged react.mjs section only** of
[pingdotgg/t3code's @legendapp/list 3.3.5 patch at cefb544af3c98224874419198c0359b652ca3c94](https://github.com/pingdotgg/t3code/blob/cefb544af3c98224874419198c0359b652ca3c94/patches/@legendapp__list@3.3.5.patch).
It is not T3's mobile/CJS/type patch or the entire T3 timeline implementation.

- npm package integrity remains pinned by package-lock.json.
- Original react.mjs git blob: 95465f2ab89ce41a10553f58af83618f7310e83c.
- Patched react.mjs git blob: 252a9d5b23e271c089d30c357a78dff754f1c899.
- `prepare-legend-list.mjs` verifies both exact blobs and applies once, using Git
  already required for working in this repository. It refuses symlinked or
  external dependencies rather than changing a shared node_modules tree.
- The existing workspace postinstall runs it during npm ci. If lifecycle scripts
  were disabled, run `npm run prepare:legend-list --workspace @zen/zenx` before
  dev/build. No dependency was added for patch application.

The patch updates offscreen pin positions, bounds synchronous measurement chains,
uses offset measurements, and keeps DOM order with state-preserving moveBefore
when supported. Fallback insertBefore still cannot promise the same state retention
in unsupported browsers. App-level find, selection, targeting and restoration
contracts remain the adapter's responsibility and still require native acceptance.

Both upstream MIT notices are retained alongside the copied patch:
[LegendList license](https://github.com/LegendApp/legend-list/blob/d5a9dab3b93003c0848dda5ad78e6df1ebb59a35/LICENSE),
[T3 license](https://github.com/pingdotgg/t3code/blob/cefb544af3c98224874419198c0359b652ca3c94/LICENSE).
