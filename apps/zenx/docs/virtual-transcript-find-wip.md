# Virtual transcript Find WIP

This renderer-only experiment is **default off**. Enable both tab-local sessionStorage keys before mounting a Thread:

- `zenx.experimental.virtualTranscript` = `1`
- `zenx.experimental.virtualTranscriptFind` = `1`

Cmd/Ctrl+F opens the scoped in-app Find bar; Enter/F3/Cmd/Ctrl+G move forward, Shift moves backward, and Escape in the bar closes it. Existing editors and already-handled shortcuts retain priority. Closing restores the opening control only while the bar still owns focus. Results never replace the user's Selection or focus a historical result.

Like T3's pinned `cefb544af3c98224874419198c0359b652ca3c94` web Find, matches come from data before the bounded viewport materializes a row, opens existing disclosures, resolves a connected DOM Range and paints CSS Highlight. The MIT license was verified at that exact source; the existing notice is `apps/zenx/patches/LICENSE.t3code`. Relevant source files are `ThreadFindProvider.tsx`, `useThreadFind.ts`, `useThreadFindNavigation.ts`, and `threadFindHighlights.ts` under T3's `apps/web/src/components/chat/`. ZenX does not copy T3's server search, paging, stores or backend authority.

The index covers exact standard Host welcome/summary/original-detail text, known Trigger bubble body projections, message Markdown text, validated visible reference labels, public reasoning bodies, command input and unstructured plain tool output across **all loaded turns**, even when unmounted. It includes visible referenced Markdown footnote bodies in rendered reference order, excluding unreferenced definitions and generated footnote controls. It uses CommonMark/GFM text blocks, not raw Markdown markup, link destinations or arbitrary JSON fields. Structured tool output (including the currently visible structured fallback), opaque custom plugin output, image metadata and unrelated UI/status text are not indexed in this WIP. Host originals open only their existing details disclosure; visible inputs and final responses do not expand unrelated Turn history. A result that cannot resolve a connected exact range reports failure instead of claiming it was revealed.

The closed bar performs no history text reads or parsing. Once open, immutable Turn and Item identities retain parsed text, including unchanged items inside a changing streaming Turn. A 5000-turn contract verifies parse counts of 5000 for cold Find, still 5000 for a new array of unchanged turns, 5001 after a new Send item, 5002 after a new answer, and 5003 after its changed streamed item. Query matching still scans indexed text while Find is open.

Pending work must not be described as completed acceptance:

- This is equivalent in-app Find for the stated text scope, **not transparent browser-native Find over unmounted DOM**. Browser-native Select All also cannot include unmounted history.
- Actual component tests use real npm Legend web runtime with deterministic JSDOM geometry. They are not native layout, complete selection/focus acceptance, or Send performance measurements.
- The Find UI needs screenshots and interrupted-flow checks from the exact final packaged app source. Earlier virtual-only native fixture screenshots and measurements do not certify this feature.
- Default-on rollout and merging are blocked on complete product coverage and native acceptance, including the remaining unsupported content categories.

The remaining tool-content boundary is explicit: a pure shared renderer-selection/text contract can make the known fallback searchable exactly as displayed. Opaque plugin surfaces need a trusted declared searchable-text/field mapping; they must not be serialized as arbitrary JSON or mounted offscreen to simulate whole-thread search.
