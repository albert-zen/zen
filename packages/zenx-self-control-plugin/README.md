# ZenX self-control

First-party self-control package distributed with ZenX and installed through the ordinary plugin profile.

Independent Agent delegation uses a real Thread with its own model context:
discover model IDs with `zenx_models_list`, create a fresh idle Thread with
`zenx_threads_create`, and dispatch its task with `zenx_threads_send`. Include
the task's context and reporting instructions in the message. Check
`zenx_threads_status` and collect `agent_messages` with `zenx_threads_read`.
Creation does not fork this conversation, sending acknowledges dispatch rather
than completion, and this package provides no automatic parent/child lifecycle
or result return. Shell, `run_code`, and `task_id` are ordinary tool execution,
not subagents. If this plugin is unavailable, report that limitation honestly.
Claim delegation only after creation and sending return a real Thread ID
distinct from the current Thread. Claim completion only after status/history
confirms that Thread's Turn completed and its actual reply has been read.

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
