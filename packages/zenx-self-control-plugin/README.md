# ZenX self-control

First-party self-control package distributed with ZenX and installed through the ordinary plugin profile.

Besides Project and Thread controls, the package exposes the same user-scoped
workflow configuration used by Settings. `zenx_self_control_workflows_get` reads custom
Slash commands and the title prompt; `zenx_self_control_workflows_update` replaces them with
revision conflict protection. The built-in `/compact` name is reserved.

Thread tools accept `target`: full ID, unique prefix or exact title. Use `workspace`
to disambiguate; ambiguous targets return candidates and never write. Discover
Threads with `zenx_threads_list` (query, workspace, archived, limit and cursor).

Send only target/text, optionally messageType: follow_up queues work, guidance adds
to current work, replacement interrupts and changes it. Omit for the saved ZenX
preference. The application owns IDs, retry deduplication and exact-Turn checks.

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
