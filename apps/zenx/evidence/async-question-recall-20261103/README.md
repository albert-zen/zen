# Native asynchronous question and recall evidence

Source: PR #626 head 323928f577d8500c8ec7120fa5b7c6d6b68187f1, tree e52d7f4d4a7ffa11e808d33532fe021e94f32c7d. Full production macOS Electron App, preload and Host, native input, fake provider and synthetic private profile. No user data or real device. Run: https://github.com/albert-zen/zen/actions/runs/41573104817

Questions were published by the default-on Host, whose turns completed and which exited. A fresh normal Desktop Host restored the pending questions. The two mixed-origin batches were recalled atomically; normal text, file and image returned to the Composer and the selected option/free text to its original question card. Navigating away preserved a recoverable receipt; explicit recovery restored it once. Cold reopens observed no model-visible recalled input. Full CI and Send performance acceptance are separate.
