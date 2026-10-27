# macOS background and session-state acceptance

Production source checkpoint: `9faf2dd89e567cbf0a030627e31e341c62dfb72c` (base `97187f2a`). Independent production review R1 passed after three observed races were corrected: activity wrongly granting preview freshness, a late action result crossing lock/unlock, and readiness capture verification being relabeled as a newer session generation.

## UI evidence

![Locked-session access explanation](environment-mac-locked.png)

The actual production PluginAccessReview component was rendered from clean `bb99d865756f39eb5f39255fb00fe81f87e8c1da` in a hidden isolated Electron renderer using **synthetic** macOS locked Host facts. This is layout/text evidence, not a photograph of a real locked screen or a native operation acceptance test. The component, translations, fixture and styles are unchanged in the final readiness-only `9faf2dd8` commit.

Relevant Git blobs: PluginAccessReview `614cd989fe55e20974ddf9a7cd2cf20b86da4e4e`, settings translations `118345d8e8ebda32d5b175cbd13ac49ecba9b869`, visual fixture `9b2656cbe4085eeb0adf2e70bf1ec78b12318564`. PNG SHA256: `022e60b821bd1708308cac93995c583281f610a9b0792770820389fca6d25914`.

## Actual macOS observations

On macOS 26.5.1 arm64, isolated synthetic Browser/Computer fixtures produced these distinct results:

| Operation/state                                                                                            | Observed result                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background Browser CDP Chinese forms, select/checkbox/editable, stale refs, cancellation and tab isolation | Passed; no foreground focus or system pointer change                                                                                                                           |
| Background AppKit AX text writes and native NSButton press                                                 | Actual value/button-state readback passed; no foreground focus or pointer change                                                                                               |
| Background Electron DOM AXPress                                                                            | Native ACK returned, but DOM effect remained absent; recorded task failure                                                                                                     |
| Startup already locked                                                                                     | Native sampler reports locked, matching an independent CoreGraphics observation; previous Electron-only active inference was incorrect                                         |
| Locked capture and foreground input                                                                        | Rejected before dispatch                                                                                                                                                       |
| Browser CDP while the session is already locked                                                            | Actual owned DOM effects passed independently of native GUI visibility                                                                                                         |
| Fresh AppKit window created while locked                                                                   | Native AX could not find the target; no GUI success claim                                                                                                                      |
| Public CGEvent post-to-PID/window experiment while locked                                                  | Sender returned posted-unverified; fixture received zero mouse events and button count did not change. No foreground or pointer change. Experiment was not added to production |
| Display off while unlocked / real lock-to-unlock transition / model task quality                           | Not yet evaluated                                                                                                                                                              |

The deterministic baseline contains 12 checks: 11 pass and one Electron AXPress task failure. A transport ACK never counts as application success. AppKit, Electron, CDP and native GUI paths are separate capabilities. The source change permits a narrow fresh native accessibility attempt where the OS exposes it; it does not claim universal locked-session GUI availability or unlock the Mac.

## Automated validation

- 242 focused tests at `bb99`: 241 pass, one existing platform skip.
- Final readiness correction: 39 focused checks pass; independent review also ran 39 with zero skips/failures on `9faf`.
- Node/Web and Computer package typecheck, 7 same-version digest repair/startup checks, and 5 first-party packaging checks pass.
- Ordinary package upgrades compare exact trusted tarball digests, including changed content at the same version. Explicit uninstall and non-bundled overrides retain their existing behavior.

Actual display-off and lock/unlock transitions require a coordinated user window. No test here actively locked, unlocked or changed display state; existing locked state was observed. Daily app installation and real-user profile/history migration were not performed.
