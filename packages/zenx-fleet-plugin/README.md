# Fleet

An ordinary first-party plugin that discovers user-configured machines and their usage descriptions, inspects each target's Zen workspaces/models/Threads, and creates/sends explicit work without changing the execution authority.

Descriptions are guidance only. Discovery reports last-checked reachability, never an implied permanent live connection. Use machine-scoped workspace and Thread IDs; a failed target operation does not fall back to this machine.

Shell is a separate permission. A target Host and fresh device grant must opt in; target Thread sandbox/tool approvals remain authoritative. No remote interactive approval route is claimed. Unsupported SSH shell targets reject explicitly. Unknown mutation outcomes are not retried automatically.
