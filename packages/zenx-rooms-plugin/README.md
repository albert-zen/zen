# ZenX Rooms

First-party Rooms package distributed with ZenX. It is installed into the same
profile and Catalog as third-party packages, while its trusted runtime receives
only the existing Host-owned automation service.

Companion notebooks are optional bounded annotation metadata on an assistant Room.
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
