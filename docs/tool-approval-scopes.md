# Instance-scoped tool admission

A trusted `ToolRuntime.approvalScope` resolver may bind a call to one target:

- `key`: stable target identity used with the exact tool name for policy
- `label`: human-readable target shown in the approval request
- `generation`: dispatch identity independently revalidated by the domain Host

`ToolEnvironment.prepare` calls the resolver once after finalizing local routing inputs. The resolver sees cloned, recursively frozen arguments. Core copies and freezes its result, and exposes the same snapshot on the prepared call and runtime invocation. Callers cannot supply top-level `approvalScope`; model arguments never mint this metadata. Core does not interpret target identities or manage target lifetimes. Scope-resolving runtimes are local-only; generic Fleet remote execution does not yet carry instance-scoped admission. Registration rejects combining `approvalScope` with `enforcesSandbox: true`, so file-sandbox automatic admission cannot bypass a target decision.

## Admission

Under `ask_unknown`, scoped calls use only the paired `ToolPolicyStore.getScoped` / `setScoped` methods. An implementation lacking either method fails closed for remembered scoped admission. Scoped decisions and pending prompts are separate from unscoped tool-name decisions, and are keyed by exact tool name and target key. A legacy grant, a sibling instance, or a coincidentally matching serialized name cannot authorize the call.

Approval requests carry an immutable `approvalTarget` containing the target key and label. The command is prefixed with that label so existing approval clients identify the target without protocol changes. Restricted file permissions retain their existing one-time approval behavior, including the target label; those approvals do not persist a scoped grant.

The shared CAS/native approval callback never consumes or populates its legacy thread-wide `acceptForSession` cache for scoped requests. A scoped `acceptForSession` allows the current invocation without remembering a grant; Core separately remembers ordinary `accept`/`decline` decisions for the exact tool and target. A previous unscoped session approval cannot suppress a new target's prompt.

The optional native `approvalTarget` projection lets ZenX and CLI describe the exact target without parsing command text. CLI calls its scoped session shortcut “approve once”; its ordinary yes/no choices and ZenX allow/deny describe exact tool/target memory. Other CAS clients receive this conservative session limit in the standard `reason` text. Legacy unscoped client behavior is unchanged.

Inherited `run_code` calls never prompt. A scoped child under `ask_unknown` must already have an approved decision for that exact tool and target. Approving `run_code` itself cannot authorize an unknown scoped browser instance. Existing unscoped child behavior is unchanged: a remembered denial wins, while an unknown unscoped child inherits admission.

`full_access` remains an explicit Host policy and bypasses scoped decisions for direct calls. The same policy reaches nested scoped calls only through the exact, still-retained admitted builtin composite parent, with matching Thread identity. A scoped parent cannot lend its Full Access admission to a sibling target or a different dispatch generation, including through intermediate unscoped composites. The runtime passes the parent handle directly; no model argument or caller-supplied boolean grants inherited Full Access. Unscoped child denials retain their previous semantics.

The domain Host must independently reject obsolete generations or a target that no longer matches the captured scope before dispatch. A remembered approval is not permission to substitute another instance. Scope snapshots, parent admission and pending prompts are transient Host state; no new Thread item, permission graph or durable execution state is introduced.
