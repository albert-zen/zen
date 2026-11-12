# Browser permission switch

A single switch at the far right of the existing address toolbar controls whether the Agent may mutate this tab. It does not indicate who is currently operating or whether a task is running. The user may always browse manually. Enabling permission does not start a task or resume a conversation. No handoff tool or completion button is added.

## Visual evidence

The screenshots use the actual WorkspaceBrowserPanel and application theme/styles in Chromium with an inert synthetic sign-in page. No real user site, account or credentials are included. They are renderer-fixture evidence, not native Electron/macOS acceptance evidence.

- wide-light-allowed.png and wide-light-blocked.png show permission on/off.
- narrow-dark-allowed.png and narrow-dark-blocked.png show a 390px-wide desktop panel.

The toolbar stayed 44px tall and the page remained at y=88, height=669 while toggling. The narrow toolbar measured width=scrollWidth=390, with no overflow. The external-open arrow remains inside the URL field; the permission switch is the final toolbar control. Space toggled the focused switch. Native hover-title content and the identical accessible description were inspected; native tooltip rendering on each operating system is not claimed.

## Tests

51 focused tests passed across workspace-browser-control-ui, workspace-browser-shared-target and browser-external-open. They cover the stable permission label/checked state, single-toolbar placement, duplicate-click lock, mutation errors, tab/thread/remount isolation, existing mutation/observation fences and external-open behavior. Application CSS and changed files passed formatting checks.

The existing backend, IPC, tool manifests, packages and task lifecycle are unchanged. Full local web typecheck remains blocked by baseline missing @xterm dependencies; hosted CI must verify the dependency-installed tree.
