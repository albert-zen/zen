# ZenX theme v0

[`ui-ux.md`](./ui-ux.md) remains the durable product authority. This file only
documents the current renderer implementation and migration boundary.

## Theme entry

ZenX keeps the existing renderer-local `system | light | dark` preference in
`appearance.ts`. `index.html` resolves the saved choice before the renderer
module loads, and System follows `prefers-color-scheme` changes live. Appearance
is not Core, Thread, Project, or journal state. There is no second theme provider,
theme preview page, import/export flow, or custom theme editor in v0.

## Color tokens

`src/renderer/src/theme.css` is the only production source of raw colors. Its
canonical roles cover:

- canvas and surfaces: `--color-canvas`, `--color-surface-*`;
- text: `--color-text-primary`, `secondary`, `muted`, and state variants;
- boundaries and focus: `--color-border-*`, `--color-focus-ring`;
- accent and status: `--color-accent*`, `--color-status-*`;
- overlay and shadow colors: `--color-overlay*`, `--color-shadow*`.

Migrated components use canonical roles. Short existing names such as
`--surface-2`, `--text-3`, and `--good` remain compatibility aliases so the rest
of the renderer can migrate by component family. The aliases are semantic
bridges, not a raw color scale; do not add new consumers when touching a migrated
component. `--surface-raised`, `--text-1`, and `--text-secondary` are defined in
that bridge to close earlier dangling references.

Geometry stays local in v0. Font stacks, spacing, radius, and shadow geometry are
not a new token system; they remain inventory for later component-led work.

## Migrated slice

- window canvas, app shell, titlebar, Sidebar root and its primary controls;
- thread workspace/header, selected Thread row, message canvas, user bubble,
  and agent copy;
- Composer surface, input, model trigger, primary orb, and bottom fade;
- global focus, shared icon/primary/secondary controls, and shared form fields;
- service status dots and the enabled-switch knob that previously used raw color.

Status and selection retain text, icons, native checked/current semantics, or an
accessible name; color is not their only signal. macOS and Windows keep their
existing titlebar selectors while consuming the same shell surface roles.

## Boundaries and guard

Provider and ZenX brand files are assets, not theme colors. Isolated plugin iframe
documents and test fixtures are separate documents/boundaries. The static theme
test scans production renderer CSS/TSX, excluding the asset directory, and checks:

1. raw hex/rgb/hsl values occur only in `theme.css`;
2. every consumed product custom property is defined or is the documented
   component-owned `--zenx-brand-asset` seam;
3. the migrated v0 selector groups consume canonical roles.

## Inventory and follow-up

Baseline `6a812525` had 106 raw renderer color matches: 102 palette declarations
in `styles.css` plus four product leaks. It also had 54 statically defined and 57
consumed custom properties, including the three dangling references above.

Remaining work is intentionally grouped rather than mechanically replaced:

- **later:** settings/provider/plugin/room colors still using compatibility
  aliases; 105 radius declarations across 19 shapes; local spacing, type sizes,
  three monospace stacks, and shadow geometry;
- **boundary:** future syntax-highlighter/editor/terminal palettes and isolated
  plugin iframe content;
- **asset:** Provider SVG/PNG/ICO, ZenX brand masks, prototypes, and fixtures.

Reproduce the color inventory with:

```sh
rg -n --glob '*.{css,tsx,ts,html}' \
  '(#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\()' \
  apps/zenx/src/renderer
```
