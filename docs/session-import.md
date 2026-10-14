# Import a Codex conversation

ZenX can import a user-selected **codex-cli 0.146.0 rollout JSONL** file into a new,
continuable Zen Thread. In the Projects/Threads sidebar, choose **Import Codex
conversation** (down-arrow button), select the export, review the preview and
exclusions, and choose an existing local project directory, provider/model and
file permissions. Import does not start a model request or execute any tool. A deterministic imported title prevents automatic title inference during import.
Send a new message after opening the imported Thread to continue.

The local directory is an explicit mapping: the source `cwd` is only a reference.
It may name a different machine or a path that no longer exists. The current
Project projection groups the imported Thread by the chosen local cwd, just like
other Threads; import does not create a second Project/runtime object. The first
new local Turn loads that directory's current repository instructions.

## What crosses the boundary

- User and assistant text retains its role and order. Text parts keep their order.
- Complete function/custom tool call/result pairs retain their call identity,
  arguments/input and output, including source namespace and JSON/text input format.
  Provider requests use deterministic historical-only name/ID aliases; those aliases
  are never registered as executable tools. Subscription replay retains custom text
  calls; compatible replay represents their exact input as a JSON `input` field.
  Historical results have **unknown execution outcome**,
  not a fabricated successful exit code. They never reconnect to jobs or execute.
- Public reasoning summaries remain inspectable history. Opaque/private reasoning,
  source system/developer instructions, tool definitions, world-state snapshots/patches
  and execution configuration
  are excluded and counted in the preview. They do not become new Host instructions.
- Explicit `task_complete`/`turn_aborted` source events close historical Turns.
  Other endings are marked as unconfirmed/interrupted snapshots, never pending work.
- Current configured provider/model selection is validated by the Host. New Threads
  start with Ask approvals and Read Only by default; the import form can select a
  different local file-permission preset. No source approval, credential or capability
  grant is restored. Normal Zen sandbox/approval semantics govern later calls.
- The new journal records the source file's SHA-256, source identity/version/cwd,
  exclusions and any checkpoint basis. The transcript keeps a visible import notice.

This is local history migration, **not a provider-side Codex session resume**.
The importer never scans a sessions directory, follows attachment references, reads
source cwd, signs in, starts a task or grants permissions from file contents.
Keep a copy of the original export.

## Compacted exports

For a compacted rollout, Zen uses the **latest explicit replacement_history** and
subsequent records as the continuation basis. A legacy checkpoint with a nonempty
explicit `message` can supply an assistant-role summary. The preview and saved
Thread notice identify its source line and how many earlier records remain only
in the original export. This mode imports continuation context; it is **not a full
transcript archive**, and it never reconstructs missing private history.

Opaque-only checkpoints, media-bearing continuation context, unsupported response
records (including subagent delivery), externally paginated histories, rollback records,
invalid JSON, unpaired/interleaved tool calls and unsupported CLI versions fail explicitly without publishing
a partial Thread. Obtain a complete supported text export rather than editing away
unresolved calls and pretending they completed.

Limits: 16 MiB per file, 2 MiB per JSONL record, and 20,000 records. A selected file
must be stable UTF-8. The same exact source bytes and creation settings are idempotent,
including restart and acknowledgement-loss retries. A later changed export is a new
snapshot. Reimporting the same bytes with different creation settings reports a
conflict; open and change the existing Thread through ordinary settings instead.

## CLI and native clients

Preview only (does not start the Host):

```sh
zen import-session ./selected-rollout.jsonl
```

Create in an explicitly selected local data directory and project:

```sh
zen import-session ./selected-rollout.jsonl --commit \
  --cwd /absolute/local/project --data-dir /path/to/zen-data \
  --provider fake
```

Use your ordinary configured provider options instead of `fake` for real work.
`--sandbox read-only|workspace-write|danger-full-access` selects the new local preset.
`--model` resolves against the actual target Host's catalog, including with `--remote`;
unavailable or ambiguous names fail before import (use the full catalog ID to disambiguate).
The output contains the new Thread ID. Use `zen chat --thread <id>` with the same
Host/data-directory/provider configuration, or open it in ZenX connected to that Host.
Do not run independent Hosts concurrently against the same journal directory.

Native clients use `zen/thread/import/preview` with `{ format, contents }`, then
`zen/thread/import` with those exact bytes, the returned `expectedSha256`, and
`configuration: { cwd, selection?, sandbox? }`. `selection` contains the local
`providerProfileId`, `modelId`, and optional `reasoningEffort`. Import is atomic and
requires journal `create` support. These are ZAS-native methods, not CAS commands.

## Format evidence and verification limits

The source adapter is pinned to OpenAI's first-party
[rollout records and CompactedItem](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/protocol/src/protocol.rs),
[ResponseItem content/tool types](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/protocol/src/models.rs),
[world-state persistence](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/session/mod.rs#L3478-L3537),
and [compaction replacement construction](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/compact.rs).

Tests use synthetic exports. They verify next-turn sampling and actual locally
approved tool execution separately from transcript rendering, plus malformed/large
input rejection, checkpoint selection, call/result consistency, disk replay,
concurrent retries, preview races and repeated confirmation. No private user session
folder was read. A real user-selected export and live provider continuation still
need acceptance on the user's actual installation; synthetic success is not that claim.
