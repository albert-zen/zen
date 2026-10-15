# External browser activity synthetic component QA

Captured production/fixture source cc51c88c7b43d245d4461edd49f852ff0d42d779, tree 880e5d353bb1db9e9799615541209b7ba71899e0, in cloud Chrome on 2026-10-15. Real AuxiliaryPanel, BrowserThreadPanel and production CSS; synthetic catalog, operation notifications and page placeholder. This does not establish native transport, login/form persistence, arbitrary website content or complete Electron E2E.

## Observed operations
- First Start synthetic external activity selects the external ordinary tab; production activity text and chrome animation appear (02). Finish leaves the same tab selected and removes activity (03).
- Start, manually select Reference, then another Start leaves Reference selected and shows Follow Agent (04). Enter on Follow selects external peer (05). Follow is removed after activation and focus falls to body; no retained-focus claim.
- A newer Request synthetic presentation selects the workspace Project draft. The older external Finish does not steal selection (06). Repeated Start for the same session epoch/target also does not steal it: presentation is once per incarnation/target, not every operation. Follow/manual selection remains available.
- Failure updates the external peer to a static unknown-outcome warning (08, 10). Screenshot 07 remains on Project draft and is not evidence of the external unknown presentation.
- Real 390 CSS-pixel iframe viewport, dark Chinese: Enter Start selects peer, browser-panel-target animation is browser-agent-chrome (09). Enter Fail produces warning and all rendered element animations are none (10). body and document scroll widths are 390.
- 390 light Chinese: manual Reference remains selected after new Start, Follow stays visible (11); Enter Follow restores external peer (12).
- Close side panel, then Start external does not reopen the panel (13), respecting manual opt-out.
- Labels/unknown warning wrap, tab title truncates in the intended horizontally scrolling tab strip, no page horizontal overflow. Keyboard controls exercised; native touch hardware, reduced-motion emulation and browser process restart not tested.

## Evidence selection
Root visually reviewed 02/03/04/05/06/09/10 and approved publication. Recommended seven embedded images are those seven. 08/11/12/13 remain supplementary local evidence. All content is synthetic, with visible synthetic label. The placeholder sentence about separate smoke validation is not evidence that native CI passed.
