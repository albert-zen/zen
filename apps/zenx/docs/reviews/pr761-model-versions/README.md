# Same-name model versions in the composer

Production `ComposerModelMenu`, Linux Chromium 131.0.6778.0, 1280×800, light, zh-CN, DPR 1, offline synthetic model catalog. The candidate matches the renderer of #761 at 97dbc73 (product source 3163e53). The baseline is the exact same source with the production portion of 336c76b reversed. Screenshots show the open model submenu before filtering. The surrounding fixture is not the full App, and no provider is contacted.

Before: two Alpha Cloud rows show the same display name and capability line. Candidate: those two rows show full, different model IDs. The uniquely named model and the same display name under a different provider group do not gain extra version text. Both builds have exactly one selected radio item at rest. Typing 2026-11-15 narrows to one result without switching. ArrowDown twice and Enter select exactly the Alpha model vendor/text-stable-2026-11-15, close the menu, and restore focus to the model trigger. The unsent draft stays unchanged.

[Cherry Studio #13654](https://github.com/CherryHQ/cherry-studio/pull/13654) includes author screenshots for the matching model-ID disclosure pattern. Not a local Cherry Studio run or a visual score. PNGs are unmodified browser captures.
