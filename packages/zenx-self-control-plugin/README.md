# ZenX self-control

First-party self-control package distributed with ZenX and installed through the ordinary plugin profile.

Besides Project and Thread controls, the package exposes the same user-scoped
workflow configuration used by Settings. `zenx_self_control_workflows_get` reads custom
Slash commands and the title prompt; `zenx_self_control_workflows_update` replaces them with
revision conflict protection. The built-in `/compact` name is reserved.

Thread tools accept `target`: full ID, unique prefix or exact title. Use `workspace`
to disambiguate; ambiguous targets return candidates and never write. Discover
Threads with `zenx_threads_list` (query, workspace, archived, limit and cursor).

For normal communication, send target/text and omit messageType. The default is
`guidance`: soft-steer active work at the next safe point, or start when idle.
Use explicit `follow_up` only when work should wait until the current Turn ends;
`replacement` interrupts and changes the task. The manual Composer preference
never changes Thread-message delivery. Explicit per-message intent is preserved.
The application owns IDs, retry deduplication and exact-Turn checks.

Read original history with `zenx_threads_read`: turns (default), items,
agent_messages, or item. Item/message pages optionally take turnId. Follow nextCursor
for older pages with unchanged filters. Each excerpt has a read request; item reads
return public Item JSON (`public_item_json`) in chunks, with offset, totalLength and nextCursor.
All previews and continuations recursively expose only identity fields and public
summary for structured opaque values. Public reasoning and original tool output
strings are preserved; canonical journals and trusted native reads/recovery remain complete.
Concatenate content and parse when complete. Cursors freeze the Item boundary and
no automatic summary replaces the original text. Completion notifications belong
to Triggers, not a self-control wait API.

Use zenx_models_list for model IDs and reasoning efforts; choose them on creation
or with zenx_threads_configure. Creation accepts a configured project name/path or
cwd. Project names and paths are discoverable via zenx_projects_list.

For a compaction locator `zen-thread://THREAD/items?through=ITEM`, URL-decode its Thread and cutoff IDs and call `zenx_threads_read` with `threadId`, `throughItemId`, and optional `granularity: "items"` / `cursor`. Read an Item completely with `granularity: "item"`, `itemId` and the same cutoff; concatenate its `public_item_json` chunks using `nextCursor`. Every cursor stays bound to that reference. Missing/disabled references fail explicitly. This is a public view of the original journal, not a filesystem path; opaque provider payloads are not exposed.

## Thread / Room sidebar

`zenx_self_control_sidebar_read` resolves the trusted caller’s unique dedicated PAW Room binding, otherwise its private Thread. Explicit scope is limited to the caller’s own Thread or a live member Room. Ambiguous dedicated bindings require explicit scope. `sidebar_update` uses the read revision for compare-and-swap; reconsider conflicts rather than blindly retrying. Room resources bind to the caller Thread and preserved descriptors keep their original owner. State is presentation intent, not screen visibility evidence; background updates do not switch the foreground or materialize content. Dirty file drafts remain separately owned.
