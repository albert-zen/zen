# Compact quote reference evidence

Synthetic data only. No private messages, user screenshots, live Provider calls or Host calls.

- Source head: 373c3de04b3147a0bdf33e0fe2a03c6ce3b98418
- CI merge checkout: 1f27a5a859a03d7ca364e5ff4a337b4dd49a33db
- CI run: https://github.com/albert-zen/zen/actions/runs/39397166530
- Artifact ID: 12251804388
- Artifact ZIP SHA-256: e1556e54cd5da3430c5114ec490101075c65622ceb7b050453c807715cb2e755
- Self-contained HTML SHA-256: 15e715aec68ea461679bf48825d123f0bdc179c3caf9c4f3d88686c31f7086f9

## Input capability boundary

Desktop-labeled images use the existing Linux CI Chrome with the opt-in documented Chromium Blink settings for fine pointer and hover capabilities. Every scene asserts pointer:fine, hover:hover, any-pointer:fine and any-hover:hover true, and pointer:coarse/hover:none false. This is desktop-input capability emulation, not native desktop hardware verification. Draft and sent pill heights are exactly 28 CSS pixels with a 999px radius in all three desktop scenes (light/dark 1280×1000 and light 420×900).

Touch-labeled images use a separate Chrome process without desktop flags, with CDP touch emulation enabled. The same media-query assertions verify coarse/no-hover instead. Their 48px pills retain 44px controls. These images are only touch-capability sizing evidence; physical touch selection remains unverified. Earlier 48px no-hover fallback screenshots are not current desktop acceptance evidence.

## Interaction and inspection

Production Sidebar and ThreadView/InputMessage components render the synthetic fixture. A real DOM Range selects the excerpt; CDP mouse press/release clicks Quote, CDP types in the existing Composer and explicitly sends with Enter. The native canonical projection then renders the actual sent user message. The fixture emits valid start/user/explicitly labeled synthetic assistant acknowledgment/completed items. No model response is fabricated as real.

Capture assertions cover no automatic send, exact excerpt retention, accepted draft clearing, no sent remove control, no horizontal page overflow, bounded pill height and radius, no short-text disclosure, canonical lifecycle sequence, and absence of a misleading interruption warning. All 16 artifact screenshots were visually inspected for Chinese glyphs, reference text fit, toolbar placement, draft/sent consistency and narrow header layout. Nine representative full-context images are retained here. Screenshot success does not imply all repository CI passed or user design approval.

Reproduce from repository root:

```sh
node apps/zenx/scripts/build-quote-preview.mjs /tmp/zenx-quote-preview
node apps/zenx/scripts/capture-quote-preview.mjs /tmp/zenx-quote-preview
```
