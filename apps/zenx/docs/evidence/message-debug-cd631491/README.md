# Per-message input debugger: synthetic visual evidence

PR #498 implementation head: cd63149169eff5ce32943632d168603971a8cc06.
CI run: https://github.com/albert-zen/zen/actions/runs/40169536742
Artifact: 12589298673. Source manifest commit e8ea7107f4ca4e11db340ca7ba88db22648a60e2 is GitHub's merge-test commit.

These screenshots render the actual production Dialog, message action and styles with synthetic incoming content and a synthetic capture bridge. They are NOT a native desktop, live Host, or online-model acceptance test. All input and reference IDs are fabricated. The captured field fixture includes only one user message, not system instructions or other messages.

- English desktop/light: message-input-en-light-1100.png
- Chinese narrow/dark: message-input-zh-CN-dark-390.png

Both were visually inspected. Computed appearance, layout bounds, no horizontal overflow, read-only attributed commands, Escape and focus restoration passed. The source.json hashes match the implementation files at the PR head. See measurements.json for the actual assertion output. Provider attribution correctness is separately tested with real adapter serialization and mocked transport, not established by the fixture alone.

The PR remains a default-off experiment and must not be merged without a later explicit design decision. It is based on main98caf2f independently of #496; combined queued-media provenance testing passed29cases locally but remains a separate integration obligation.
