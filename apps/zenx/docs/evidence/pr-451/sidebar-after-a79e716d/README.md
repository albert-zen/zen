# PR #451: Sidebar after-state evidence

Evidence-only branch. Do not merge this branch; source work remains in draft [PR #451](https://github.com/albert-zen/zen/pull/451).

This directory publishes **only 12 Sidebar-after PNGs**: four configurations, each with modifier held, actual mouse hover, and modifier released. It does not publish before comparisons. [Context after-state evidence](../desktop-a79e716d) is separately retained.

Source head: `a79e716db977ab6e3691de3d13de6b0ad91ac972`; tree: `b5ff211095ae4f396952efd12fa157e439f9493e`. Captured GitHub PR merge ref `afb1c1c7c82f37ab1c6b43cf33bd97783c4cd137` has the same verified tree. The capture step passed in [CI run 39397338581](https://github.com/albert-zen/zen/actions/runs/39397338581); consult the source PR for overall CI status.

These are unmodified Chrome screenshots of the real production Sidebar and CSS with synthetic facts. No private user data, native user screenshots, or Host actions are involved. This is **desktop-input emulation in Linux Chrome**, not physical macOS/Windows input or native Electron validation. Platform attributes choose actual Cmd/Ctrl rendering; synthetic modifier events use the production Sidebar handler. Actual fine/hover/any-fine/any-hover media queries are true; none/coarse are false, with no media-query JavaScript or product CSS stubs.

## Inspected configurations

- Cmd, light, 220px, Chinese long titles.
- Cmd, dark, 360px, English and mixed-script long titles.
- Ctrl, dark, 220px, Chinese long titles.
- Ctrl, light, 360px, English and mixed-script long titles.

Each fixture contains running + Trigger, unread + Trigger, approval + Trigger, plain idle and mixed-script rows. Held shortcut hints occupy a separate trailing slot. Factual status paint and the actual hover More target remain left of the shortcut badge, including its padding and border box. Minimum captured hover gap is 4px for Cmd and 10.78px for Ctrl. Actual hover reveals a 28px More target rather than the always-visible 44px touch fallback. Modifier release and window blur clear hints and reserved space. Long titles truncate without crossing the hint slot; hover intentionally uses the existing title fade treatment.

All 12 published PNGs were visually inspected; independent representative inspection found no obvious badge/status clipping or overlap. Chinese labels render using fonts from Ubuntu's official package repository.

[Capture source and assertions](https://github.com/albert-zen/zen/blob/a79e716db977ab6e3691de3d13de6b0ad91ac972/apps/zenx/scripts/capture-approved-ui-preview.mjs). The production design is unchanged by capture work. This evidence is not new aesthetic approval or permission to merge.
