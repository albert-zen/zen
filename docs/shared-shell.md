# Shared Shell sessions

ZenX's right-hand auxiliary area has a Terminal entry. It opens a session list for
one real Thread on the local Host, in that Thread's canonical working directory.
Opening or closing the view never starts, restarts or stops a process.

The durable UI contract lives in [ZenX UI/UX decisions](../apps/zenx/docs/ui-ux.md).
This document describes the runtime, security and packaging decisions.

## One execution authority

The list observes `ToolEnvironment.taskManager`, the same owner used by Agent
`shell` and `wait`. Agent commands keep their existing pipe, completion, timeout,
cancellation, sandbox and Fleet routing behavior. The UI reads a separate bounded
cursor over those same tasks, without consuming the Agent's incremental output.
It is not a log scraper, second task registry or scheduler.

`New terminal` is an explicit human operation. It starts a PTY through the same
Shell runtime and task manager. The native adapter uses Microsoft node-pty
(Node-API; forkpty on POSIX and ConPTY on supported Windows). The shell inherits
only the existing sanitized Shell environment. It starts the configured POSIX
shell (or `/bin/sh`) with `-i`, or Windows PowerShell with `-NoLogo`; ordinary
shell startup files may run. No custom shell integration or execution-policy
change is installed. Interactive terminals currently require the Thread's
existing Full Access policy. Restricted contexts fail closed; the UI does not
escalate or change that policy. A remembered Shell denial still wins.

The Agent can use the read-only `shell_sessions` tool to list these real local
sessions and read retained output, then `wait` on a live task ID. Human terminal
input and stopping are owned by the human. The Agent cannot write to these
sessions or use `wait(terminate: true)` to stop them. Interrupting an Agent's
read/wait detaches its observation and leaves the human session running. Agent
commands retain their previous turn cancellation semantics.

## Observation and lifetime

- Stable task IDs are Thread-scoped. Sharing a project directory does not grant
  another Thread access. There is no project runtime or process index.
- Origins distinguish Agent commands and human interactive terminals.
- The displayed task status comes from the existing manager, including queued,
  running, stopping, cancellation-unconfirmed, stopped, exited and failed.
  Observation failure is shown as unknown rather than evidence of completion.
- For ordinary pipe-based commands, optional foreground/stdio facts come from
  #288. A foreground exit with open pipes is still a running task. No pipe-holder
  identity/count is guessed. PTYs do not fabricate those pipe-specific facts.
- Stop is separate from closing a tab or side panel, and has an explicit
  confirmation in the view. Pipe commands retain the existing POSIX process-group
  boundary. ZenX on Windows captures the owned foreground identity at launch and
  uses the existing exact-handle, creation-time-checked termination primitive for
  conservatively observed descendants. It never adopts new children of an absent
  or reused parent. Each successful owned kill is followed by fresh observation;
  uncertain ancestry or failed verification stays `cancellation_unconfirmed` with
  diagnostics and retained task ownership, even if the direct child/pipes close.
  This is bounded snapshot evidence, not a Windows Job Object or proof of every
  escaped descendant. CLI/Fleet runtimes without this desktop adapter keep their
  existing Windows direct-child boundary. PTY stop signals the owned terminal; native
  terminal closure ends its foreground process in the acceptance fixture.
  Escaped/detached descendants are not promised to be contained.
- A fast Windows command may exit while its initial identity snapshot is still
  pending. If replacement or Stop races that observation, cancellation stays
  unconfirmed even after foreground exit and EOF: those facts cannot establish
  ownership of unseen descendants. Host cleanup reports that uncertainty rather
  than declaring all processes stopped. Tests needing a live replacement target
  use a fixture-owned ready/release gate, not a short sleep as a liveness promise.
- Windows native observation helpers stay part of their actual Shell invocation,
  including fast commands. Host disposal joins that owned cleanup under one
  30-second deadline; it does not equate a task notification with helper exit.
  Native helper closure is not guaranteed by its kill-request timer. Deadline
  expiry or unconfirmed cleanup is an explicit Host failure, with no claim that
  all processes stopped. The Windows outer Host grace is 35 seconds, including a
  five-second transport/resource margin; normal cleanup returns immediately when
  observed complete, and other platforms retain their existing grace.
- The live view retains at most 65,536 UTF-16 code units per session and discloses
  truncation. A read returns at most 32,768 code units. Reads use independent
  cursors; the Agent's normal `wait` output window is unchanged. Views preserve
  their scroll position while hidden and provide an explicit Jump to latest.
- Completed/consumed sessions are retained as read-only observations for the
  manager's existing retention interval (five minutes by default), with at most
  the existing task limit (64) retained records. They cannot be waited again.
- Human terminals live until shell exit, explicit Stop or Host disposal, without
  inheriting the Agent command deadline. Existing Agent deadlines and shared task
  capacity stay unchanged. Receipts explicitly report no execution deadline for
  these human-owned terminals. Reopening never resurrects a process or interprets
  old output as commands.
- Fleet sessions are not relabeled local or attached through a fallback. The
  panel is explicitly local. Existing Fleet tools still require their target
  context and grants. Remote PTY attach/input is outside this first version.

## Renderer and transport security

The desktop IPC boundary requires an owned app window, its main frame and the
exact trusted renderer URL. Requests cannot override cwd, Host, sandbox or origin.
The child Host resolves and rechecks the Thread configuration. No shell socket
or new network endpoint is exposed, and the renderer receives no process handle.

Terminal bytes are untrusted. xterm renders them without HTML interpolation,
links, clipboard access, title actions or command hooks. Its generated styles live
in a same-origin, scriptless, networkless sandboxed frame. The main renderer CSP
is unchanged. Input writes are serialized, bounded and never automatically
retried after an uncertain reply. No terminal output triggers Agent execution.

## Windows native acceptance

The real PowerShell fixture first checks basic input, file output and resize in
an untouched session. It then imports the built-in Utility manifest by its exact
`PSHOME` path before testing `Write-Output` and redirection. This is test-local
dependency setup: the GitHub runner's reconstructed Azure/SQL module search paths
made first Utility discovery exceed 20 seconds, while exact built-in import and
the same cold/hot/resized commands completed promptly. The controls identified
module-discovery dependence, not a defective individual module or PTY backend.
Production shell flags, environment filtering and module paths are unchanged;
arbitrary user module configurations are not covered by this timing assertion.

## References and decisions

- [tmux getting started](https://github.com/tmux/tmux/wiki/Getting-Started):
  process/session ownership is independent of attached views. ZenX reuses its
  own existing task manager rather than introducing a tmux server.
- [cmux CLI contract](https://github.com/manaflow-ai/cmux/blob/main/docs/cli-contract.md):
  stable surface identity and separate read/input operations. ZenX deliberately
  exposes only observation to the Agent for human terminals.
- [VS Code terminal basics](https://code.visualstudio.com/docs/terminal/basics):
  a graphical session list, explicit creation and distinct process termination.
- [VS Code advanced terminal](https://code.visualstudio.com/docs/terminal/advanced):
  reconnection is distinct from process revival. ZenX never revives processes.
- [xterm security](https://xtermjs.org/docs/guides/security/): output is untrusted,
  terminal access is a privilege boundary, and the sample WebSocket attach server
  is not an authentication design.
- [Microsoft node-pty](https://github.com/microsoft/node-pty): platform PTY support
  and native packaging requirements. The runtime uses its ordinary process
  privilege; it is not an additional OS security sandbox.
- [PowerShell module paths](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath):
  Windows PowerShell reconstructs its module paths when the variable is absent;
  inheriting a PowerShell 7 module path is not a compatibility fix.
