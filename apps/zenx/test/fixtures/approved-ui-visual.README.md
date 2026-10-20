# Approved Sidebar and context feedback capture

This fixture exercises the production `Sidebar`, `ContextUsageIndicator`, `ComposerSendControl`, theme and styles with synthetic facts. It never connects to a Host or uses user screenshots/data. No production behavior is replaced.

## Build and verify

Run `node apps/zenx/scripts/build-approved-ui-preview.mjs OUTPUT`, then `node apps/zenx/scripts/capture-approved-ui-preview.mjs OUTPUT` on a machine with existing Chrome. The helper never downloads a browser. CI installs `fonts-noto-cjk` from the official Ubuntu package repository for readable Chinese labels; no application dependency changes.

The Sidebar baseline reverses only the approved shortcut CSS patch and checks its original blob hash. The context baseline omits only the new motion stylesheet. Both variants use the same current production components. Generated HTML is self-contained and can be opened without a server; the capture helper serves only these fixtures on an ephemeral loopback port.

## Coverage

- Sidebar: 220/360 px widths at desktop viewport size, light/dark, Cmd/Ctrl platform labels, English/Chinese long titles, running+Trigger, unread+Trigger, approval+Trigger and plain rows.
- Modifier events follow the actual Sidebar keyboard path. Captures include held, hover and released states; measurements check hint separation and blur cleanup.
- Context: before/after, 900/390 px viewports, light/dark, above/below placement, hover bridge traversal, focused Escape dismissal, unchanged usage label and hit target, pressed feedback, two opacity-fade samples and reduced motion.
- `measurements.json` and `source.json` bind the screenshots to their source and measured states. Runtime exceptions fail capture.

The screenshots are real Chrome layout of production components with synthetic data, not mockup images. The platform attribute exercises platform-specific rendering; it does not claim physical macOS/Windows keyboard or native Electron window validation. Review actual screenshots before accepting the visual result. Keep the PR draft until the user approves proceeding.
