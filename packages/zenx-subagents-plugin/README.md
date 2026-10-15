# Subagents

First-party ZenX package for native child Thread creation, relationship listing, and existing public Thread send/read operations. Thread relationships are canonical App Server data; disabling or removing this plugin does not remove Threads.

`zenx_subagents_create` accepts optional `model` and `effort` settings for all
three modes. Use the opaque model key returned by `zenx_models_list` to select
an exact Provider profile (a bare model ID is accepted only when unambiguous).
An effort-only request changes the inherited model's effort. With a model but
no effort, the inherited effort is kept if the selected model supports it;
otherwise its default is used. Without either option, existing inheritance is
unchanged: fresh uses the parent's current configuration, fork uses the copied
complete-Turn boundary, and side-chat uses the full context snapshot.

Selection is validated before creating a child and is committed with its
initial canonical history, before any explicit task can be sent. Fork and
side-chat retain the original model/effort on copied historical Turns. A
side-chat still creates no Turn and does not accept a task.

Configured creation uses `zen/thread/create-child-configured` so an older Host
fails explicitly rather than silently using another model. Unconfigured
creation retains `zen/thread/create-child`. Failed validation creates no Thread;
if creation succeeds but an optional title/task operation fails, the tool
returns the created Thread ID and `followUpError` as before. Creation is not a
retry-idempotent command: inspect that result before retrying after an uncertain
response. No automatic create/configure/send fallback is used.
