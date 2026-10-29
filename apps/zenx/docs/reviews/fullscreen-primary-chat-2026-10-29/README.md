# Fullscreen primary chat — source-bound synthetic acceptance

Source: `15bc3821550f194d70ca57d61d23be192883cd07`

Tree: `ec0337fc844fbf8d7c1256f9b6fca553c080da58`

The fixture uses the actual AuxiliaryPanel, ThreadView, Composer and RoomsPage,
with all ten production stylesheets in their production order. Conversation data,
browser page pixels and mount/lease receipts are synthetic. Networking is blocked;
no Agent was called. The App title/header is deliberately excluded, with the real
RoomHeaderContext supplied a matching Room and null header slot. This is **not
native Electron, full App/header or full accessibility acceptance**. It does not
write Host/profile state; synthetic local read markers may be stored.

## Observed behavior

Root exercised the final fixture with actual browser clicks and keys on
2026-10-29. Entering fullscreen retained the selected webpage; the fixed main-chat
tab appeared first. Explicit main selection reused the Thread surface, and an
appended unsent draft survived main → webpage → main. Explicit same-ID resource
navigation returned to the webpage. Room main displayed the original Room
conversation and retained draft at full width.

At an actual **987 × 757** viewport, `document.scrollWidth` was 987. Escape from
the primary Composer restored focus to the visible retained Reference tab, with
no synthetic title overlap. Wide desktop Escape retained Composer focus in the
earlier production-identical `04b4a48f` fixture. Intermediate interaction outcomes
are operator-reported; the integrator and independent reviewer inspected all four
final captures, not a separate replay of every interaction.

| Capture                                                | Size       | State                                                          |
| ------------------------------------------------------ | ---------- | -------------------------------------------------------------- |
| [Expanded webpage](expanded-retains-webpage-light.jpg) | 1181 × 757 | Fullscreen retains the webpage; main chat is first.            |
| [Primary Thread](primary-chat-retains-draft-light.jpg) | 1181 × 757 | Existing main chat and edited draft; simulated browser hidden. |
| [Primary Room](room-primary-dark.jpg)                  | 1181 × 757 | Original Room conversation and draft, production Room styling. |
| [Narrow Escape](narrow-escape-resource-focus.jpg)      | 987 × 757  | Restored resource tab has visible keyboard focus.              |

Only final-source captures are included. Earlier diagnostic images with an
invented title or omitted Room styles are excluded. All four JPEGs have no EXIF
entries.

## Validation

- Source-focused suites: **146/146 + 272/272 + 62/62 = 480 passing cases**,
  including `.mjs` tests. Node/web types, own SDK and first-party preparation,
  brand check, production build, formatting and diff checks passed.
- Those production checks ran on `04b4a48f`; later commits changed only three
  fixture scripts. Production and test files are byte-identical. Final fixture
  build, scoped TypeScript and 15/15 targeted regressions passed.
- Independent review: 38 UI and 34 plugin cases passed; exact source equivalence,
  corrected pixels and all 25 source-receipt hashes were checked.
- An initial plugin invocation ran before package preparation completed and
  failed one packaging case (missing generated Triggers tarball): 61 passed,
  1 failed. After preparation, the unchanged complete invocation passed 62/62;
  this earlier failure is retained rather than relabeled.
- This is not a full local aggregate or native-platform result. Hosted CI and
  public-tree verification are separate publication gates.

`source.json` is the unchanged final build receipt. `validation.json` records the
scope and results. The built HTML SHA-256 is
`9b885e147fc09ceb69c4070d04b0d63f943a99470d064eecc34544f50a40d9b8`;
compiled HTML is not committed. `SHA256SUMS` binds this archive's other seven files.
