# Narrow sidebar pointer fix: current-main synthetic UI QA

Source e850c962ce1eda61426c17f2e24e3ef058423cea; tree42f1dd8d9006f6f3de8754d014d84a3c0cac372e. Production App/styles with synthetic data and isolated real SettingsService. This is browser rendering, not native Electron or actual Windows/macOS-machine acceptance.

- 390 win32 collapsed startup: button is x8/y96/44×44, computed top52px. Readonly center hit is its SVG path and closest button is Open sidebar. A single native cloud-desktop pointer click opens and retains the sidebar (01 before,02 after). The composed main has removed the old global subagent visibility toggle.
- Explicit Close followed by Enter on Open also succeeds.
- Darwin bridge,1148 light: normal sidebar and composer (03). Resize via visible wrapper button to390: opener preserves top8px/y52 and center hit, ordinary pointer opens (04 before).
- Historical603 source separately passed win390 true/false,720 exact boundary,721 desktop transition,1148, darwin390, linux390 and selected-Thread header. Those older images are retained under their original source and are not current-main screenshots.

The synthetic wrapper changes only iframe viewport and declared platform at initialization; it does not patch production DOM or CSS. No physical-touch, native drag-region or cross-OS-machine claim. All screenshot content is synthetic.
