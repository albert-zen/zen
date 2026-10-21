# Approved Sidebar and context feedback capture

This fixture exercises the production `Sidebar`, `ContextUsageIndicator`, `ComposerSendControl`, theme and styles with synthetic facts. It never connects to a Host or uses user screenshots/data. No production behavior is replaced.

## Build and verify

Run `node apps/zenx/scripts/build-approved-ui-preview.mjs OUTPUT`, then `ZENX_PREVIEW_DESKTOP_INPUT=1 node apps/zenx/scripts/capture-approved-ui-preview.mjs OUTPUT` on a machine with existing Chrome. The helper never downloads a browser. CI installs `fonts-noto-cjk` from the official Ubuntu package repository for readable Chinese labels; no application dependency changes.

This capture explicitly opts into Chrome desktop-input emulation on Linux CI and asserts actual `(hover: hover)`, `(pointer: fine)`, `(any-hover: hover)` and `(any-pointer: fine)` media-query results before each page. The helper's default remains unchanged for other callers. The launch settings match [Playwright's Chromium launcher](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromium.ts); enum values are defined by [Chromium web preferences](https://github.com/chromium/chromium/blob/main/third_party/blink/public/mojom/webpreferences/web_preferences.mojom). No product CSS, media-query JavaScript stubs or new runtime package installs are used. Earlier headless captures without this opt-in exercise the no-hover/touch fallback and must be labeled separately. A headful Xvfb attempt timed out during Chrome startup and produced no rendered evidence.

The Sidebar before view uses the pinned primary stylesheet from `dfd427541ced50a4c076ca131d4fd8e9107336f3`, stored as `sidebar-styles-dfd42754.css.txt` and verified against exact blob `464e3f45d7b9c691ec5f930657a3f073f1fb98df`. Current shortcut seams are still checked independently; unrelated merged CSS cannot invalidate this historical fixture. Imported CSS modules and components remain current, so this is not a historical full-app build. The context baseline omits only the new motion stylesheet. Both variants use the same current production components. Generated HTML is self-contained and can be opened without a server; the capture helper serves only these fixtures on an ephemeral loopback port.

## Coverage

- Sidebar: 220/360 px widths at desktop viewport size, light/dark, Cmd/Ctrl platform labels, English/Chinese long titles, running+Trigger, unread+Trigger, approval+Trigger and plain rows.
- Modifier events follow the actual Sidebar keyboard path. Captures include held, hover and released states; measurements check hint separation and blur cleanup.
- Context: before/after, 900/390 px viewports, light/dark, above/below placement, hover bridge traversal, focused Escape dismissal, unchanged usage label and hit target, pressed feedback, two opacity-fade samples and reduced motion.
- `measurements.json` and `source.json` bind the screenshots to their source and measured states. Runtime exceptions fail capture.

The screenshots are real Chrome layout of production components with synthetic data, not mockup images. Desktop-input emulation and the platform attribute exercise browser/platform-specific rendering; they do not claim physical macOS/Windows hardware, keyboard or native Electron window validation. Review actual screenshots before accepting the visual result. Keep the PR draft until the user approves proceeding.
