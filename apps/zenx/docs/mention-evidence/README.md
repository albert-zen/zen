# @file candidate evidence

The two PNGs are **real Electron renderer + isolated ZenX Host IPC** captures, not a mocked UI or an installed/signed application. Both use the same temporary non-Git workspace containing `.DS_Store` at root and depth two, `.gitignore`, `.gitmodules`, `.github/workflows/build.yml`, README, source and package.json. A local `fake` provider created the Thread. `@` opens the real Host-backed candidate menu.

- [Before](before.png): production source at parent commit `b494dfc65edd1bdefb971e28249e096cf37f35a9` (original search source Git blob `bb621fe3b3fb60169843d09e3f2ab29561054f2a`). `.DS_Store` is first and appears twice.
- [After](after.png): production source SHA-256 `6059f6da50ba2d62d2ad0cb71693ae5f5623856f4dbbd9e8b7071c9a76c25b61` (the version committed alongside these captures). Ordinary files lead, useful hidden configuration remains visible and system debris is absent.

Captured via Electron `webContents.capturePage()` at 1280×820 logical pixels (2× raster); only the candidate list and composer were **cropped** using `sips` to remove the absolute temporary workspace path and sidebar. No list rows or messages were altered. An isolated profile, synthetic workspace and test process were removed afterward. This verifies the actual desktop renderer/Host for one finite fixture, not installed-app permissions, huge repositories, all platforms, or timing under deadline pressure. Automated tests cover further matching and truncation boundaries.
