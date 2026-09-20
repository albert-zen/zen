# ZenX self-control

First-party self-control package distributed with ZenX and installed through the ordinary plugin profile.

Besides Project and Thread controls, the package exposes the same user-scoped
workflow configuration used by Settings. `zenx_self_control_workflows_get` reads custom
Slash commands and the title prompt; `zenx_self_control_workflows_update` replaces them with
revision conflict protection. The built-in `/compact` name is reserved.
