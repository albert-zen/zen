# Native cross-device tools

Settings → General → **Native cross-device tools** is off by default, including
for existing profiles. Toggle it and Apply to update subsequent model samples;
no Host restart is required. The caller's preference is separate from each
device's tools grant and the target Host's tools opt-in. Enabling the feature
never expands those permissions.

When off, the capability catalog omits `zenx_fleet_tools`, `zenx_fleet_execute`
and `zenx_fleet_tool_status` from direct tools, plugin discovery and the code
catalog. The target router consequently leaves local schemas unchanged and
does not publish target-specific proxies, even when old catalog disclosures
remain in history. Native target dispatch also checks the current preference,
including calls carrying a previously captured capability generation. Disabling
does not cancel or replay already-dispatched remote work; observing those tasks
through the native entry requires enabling the feature again.

Ordinary Fleet machine connections, remote conversation reads/sends and the
separate shell entry retain their existing availability and permissions.
There is no automatic local or SSH fallback. Native target catalog discovery
can add target-specific tools and therefore change the provider's tool prefix;
this is the cache tradeoff of opting in.

## T3 Code comparison

The local reference inspected at commit
`5ea5a80a83c21c50f97f0851a8bd2cb9871f413a` uses SSH to start or reuse a T3 server
on the target and connects its desktop client to that remote environment. The
launch script starts `serve --host 127.0.0.1`, and the SSH environment manager
provides the connection/bridge. This is remote Agent execution rather than the
local Agent learning a separate set of remote tool proxies.

Reference owners in T3 Code: `packages/ssh/src/tunnel.ts` (`REMOTE_LAUNCH_SCRIPT`,
`launchOrReuseRemoteServer`),
`apps/desktop/src/ssh/DesktopSshEnvironment.ts` and
`apps/desktop/src/ipc/methods/sshEnvironment.ts`. This comparison is limited to
those actual connection paths; it is not a claim that T3 has no other remote or
MCP tools. No T3 code or live SSH destination was modified or invoked.
