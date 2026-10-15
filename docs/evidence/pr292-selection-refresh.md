# Subagent creation selection integration

Refs #292 and #273. Integrates the reviewed configured-create implementation on
main `078b61f57a6482c0f670a0102657a9cbfada21cc`, preserving subsequent native
lifecycle, message-source and exact-message fork behavior.

The model tool accepts optional exact catalog `model` and supported `effort` for
fresh, fork and side-chat creation. Native creation validates before publication;
settings are canonical before any optional first task. Copied historical Turn
settings remain unchanged. Older Hosts reject configured creation rather than
silently ignoring overrides.

The Subagents panel adds a compact model-settings action. Inherited creation
remains one click. Model changes reset a stale effort; unavailable selections
block creation, and errors preserve the user's choice for a deliberate retry.
Parent navigation resets the form. The workspace launcher plus keeps its existing
inherited creation behavior. Neither UI path starts a task.

## Local validation

- Core build and Core TypeScript passed.
- 101 compiled Core protocol, provider registry, configured-child, fork,
  side-chat and session-import tests passed.
- 72 renderer/capability/model/import/viewport regression tests passed; the two
  packaging tests initially failed because plugin artifacts were not built.
- After preparing all first-party plugin artifacts with a writable npm cache,
  both packaging/profile tests passed (2/2).
- Final creation interaction tests passed 16/16, including exact opaque model
  keys, effort-only inheritance, text-only model switch, catalog changes,
  unavailable choices, failure/retry, rapid clicks and stale navigation.
- Node/Web TypeScript, modified-file formatting and the real-component visual
  fixture's browser ESM bundle passed.

The real-component fixture is `apps/zenx/test/fixtures/subagent-creation-visual.html`.
All models, conversations and receipts there are synthetic; it makes no model
calls. Actual screenshots, independent final integration review and exact-head
hosted CI remain separate merge gates. This does not claim native-platform GUI
validation or an aggregate full-suite pass.

## Final R3 bounded correction

The third independent review found one UI recovery defect: an effort-only
choice could become impossible to clear after its inherited model lost all
reasoning choices. The effort selector now stays enabled while a nonempty
choice exists, retaining the user's explicit override until they clear it.
Creation remains blocked until the choice is valid or explicitly reset.

The reviewer's exact regression failed before the one-line correction and
passed afterward. Final UI plus capability tests passed 31/31 (17 UI, 14
capability). This is a bounded correction after R3, not a fourth review round.
