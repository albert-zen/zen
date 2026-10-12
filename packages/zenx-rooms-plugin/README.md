# ZenX Rooms

First-party Rooms package distributed with ZenX. It is installed into the same
profile and Catalog as third-party packages, while its trusted runtime receives
only the existing Host-owned automation service.

PAW notebooks are optional bounded annotation metadata on an assistant Room.
Use zenx_rooms_workspace (UI command workspace) to read them explicitly, and
zenx_rooms_update_workspace (update-workspace) to replace matters/memory with the
last read expectedRevision. A stale edit fails; refresh and merge deliberately.
The Host generates revision/time, rejects unknown fields and duplicate IDs,
bounds all UTF-8 fields/counts and the total JSON to 40 KiB, and commits through
the existing atomic automation document. Legacy Rooms without notes read empty
at revision zero. Rooms lists/transcript previews never include the notebook.

Matters carry plans, status notes, free-form notes, and exact Thread/Trigger
references. A Thread reference requires device, workspace and threadId; local
references use device local. Memory notes contain id/title/text. References do
not execute, create, cancel or watch anything. Actual execution is read from
canonical Threads and existing Triggers, independently of annotations. Notes
enter model context only as explicit normal tool results; changing a notebook
never changes historical Items or silently injects mutable context.

## Message interactions

- **Delivered** means the message was durably saved in the Room. **Read** means its exact routed input was admitted to that recipient's Thread context, including ordered steering. Queued input alone does not count. This is a harness receipt, not an external model acknowledgment or a claim of comprehension. Missing history or unavailable Threads remain unconfirmed.
- Reply selects a same-Room message. Its bounded quote is captured with the send operation so retry/restart cannot silently select another target. Agents can pass `replyToMessageId` to the post tool.
- React sets one of six emoji for the current actor; select it again to remove it. Agent attribution comes from the calling Thread, never tool arguments. Reactions do not start Turns.
- Direct Thread messages and Room messages remain separate. Only an explicit Room post appears in the Room.
