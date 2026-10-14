# Message-level Fork visual evidence

These captures use the production ThreadView component with synthetic conversation data from `test/fixtures/message-fork-visual.tsx`. No real user conversations, account data, or credentials are included.

- `fork-keyboard-desktop.png`: Fork directly follows Copy, with visible keyboard focus.
- `fork-narrow-error.png`: 390 × 600 content viewport with a visible Chinese Fork error; text is not horizontally clipped.
- `fork-prefix-opened.png`: keyboard activation opens the synthetic prefix, excluding the later reply.

The screenshots record the reviewed message-Fork implementation before the mechanical integration with main 34caadf. They demonstrate presentation and synthetic navigation, not native Electron behavior, physical touch, or actual backend execution. Core/native tests establish the inclusive canonical prefix, unchanged original Thread, and no inherited tool replay or automatic Turn. After integration, 13 Core/native Fork tests and 128 UI/App/ThreadView tests passed. The dependency-overlay typecheck/full-suite limitations are disclosed in the pull request; clean-install CI is required before merge.
