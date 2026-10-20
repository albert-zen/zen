# Quote reference visual evidence

Synthetic data only. No private messages, user screenshots, live Provider calls, or Host calls.

- Source head: d6576def2c9ee2dd6f4709f5a456c1f21746d36b
- CI merge checkout: eddfde5f2821bb0d8f74f8fb049188132fec4ab5
- CI run: https://github.com/albert-zen/zen/actions/runs/39395597096
- Artifact ID: 12251752206
- Artifact ZIP SHA-256: 6aac577bb6f3ea94200cf19c2c1c233853301523e3c34caefca1e577c4cf0770
- Self-contained HTML SHA-256: 09902a136a2200d6787ef3d8b0cfa5f2ac628c80fc262dfce3c23017b565a265

The existing Ubuntu CI runner's Chrome rendered the actual production Sidebar and ThreadView/InputMessage components. The synthetic send loop uses existing Composer submission identity and native canonical message projection; it appends an explicitly labeled local preview acknowledgment, not a model-generated reply. Official Ubuntu fonts-noto-cjk supplies Chinese glyphs.

The three scenes are light 1280×1000, dark 1280×1000 and light 420×900. The capture script selects an actual DOM Range, clicks Quote, inserts the ordinary question, explicitly sends with Enter, and verifies the resulting canonical user message. It asserts no automatic send, exact excerpt retention, draft clearing, no sent remove control, no horizontal page overflow, 999px closed radius and height ≤48px. Short text has no disclosure. It also asserts the synthetic canonical start/user/agent/completed sequence and absence of a misleading interrupted-turn warning.

All twelve source artifact screenshots were visually inspected for Chinese glyphs, selection-toolbar placement, compact draft/sent reference shape, header fit and visible synthetic-data labels. These seven images preserve the representative flow and theme/width variants at full viewport size. The artifact also contains the initial-sent states, measurements and self-contained HTML. Capture success is not a claim that all repository CI checks passed or that the user approved the design. Native desktop clipboard permission and real touch selection remain separate manual acceptance items.

Reproduce from repository root:

```sh
node apps/zenx/scripts/build-quote-preview.mjs /tmp/zenx-quote-preview
node apps/zenx/scripts/capture-quote-preview.mjs /tmp/zenx-quote-preview
```
