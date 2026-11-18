# Native Settings interrupted-flow validation

Status: complete. Native Settings draft/persistence journeys passed on `4893830a`; the additional numeric-clear defect found there was fixed and genuinely re-tested on final combined source `bebe9276`. The final bounded live-scroll/Stop journey also passed. Only synthetic local QA state is used.

## Versions and scope

- Before native reproduction: production source `58df4ea3852e4826d3aa31a931c3383258bc0c47`, original built application. The initial UI window was Linux Electron, 1188 × 848, English, light appearance.
- Settings implementation checkpoint: `0b166ecd4b35a7d75595e691edd5dcc3027a14e6`.
- Settings draft implementation: `901e135def108be6ddf01b834be40bdf2f5afbff`.
- Native-discovered numeric clear correction: `1ebcb0501f0e5f3d8886b6e8288921adff78fb68`, changing only the number field event binding plus two regression cases.
- Corrected combined source for the follow-up native run: `bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`, tree `746ff97626902500d8ae5f73cba6d706a4da9910`. Build completed 2026-11-09 18:52:58 UTC; 60-file build fingerprint `8ac22504f95551ccea66697bfff73af820adfeb77d43a5586c3f2f60a3c01d52`; renderer `index-DJHKR4sn.js`.
- First combined native validation source: `4893830a2139e074e9091d5d5a22651bb9e03032`, tree `a60532bbfb805d4b17abb761e33ff05062a78fa8`. This also includes the separately integrated scroll changes. Build fingerprint: `a566f52c92d7fbf1948b71e0fc69b4e741f5df1db33080a57c51c529b066ae24`. Renderer: `index-VL64IrlM.js`.
- Settings source SHA-256 at901/489: `aa4e6439671f796cf2080ad96f8c7a118c4e7315124d287a3bfa43185fe723e1`.
- Settings interaction test SHA-256 at901/489: `fd5c93a324f0613385e66d5ec0579aaefb601de9e05068a204e1e0a927167746`.
- Final Settings source SHA-256 at1eb/bebe: `2d48a680ad3e9bd9a989bf53b1f31956a99478ada6a0664d9284dd33c957401f`.
- Final Settings interaction test SHA-256 at1eb/bebe: `02c645b9d51c350a5a351015b200505ec38ca0542f43e28272ac611cf2e7360d`.

## Observed before the fix

1. Account was unconfigured. Open model settings navigated to Models & providers without sign-in.
2. A General send-mode draft (Run each queued message separately) survived switching sections, leaving Settings for New thread, and returning.
3. Saving an independent local FakeModel provider display-name edit then lost that General draft. The send-mode control displayed Unavailable selection; Apply still appeared enabled. Before/after original screenshots are retained separately.
4. Blank model ID produced an explicit validation summary and field error. The invalid editor draft survived section switching. Cancel restored the provider edit entry: pressing Enter reopened the correct provider with its saved model ID.
5. General Maximum tool rounds = 0 produced a visible error on blur. With another dirty setting, Apply incorrectly remained enabled.

## Observed on combined source 4893830a

1. Unconfigured Account → Open model settings routed correctly without authentication.
2. Send-mode menu dismissed with Escape; selecting Run each queued message separately survived Models → New thread → Settings → General without Apply.
3. Entering 0 and blurring showed the whole-number error and disabled Apply. Switching to Models exposed the General error there and kept Apply disabled; returning retained 0.
4. Real native key events entered a solitary `-`. Blur showed the error and disabled Apply. Switching away and back retained the partial text and error. This was not a mocked browser event.
5. Directly selecting and deleting that `-` visibly cleared the field but left the error and Apply disabled. This is a newly reproduced recovery defect, not a pass. Typing valid 12 cleared it; clearing 12 then worked as Unlimited. Original screenshots preserve both branches. The correction uses the single existing parser on every input event, including a validity-only change where the numeric DOM value remains an empty string.
6. With send-mode Queue and max 12 still un-applied, saving the local fake provider name as Settings persistence QA retained both General drafts. The independent provider save persisted revision 1 and the new name, while composerSendMode remained soft, explicit provenance remained false, and maxToolRounds was absent. Apply then persisted revision 2, queue, explicit provenance true, and max 12. Field-only JSON assertions are included; no full profile is shared.
7. Blank provider model ID showed a linked summary and field error. Switching sections retained the invalid editor. Cancel followed by Enter reopened the correct saved provider with model ID fake, not the invalid draft.
8. Switching language to Simplified Chinese and back to English applied immediately, keeping saved Queue selected. No permission settings were changed.

Screenshots prefixed `after-` in this stage belong to source 4893830a only, including the recovery defect. They must not be relabelled as the subsequent input-event correction.

## Observed on final corrected combined source bebe9276

Fresh isolated roots were seeded for this version. No source or built files changed during native capture. These original screenshots use `final-input-` and `final-live-` prefixes.

1. With an unrelated Queue draft, typed valid 12, selected it, then genuinely typed `-` and blurred. The visible partial value produced the whole-number error and disabled Apply.
2. Selected and directly deleted `-`, then blurred. The empty field showed its Unlimited help, no error, and Apply was enabled. No intermediate valid value was needed.
3. Repeated from valid 12 with actual `1e` typing. The incomplete exponent visibly remained invalid and blocked Apply. Direct clearing again restored valid Unlimited and Apply.
4. Repeated `12 → - → 18`. The valid 18 cleared the error, enabled Apply, and saved successfully. A field-only persisted read confirmed revision 1, Queue, explicit provenance true, and maxToolRounds 18. This is genuine native input recovery, separate from the modeled validity tests.
5. In a separately seeded local stream fixture, sent QA_STREAM through the normal composer. Live checkpoints advanced from 7 to 16 while following.
6. Scrolled to Reading checkpoint 28. Original screenshots at 18:56:38.466 and 18:56:55.239 UTC retained its vertical position, a 16.773-second hold. Local QA receipts during that interval recorded emitted checkpoint 30 then 40. This demonstrates continued generation while reading remained held.
7. Switched to Admission and retry, returned, and collapsed the sidebar. Reading checkpoint 28 remained in view at the held position.
8. Back to live resumed following, with checkpoint 71 and then 87 visible. Explicit Stop showed Stopped · Progress kept and restored the idle composer. A local receipt recorded model_interrupted after 88 chunks; the matching Trace contained turn_aborted with reason Interrupted by user. Only a derived assertion summary is included, not the raw receipt file or Trace.
9. The final app is left open at the stopped synthetic stream, sidebar collapsed, window 41943044, with no active generation. No fullscreen or narrow-window behavior is claimed from this short final run.

## Automated regression evidence (not native timing evidence)

Source `901e135d` passed 145 focused tests; final input correction `1ebcb050` passed 147 across:

- `apps/zenx/test/settings-interaction.test.ts`
- `apps/zenx/test/model-settings.test.ts`
- `apps/zenx/test/provider-model-admission.test.ts`
- `apps/zenx/test/provider-deletion.test.ts`

Command: `node --import tsx --test` followed by those four paths.

Both Node and renderer TypeScript checks passed using `npm run typecheck:prepared --workspace @zen/zenx`. Formatting and whitespace checks passed. The full App suite was not rerun. The final combined checkout independently passed 244 focused tests plus 8 bounded App tests, both typechecks, and the prepared build.

The additional input-event regression was red for badInput→empty with an unchanged DOM value, then green after the event-binding fix. Both Unlimited and valid-number correction cases passed, together with the existing invalid-number and Host-refresh cases (5 focused numeric tests). This models validity flags in jsdom; actual native typing is reported separately.

The new deterministic callback regressions cover independent provider add/edit/delete results, committed-error refreshes, readback of untouched Host fields, valid/removed model references, edits made during requests, both activation/provider response orderings, Apply against a newer authority revision, Safe restart/configuration checks, explicit post-submit reverts, and clearing transient tracking after failure. They establish component state and submitted payload behavior, not observations of real concurrent windows or network timing.

## Boundaries

The native Settings fixture uses the unchanged production FakeModel and normal production app, with synthetic profile and history. No real account or remote provider is connected, no credential is supplied, and no permission/security setting is changed. Default renderer-session non-loopback requests are blocked by the launcher; this is not an OS firewall. Profile files, local IPC authentication, runtime logs and raw Trace are private disposable state and are excluded from publishable artifacts.

Windows, macOS, mobile, assistive technology, actual credential errors, remote provider discovery, real concurrent-client timing and the full App suite are not validated here. Native solitary-minus and incomplete-exponent typing, direct clear-to-Unlimited recovery, and valid-18 recovery were all observed on the final build as described above. Other browser engines and OS-specific numeric behaviors are not claimed.

## Publishable artifacts

The adjacent manifest explicitly lists original image paths, SHA-256, actual JPEG encoding and dimensions, source stage, and expected/observed outcomes. Images are not edited, resized, or re-encoded. Field-only persistence assertions and the derived live-native assertion summary contain synthetic facts only. Full profiles, seed roots, local authentication, raw runtime logs, and raw Trace are excluded.
