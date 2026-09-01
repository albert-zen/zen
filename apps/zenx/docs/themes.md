# ZenX Appearance v1

[`ui-ux.md`](./ui-ux.md) remains the durable product authority. This file
documents the current renderer implementation and migration boundary.

## Preference and first paint

`appearance.ts` owns one renderer-local `ZenXAppearancePreference`. The
versionless JSON value stored at `zenx.appearance` contains:

- `mode`: `system | light | dark`;
- independent `lightPreset` and `darkPreset` values;
- `accent`, `contrast`, and `translucentSidebar` controls.

Legacy string values (`system`, `light`, or `dark`) migrate in memory to the v1
defaults. Invalid or unavailable storage falls back to System, Graphite for both
modes, Azure, Standard contrast, and an opaque Sidebar.

The hashed inline bootstrap in `index.html` validates and resolves the same
value before the renderer module loads. It writes `data-appearance`,
`data-theme-preset`, `data-accent`, `data-contrast`, and
`data-sidebar-translucency` on the root, along with native `color-scheme`.
System follows `prefers-color-scheme` changes live. The controller uses the same
projection after React mounts, so reload and relaunch do not flash the default
palette.

Appearance remains outside Core, Thread, Project, host restart, and canonical
ItemList state. There is no second theme provider, import/export flow, theme
marketplace, custom theme editor, or third-party editor/terminal palette.

## Built-in choices

Graphite preserves the v0 cool-neutral baseline. Cobalt intentionally shifts
the surface hierarchy toward cool blue; Ember shifts it toward warm neutral.
All three have explicit Light and Dark mappings, and the selected Light and Dark
presets persist independently.

Azure, Iris, and Jade remap accent, focus, selected boundary, and on-accent text
roles. High contrast strengthens muted text and boundaries without changing
component CSS. Translucent Sidebar remaps the shared Sidebar surface role and
adds the renderer material treatment; opaque remains the default.

The independent Settings → Appearance section exposes native radio,
checkbox/switch, and button semantics,
a compact live preview, and Reset. Every change applies immediately and persists
without an App Server restart.

## Semantic color seam

`src/renderer/src/theme.css` is the only production source of raw colors. Its
canonical roles cover:

- canvas and surfaces: `--color-canvas`, `--color-surface-*`;
- text: `--color-text-primary`, `secondary`, `muted`, and state variants;
- boundaries and focus: `--color-border-*`, `--color-focus-ring`;
- accent and status: `--color-accent*`, `--color-status-*`;
- overlay and shadow colors: `--color-overlay*`, `--color-shadow*`.

Preset, accent, contrast, and material selectors only remap these roles. The
shell, titlebar, Sidebar, main content, Composer, form controls, buttons, and live
preview consume the same semantic seam. Component code does not select palette
values or carry raw colors.

Short existing names such as `--surface-2`, `--text-3`, and `--good` remain
compatibility aliases for untouched component families. They are semantic
bridges, not a raw color scale; touched Appearance v1 selectors and components
use canonical roles. Geometry, typography, spacing, and radii remain local and
are not a second token system.

## Contrast, focus, and boundaries

Automated checks exercise every Light/Dark × preset × accent × contrast
combination. Normal text keeps at least 4.5:1 contrast on shell, Sidebar, and
content surfaces; control boundaries and focus rings keep at least 3:1; accent
text keeps at least 4.5:1. Mode, preset, accent, contrast, and material controls
retain native checked/switch state, visible labels, and `:focus-visible`; color
is not the only state signal.

Provider and ZenX brand files are assets, not theme colors. Isolated plugin
iframe documents and test fixtures remain separate documents/boundaries.

## Source policy and evidence

The static source guard scans production renderer CSS/TSX, excluding assets, and
checks:

1. raw hex/rgb/hsl values occur only in `theme.css`;
2. every consumed product custom property is defined or is the documented
   component-owned `--zenx-brand-asset` seam;
3. all live Appearance controls reach root attributes before first paint;
4. shell, Sidebar, content, preview, and controls consume canonical roles.

The v0 images under `docs/assets/theme-v0/` used production CSS in a static
harness. They are retained as historical artifacts, but they are not Electron
evidence and their different modes, platform selectors, viewport, and screen
states do not form a comparable visual matrix. Appearance v1 acceptance uses
real Electron screenshots at controlled viewport/state in its pull request.

Reproduce the raw-color inventory with:

```sh
rg -n --glob '*.{css,tsx,ts,html}' \
  '(#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\()' \
  apps/zenx/src/renderer
```
