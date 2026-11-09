# First-slice UI verification

Verified working tree based on HEAD `6cdbca045a2cd2877db535da090adc04d938f3b2` on 2026-11-09 UTC. No production files edited; no commit/push performed.

## Result

- Main focused UI run: **236 passed**, 0 failed/cancelled/skipped/todo; 122.675 seconds.
- Protected composer/virtual-scroll run: **23 passed**, 0 failed/cancelled/skipped/todo; 16.919 seconds.
- Total: **259 passed** across 23 test files.
- `git diff --check`: exit 0.
- `npm run typecheck:prepared --workspace @zen/zenx`: **exit 0**, both node and web TypeScript projects passed; only non-failing npm http-proxy configuration warning.

## Invocation

Both test runs used `npm_config_cache=/workspace/shared/ui-quality-evidence/npm-cache node --import tsx --test --test-concurrency=2` from `apps/zenx`, avoiding tsx CLI Unix socket requirements. Prepared typecheck used the same npm cache.

Read root AGENTS.md and relevant current UI/UX authority sections (Settings/Appearance, sidebar, information panel, acceptance, pending steer and question cards). No nested AGENTS.md found under apps.

### Main test files

- `test/settings-interaction.test.ts`
- `test/appearance.test.ts`
- `test/theme-source-policy.test.ts`
- `test/window-appearance.test.ts`
- `test/interface-icon-semantics.test.ts`
- `test/paw-creation-ui.test.ts`
- `test/fleet-onboarding-ui.test.ts`
- `test/room-conversations.test.ts`
- `test/editable-information-panel.test.ts`
- `test/information-layout-contract.test.ts`
- `test/information-provider-visibility.test.ts`
- `test/conversation-information-cards.test.ts`
- `test/sidebar-information-interaction.test.ts`
- `test/sidebar-thread-information.test.ts`
- `test/pending-tray.test.ts`
- `test/pending-tray-state-labels.test.ts`
- `test/room-history-scroll-ui.test.ts`
- `test/scrollbar-visibility.test.ts`

### Protected test files

- `test/experimental-transcript-viewport.test.ts`
- `test/transcript-viewport-pins.test.ts`
- `test/virtual-transcript-default.test.ts`
- `test/virtual-transcript-find.test.ts`
- `test/composer-state.test.ts`

## Evidence and limitations

Raw logs: `verification-first-slice-tests.log`, `verification-first-slice-protected.log`, `verification-first-slice-typecheck.log`, `verification-first-slice-diff-check.log` in this directory.

This is focused source, semantic contrast and deterministic DOM/unit verification, not whole-app browser/native interaction or screenshot acceptance. Full application suite, native platform behavior and screenshot/visual acceptance were not run by this worker. Parent reported the prior baseline fixture build; it was not rerun here. No test action was denied and no failing test was observed.

## Exact executed test names

### Main run (236)

1. resolves explicit and system appearance preferences
2. reads the versioned Appearance v1 profile and preserves legacy mode values
3. applies the root attribute, CSS color-scheme, and native-control meta
4. applies the resolved preset, accent and contrast before components render
5. resolves the independently saved Light and Dark presets
6. persists switches and follows live system changes only in System
7. persists one complete Appearance v1 profile and reapplies it on controller creation
8. light and dark semantic text, actions, boundaries, and focus meet contrast targets
9. every preset, accent, and contrast combination preserves readable semantic states
10. old translucency preferences are discarded while theme choices survive
11. information reads bounded current-owner facts and edits the exact trigger without executing it
12. streaming a long conversation does not clone or redraw the information catalog; real facts still update
13. trigger retry is failure-only and switches fence repeated, failed, and retired-owner intents
14. empty facts hide cards while mounted providers automatically reveal new content
15. lineage visibility follows the provider's loaded descendants, not only global summaries
16. actual editable panel uses native CAS for hide/show/remove/reorder/reset and keeps Asking outside widgets
17. actual add controls create independent Board placements without deleting removed bodies or forging bindings
18. conflicts retain exact edit and require explicit reapply; unknown writes are read before any repeat
19. actual Room layout uses its live member source and an empty Room does not invent one
20. retained conflict and in-flight edits survive closing/reopening without an automatic second write
21. transcript deltas do not reread the native information layout when owner and facts are unchanged
22. a pre-write read cannot clear an unknown-write error or authorize reapply after settling late
23. ordinary empty cards stay out of view, observe new content, and respect an explicit hide
24. saved placeholder-only layouts are quiet without migration and remain removable in Customize
25. information heading and guidance orient empty views without hiding attention or stopping providers
26. empty guidance waits for the current owner's layout and never replaces read errors
27. invitation review requires human trust and defaults to read without shell
28. cancel erases the imported invitation and makes no enrollment request
29. invalid and expired invitation errors never echo their secret input
30. a failed pairing clears the invitation before another attempt
31. a successful pair followed by connection failure reports the durable trust result
32. issuing an invitation requires explicit sharing consent and hiding clears it
33. changing access or shell scope requires a renewed human acknowledgment
34. a repeated Pair click admits one request and a late result after unmount stays dismissed
35. expiry removes an unsubmitted preview and its bearer before Pair
36. changed displayed Host or grant scope clears sharing consent and any issued secret
37. a late invitation receipt cannot appear after the displayed scope changes
38. defaults are pure, owner-typed, and do not materialize legacy state
39. actual facade and native tool edit the same store with CAS; unseen instances survive
40. add mints identity/binding, typed configuration and local moves preserve other cards
41. foreign member cards are opaque and only movable, including conflict receipts
42. private/PAW/ordinary Room scopes remain distinct and ambiguous PAWs do not guess
43. scope completeness reaches model reads, writes, conflicts and ambiguous choices
44. membership and default binding revalidate at actual store admission
45. read cursors reject changed revisions and changed unpersisted PAW bindings
46. more than 256 widgets remain reachable across pages; partial reads cannot replace a layout
47. reset restores placements without deleting custom content references or rebinding
48. reset reuses a re-added legacy Board placement instead of duplicating its document
49. old Trace absent fields replay unchanged, then exact information ops survive restart
50. Room first-edit defaults replay from Trace without rebinding to today's assistant
51. bundled and installed schemas remain exact mechanical mirrors
52. native tool rejects raw full replacement and forged bindings, without provider calls
53. a previously populated Board hides when its provider surface disappears and reappears when restored
54. Trigger and clock keys share the same inset artwork at every existing UI size
55. en: message sources use clock and conversation artwork without changing their names
56. zh-CN: message sources use clock and conversation artwork without changing their names
57. PAW defaults to its own new working Thread, and duplicate clicks share one explicit create
58. using an existing Thread is an explicit PAW alternative
59. equivalent SDK replacement retains the open PAW Project and preview without new setup reads
60. a genuine Project change retires the old preview while SDK-only changes do not, and mode changes still review the target
61. PAW creation respects cancel before without repeat or stale navigation
62. PAW creation respects cancel during without repeat or stale navigation
63. PAW creation respects new route without repeat or stale navigation
64. PAW creation respects unmount without repeat or stale navigation
65. a failed PAW setup preserves its error and blocks blind new-Thread retries
66. confirmed PAW creation navigates even when follow-up list refresh fails
67. a failed explicit binding keeps visible fields aligned with its retained submission
68. first-use PAW creation is inline, has no name form, and can be postponed without a turn
69. failed setup reads preserve the form and explicitly retry without creating work
70. uncertain introduction opens the created Room without recreating it or inventing a reply
71. confirmed creation opens chat before introduction admission, and a newer route is never replaced
72. admission opens new PAW before unrelated list refresh settles
73. accepted explicit greeting survives navigation during create admission
74. a promotion row distinguishes pending write from confirmed receipt while keeping actions locked
75. unknown promotion and its read-only check never claim another send or unlock the row
76. a new-thread Composer has no queue reorder alert without a failed operation
77. a real queue reorder failure remains visible only on its owning Thread
78. one composer tray contains Steer above Queue and local sending, with no pending echo in transcript
79. the combined pending tray owns the only pending-list scroll and one total height cap
80. pending and approval share outer scrolling without collapsing approval content
81. Queue and local sends preserve the same Markdown and typed reference capsules as ordinary messages
82. typed queued question replies keep authored question bubbles in both pending groups
83. move controls submit an exact native order snapshot and wait for the canonical reorder
84. Queue promotion enters the upper Steer group at the same identity and remains atomically recallable
85. unknown mutation stays locked across Thread switches and late replies and manual checking never resends
86. pending file references use the ordinary message link handler without submitting input
87. Sidebar opens grouped PAW conversations and Rooms without duplicating plugin navigation or creating Threads
88. disabled discovery has no conversation section and preserves generic plugin navigation
89. PAW and Room disclosures persist independently across navigation and remount while their add actions stay available
90. background polling preserves the published loading state for empty conversations
91. unrelated catalog subscriptions preserve Room rows, focus and disclosure without restarting discovery
92. conversation error remains visible and selecting a Thread clears Room selection semantics
93. StrictMode keeps a single admitted discovery loop and its unmount clears the timer
94. discovery pages the existing read command and projects only bounded navigation facts
95. disabled hook never reads and a late read cannot repopulate it
96. manual refresh joins one read and polling starts only after the read settles
97. revision replacement fences old results and waits for its read before requesting the next generation
98. a changed admission revision hides old Room facts before passive effects run
99. nonadvancing pagination fails visibly instead of spinning or publishing a partial list
100. Room list bound rejects oversized pages and duplicate identity
101. advancing empty pages also stop at the bounded page limit
102. Room unread query waits for runtime capability, then follows read preference on the existing refresh loop
103. Room navigation renders exact accessible unread count and bounded visible badge
104. PAW sidebar offers visible, context-menu and keyboard management without creating a Thread
105. first-use welcome can be postponed and resumed, while existing PAWs keep their identity
106. upward history loads once per gesture, preserves visible message and stops at retained edge
107. short viewport content waits for upward wheel or keyboard intent, without an auto-fill loop
108. late history responses cannot change another Room or a reopened Room
109. history failure has an explicit retry and scroll cannot cause an error retry loop
110. poll and concurrent arrivals preserve the history anchor at count 40
111. poll and concurrent arrivals preserve the history anchor at count 256
112. a poll already in flight cannot shrink newly expanded history
113. a history error arriving after Room navigation is discarded
114. observing the 256 boundary is read-only; an extra top scroll legitimately loads another 16
115. native scrollbar reveals on activity, stays draggable, and hides at rest
116. actual Settings UI save persists Queue, Batch, Soft provenance across profile reload
117. Settings send mode choice forwards explicit provenance through save
118. Initial settings failure stops loading and retries only on explicit request
119. Failed settings retry remains actionable without an automatic retry loop
120. Settings retry ignores a response after its active scope is left
121. Browser setup focus waits for settings to finish loading
122. Settings saves global model routing by Provider profile identity
123. Save feedback is transient, does not move focus, and clears on navigation
124. Save unchanged does not show a success toast
125. Save pending-restart does not show a success toast
126. Save unconfirmed does not show a success toast
127. A save completed after leaving its section does not show a stale toast
128. Repeated successful saves restart the toast lifetime
129. Check application status clears an earlier error after success
130. Retry applying saved settings clears an earlier error after success
131. Safe restart clears an earlier error after success
132. Models lists every profile and keeps duplicate model IDs distinguishable and keyboard reachable
133. Provider discovery starts text-only and manual overrides persist
134. model discovery and manual controls enforce the Host limit without mounting 1024 editors
135. removing a model keeps local reasoning editor state with its original row
136. a saved Unknown model offers a user-triggered image probe and shows its persisted outcome
137. Add custom provider submits an opaque identity, credential, and repeatable model rows
138. invalid Logo selection blocks submit instead of reusing an earlier upload
139. uploaded Logo refreshes a Host-confirmed save after startup fails
140. removed Logo refreshes a Host-confirmed save after startup fails
141. Add displays the server unconfirmed result without inferring failure
142. Add provider offers known local and subscription flows without creating account lifecycle
143. known Provider choice pre-fills its stable profile identity and connection
144. OpenAI subscription choice exposes the five host-confirmed models
145. Edit keeps a blank saved credential and replaces only the edited profile key
146. Edit displays the server unconfirmed result without inferring failure
147. Delete submits required default and title replacements atomically without Thread scanning
148. Delete removes an unreferenced Provider without replacement selections
149. Delete displays a saved but unconfirmed server result
150. Validation and mutation failures keep the provider editor recoverable
151. Archived threads is a Settings section with keyboard-reachable Unarchive
152. Appearance is an independent Settings section and persists the complete profile without restarting the host
153. Appearance offers opaque themes without a translucency control
154. every Settings tab remains keyboard reachable after narrow-screen reflow
155. Workflows edits Slash commands and restores the default title prompt
156. General exposes an optional maximum tool round setting
157. General opens the local diagnostics folder only after an explicit click
158. General offers an additional browser connection and reports an extension-folder failure
159. General registers only the explicitly selected Edge connector
160. General reports a browser connection with multiple available tabs
161. General exposes and saves the Host-owned tool presentation mode
162. General explicitly enables and disables native cross-device tools through Apply
163. General requires an explicit risk-labeled opt-in for foreground computer takeover
164. discovery selection preserves edits, supports search and cancel, and adds only selected models
165. Context compaction has a dedicated tab and saves selectable retention and prompt
166. Compaction rejects invalid budgets and supports selected-only retention and restoring defaults
167. Agentic compaction is opt-in, saves alongside automatic settings, and resets off
168. manual reasoning fills real defaults, preserves custom values across modes and rejects empty drafts
169. provider validation names each invalid model field and links to an editable control
170. duplicate manual reasoning efforts stay in the editor and emit a field diagnostic
171. oversized model ID is rejected at its field before Host validation
172. many invalid model rows keep diagnostics bounded while all errors remain visible
173. one Base URL field exposes one matching summary and inline error
174. Provider credential-storage-unavailable stays next to Save, keeps the draft and focuses each rejected attempt
175. Provider credential-encryption-failed stays next to Save, keeps the draft and focuses each rejected attempt
176. Provider credential-decryption-failed stays next to Save, keeps the draft and focuses each rejected attempt
177. Provider credential-read-failed stays next to Save, keeps the draft and focuses each rejected attempt
178. Provider credential-write-failed stays next to Save, keeps the draft and focuses each rejected attempt
179. Add custom provider keeps all inputs and a nearby credential-storage error
180. late Provider rejection respects none navigation without losing its inline error
181. late Provider rejection respects outside navigation without losing its inline error
182. late Provider rejection respects tab navigation without losing its inline error
183. late Provider rejection respects window navigation without losing its inline error
184. late Provider rejection respects activity navigation without losing its inline error
185. late Provider rejection respects page navigation without losing its inline error
186. Host-rejected stale API key edit keeps the draft despite another window's revision
187. Provider IPC failure stays unconfirmed even if another window now has matching fields
188. provider validation survives unrelated edits and clears each issue only when repaired
189. invalid default reasoning effort and zero context identify the correct controls
190. a provider without model rows stays invalid and offers a focused add action
191. subscription discovery refreshes existing model metadata in the saved draft and preserves manual overrides
192. Plugin feedback coordinates parent errors; departed completion=false
193. Plugin feedback coordinates parent errors; departed completion=true
194. RTK toggle saves a draft, reports pending restart, and preserves it after restart rejection
195. unavailable RTK cannot be enabled and its saved preference can still be disabled
196. Agentic switch retains its unsaved state after save failure and can return off
197. settings retain unsaved edits across hidden Activity and saves do not overwrite newer input
198. changing Settings tabs starts the new panel at its heading
199. Settings Plugins uses the plug icon while Context compaction retains compression artwork
200. provider editing protects the in-memory draft from other card actions and returns focus
201. provider add cancel returns focus to the remounted custom-add button
202. provider pending save protects editor; success preserves logical focus and draft
203. provider pending save protects editor; failure preserves logical focus and draft
204. late provider save does not steal focus from another Settings tab or restore it on return
205. provider Save after native-style blur respects none focus intent
206. provider Save after native-style blur respects typing focus intent
207. provider Save after native-style blur respects pointer focus intent
208. provider Save after native-style blur respects tab focus intent
209. provider Save after native-style blur respects window focus intent
210. provider Save after native-style blur respects activity focus intent
211. API explicit input metadata fills only Unknown after opt-in; manual=false
212. API explicit input metadata fills only Unknown after opt-in; manual=true
213. API ID-only catalog and mismatched provider cannot fill existing Unknown metadata
214. API pending metadata respects manual-edit
215. API pending metadata respects endpoint-edit
216. API pending metadata respects switch-provider
217. API pending metadata respects failure
218. API discovery cannot race failed Save provider; metadata ready=false
219. API discovery cannot race failed Save provider; metadata ready=true
220. compatible protocol defaults to Chat, changes only explicitly, persists through edit, and never probes automatically
221. changing protocol retires an in-flight discovery identity and stale results cannot populate the new editor
222. failed local diagnostics folder opening retains cause in closed details
223. committed Provider save failure keeps local diagnostic after editor closes
224. unconfigured Account offers a focused route to provider setup without signing in
225. details retain focus, title directly renames, and late save cannot close a newer editor
226. pinned and hidden child rows preserve unseen ends while running and approvals suppress the dot
227. next automation uses earliest finite future, excludes paused/due and reports unknown facts
228. narrow automation projection validates identity without copying prompts or history
229. definition errors and unknown timers do not invent the next trigger
230. renderer product styles keep raw colors in the single theme source
231. every renderer product token is defined or an explicit component-owned seam
232. Appearance v1 drives shell, sidebar, content, preview, and controls through canonical semantic roles
233. Appearance v1 has three presets per mode and root seams for every live control
234. the plugin marketplace visual harness loads theme tokens before product styles
235. blank browser surface has explicit theme-owned pure black and white values
236. desktop windows use an opaque background without native materials

### Protected run (23)

1. unknown queued admission settles only from canonical same clientId and tracks delivery
2. other intent rejects queued evidence; changed draft and new submission never clear on late old ID
3. explicit refusal stays refused; queue disappearance is not admission evidence
4. A→B→A cannot clear newer text by late RPC or canonical admission
5. image removal and restore, and mode switch and return, invalidate old clear authority
6. maps idle, active, and replacement submissions without a queue
7. a pending request is a click fence, not a local queue
8. keeps the draft and stable message id across a transport retry
9. editing a failed draft creates a new operation id
10. acceptance clears only the submitted draft and never invents history
11. ordered images form one draft, removal preserves text, and image-only drafts submit
12. running send modes implement the Enter and Cmd/Ctrl+Enter matrix
13. send acknowledgement preserves compaction observation fences and independent explicit request
14. captures client timezone once per submission, not again on transport retry
15. missing client timezone stays missing on transport retries
16. real Legend viewport bounds mounted rows and cancels a reveal when unmounted
17. focused row is retained and releases when focus leaves the transcript
18. native cross-row ranges protect their whole mounted interval, not just endpoints
19. pointer selection protects rows before an active native range exists
20. outside selection does not pin this viewport
21. anchor identity uses visual row order and actual within-row offset
22. virtual transcript and Find default on with independent per-tab DOM fallback
23. virtual Find reveals unmounted data, wraps, respects editor shortcuts, preserves Selection and cancels newer intent
