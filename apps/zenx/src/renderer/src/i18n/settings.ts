// Settings UI copy. Keep keys stable across locales; product data and user content stay unchanged.
export const en = {
  "fleetComposer.catalogFailedPreserved":
    "{{error}} Your text is preserved; no local machine was substituted.",
  "fleetComposer.snapshotChecked": "Snapshot checked {{time}}",
  "fleetComposer.operationFailedInspect":
    "{{error}} Inspect the selected remote machine before trying again. No operation was automatically retried.",
  "fleetComposer.earlierOperationUncertain":
    "Earlier Fleet operation on {{deviceId}} has an uncertain outcome: {{error}}. Inspect that machine before retrying.",
  "fleetComposer.acceptedAfterLeaving":
    "Message accepted on machine {{deviceId}}, Thread {{threadId}}, after leaving its view. Acceptance is not completion.",
  "fleetComposer.messageAccepted":
    "Message accepted on {{deviceId}}; the target may still be running",
  "fleetComposer.acceptedSnapshotUnavailable":
    "Message accepted on {{deviceId}}, but its latest snapshot is unavailable: {{error}}. Refresh to inspect; the message was not retried.",
  "fleetComposer.machineLocked":
    "Machine locked · {{deviceId}} · Thread {{threadId}}",
  "fleetComposer.localCatalogUnavailable":
    "Fleet catalog unavailable: {{error}}",
  "fleetComposer.newConversationOn": "New conversation on {{name}}",
  "fleetComposer.modelDefault": "{{name}} · Default",
  "fleetComposer.snapshotScope":
    "{{deviceId}} · {{route}} · {{workspace}} · {{status}}. This is a checked public snapshot, not a full local copy of remote history.",
  "fleetComposer.verifiedSshRoute": "Verified SSH route",
  "fleetComposer.notChecked": "Not checked",
  "fleetComposer.snapshotUnavailable":
    "Unavailable · last snapshot may be stale",
  "fleetComposer.unknownStatus": "Unknown",
  "fleetComposer.createDescription":
    "Create uses this target’s current defaults and selected Zen model. It creates an idle Thread first; sending starts work.",
  "fleetComposer.attachmentWarning":
    "This remote entry supports text only. Remove local images/attachments or return to This machine before sending; nothing was discarded.",
  "fleetComposer.createdAfterLeaving":
    "Remote Thread {{threadId}} was created on {{deviceId}} after leaving its draft; inspect it before creating another. No message was sent.",
  "fleetComposer.inspectOutcome":
    "Outcome needs inspection. Refresh the remote Thread or reopen this machine’s catalog; automatic retry is disabled.",
  "fleetComposer.machine": "Machine",
  "fleetComposer.thisMachine": "This machine",
  "fleetComposer.machineOwnsThread":
    "The selected machine owns the Thread and its permissions",
  "fleetComposer.remoteConversation": "Remote conversation",
  "fleetComposer.targetPermissions":
    "Target permissions and models apply. Your local Thread is unchanged.",
  "fleetComposer.reloadCatalog": "Reload target catalog",
  "fleetComposer.loadingCatalog":
    "Loading this machine’s workspaces and models…",
  "fleetComposer.targetWorkspace": "Target workspace",
  "fleetComposer.chooseWorkspace": "Choose a target workspace",
  "fleetComposer.newThreadModel": "Model for new Threads",
  "fleetComposer.chooseModel": "Choose a target model",
  "fleetComposer.targetReasoning": "Target reasoning",
  "fleetComposer.targetDefault": "Target default",
  "fleetComposer.openExistingThread": "Open an existing remote Thread",
  "fleetComposer.createOrChooseThread":
    "Create new, or choose an existing Thread",
  "fleetComposer.refreshThread": "Refresh remote Thread",
  "fleetComposer.history": "Remote conversation history",
  "fleetComposer.readOnly":
    "This machine is read-only; you can inspect existing Threads.",
  "fleetComposer.messageToThread": "Message to remote Thread",
  "fleetComposer.taskForMachine": "Task for the remote machine",
  "fleetComposer.messageBehavior": "Remote message behavior",
  "fleetComposer.guidance": "Add guidance",
  "fleetComposer.followUp": "Queue next work",
  "fleetComposer.replacement": "Interrupt and replace",
  "fleetComposer.sending": "Sending to target…",
  "fleetComposer.send": "Send to remote Thread",
  "fleetComposer.start": "Start on selected machine",
  "fleetComposer.newDraft": "New draft on this machine",
  "fleetComposer.returnLocal": "Return to This machine",
  "fleetOnboarding.invitationExpired":
    "This invitation expired. Ask the target user for a fresh invitation.",
  "fleetOnboarding.invitationExpiredRetry":
    "This invitation expired. Ask for a fresh invitation.",
  "fleetOnboarding.invalidMachineId":
    "Use a machine ID with letters, numbers, dashes or underscores.",
  "fleetOnboarding.duplicateMachineId":
    "This machine ID is already configured. Choose another ID or review the existing device.",
  "fleetOnboarding.machineNameRequired": "Enter a machine name.",
  "fleetOnboarding.pairedChecking": "Paired. Checking this machine…",
  "fleetOnboarding.pairedCheckFailed":
    "Paired, but the connection check failed. The saved trust remains; use Test on the device after addressing the error.",
  "fleetOnboarding.issuerExpired":
    "Invitation expired. Create a fresh one when the other user is ready.",
  "fleetOnboarding.clientsRefreshFailed":
    "Could not refresh paired clients. Check Fleet status before sharing again.",
  "fleetOnboarding.sharingScopeChanged":
    "Fleet Host or sharing scope changed. Refresh, review and confirm before sharing a new invitation.",
  "fleetOnboarding.clipboardUnavailable":
    "Clipboard unavailable. Select the invitation field and copy it using the system Copy action.",
  "fleetOnboarding.pairedReachable":
    "Paired and reachable: {{name}}. This was a connection check, not a permanent live session.",
  "fleetOnboarding.setupDescription":
    "Ask the Agent on that machine to check Fleet readiness. Its user creates an invitation, then you review and pair here.",
  "fleetOnboarding.endpointRequirement":
    "The target must already have a trusted, reachable HTTPS endpoint or a configured relay. Machines on unrelated networks cannot find each other automatically. Invitations stay in this Settings screen; do not paste them into an Agent conversation.",
  "fleetOnboarding.preparePrompt":
    "Ask: “Check Fleet readiness on this machine and explain what is missing. Prepare nonsecret settings only. Let me approve hosting and pairing.”",
  "fleetOnboarding.readinessDescription":
    "The Fleet plugin is bundled for any Agent. Existing disabled choices and normal tool permissions remain in effect. The read-only readiness tool reports known devices and preparation steps; it cannot install certificates, configure networks or create trust.",
  "fleetOnboarding.loopbackWarning":
    "This is a loopback address. It reaches only the receiving computer; use a configured network endpoint to connect another machine.",
  "fleetOnboarding.verifyHostDescription":
    "Confirm this Host ID directly on the target or through a trusted channel. HTTPS certificate checks still apply. Descriptions guide the Agent’s use of the machine and cannot grant access. A server-issued read grant needs fresh pairing before it can be upgraded.",
  "fleetOnboarding.shellConsent":
    "Allow explicit bounded remote shell using the target Thread’s existing sandbox and approvals",
  "fleetOnboarding.issuerDescription":
    "Share one invitation through a private, trusted channel. It includes the endpoint and Host ID, expires in five minutes, and can be used once. Creating another replaces the previous code. Keep it out of Agent conversations and logs.",
  "fleetOnboarding.issuerEndpointDescription":
    "Use the configured client-facing endpoint, the connected relay, or this Host’s listener address. DNS, network reachability and trusted TLS must already be ready. A loopback listener works only on the same computer.",
  "fleetOnboarding.connectMachine": "Connect another machine",
  "fleetOnboarding.useInvitation": "Use invitation",
  "fleetOnboarding.prepareWithAgent": "Prepare with an Agent",
  "fleetOnboarding.checkSetup": "Check this machine’s setup",
  "fleetOnboarding.invitation": "Invitation",
  "fleetOnboarding.reviewInvitation": "Review invitation",
  "fleetOnboarding.cancelInvitation": "Cancel invitation",
  "fleetOnboarding.reviewMachineInvitation": "Review machine invitation",
  "fleetOnboarding.machineId": "Machine ID",
  "fleetOnboarding.machineName": "Machine name",
  "fleetOnboarding.machineDescription": "Machine description",
  "fleetOnboarding.access": "Access",
  "fleetOnboarding.invitationAccess": "Invitation access",
  "fleetOnboarding.readOnly": "Read only",
  "fleetOnboarding.threadControl": "Thread control",
  "fleetOnboarding.pairing": "Pairing…",
  "fleetOnboarding.pairAndCheck": "Pair and check",
  "fleetOnboarding.inviteClient": "Invite a client",
  "fleetOnboarding.invitationEndpoint": "Invitation endpoint",
  "fleetOnboarding.invitationMachineName": "Invitation machine name",
  "fleetOnboarding.creating": "Creating…",
  "fleetOnboarding.createInvitation": "Create invitation",
  "fleetOnboarding.shareInvitation": "Share invitation",
  "fleetOnboarding.copied": "Copied",
  "fleetOnboarding.copyInvitation": "Copy invitation",
  "fleetOnboarding.hideInvitation": "Hide invitation",
  "fleetOnboarding.readinessSummary":
    "Credential store: {{credentialStore}} · Hosting: {{hosting}} · Trusted endpoint: {{endpoint}}",
  "fleetOnboarding.credentialsReady": "ready",
  "fleetOnboarding.credentialsNeedEncryption":
    "needs operating-system encryption",
  "fleetOnboarding.hostRunning": "running",
  "fleetOnboarding.hostNotRunning": "not running",
  "fleetOnboarding.endpointConfigured": "configured",
  "fleetOnboarding.endpointNeedsConfiguration": "needs configuration",
  "fleetOnboarding.hostId": "Host ID: {{hostId}}",
  "fleetOnboarding.endpoint": "Endpoint: {{endpoint}}",
  "fleetOnboarding.expiresAt": "Expires: {{time}}",
  "fleetOnboarding.shareExpiryWarning":
    "Expires {{time}}. Anyone holding this invitation can request access. Hiding it clears this screen; the one-use code remains valid until consumed, replaced or expired.",
  "fleetOnboarding.trustRead":
    "I verified this Host and allow this app to save a revocable read-only connection",
  "fleetOnboarding.trustReadShell":
    "I verified this Host and allow this app to save a revocable read-only connection with explicit remote shell",
  "fleetOnboarding.trustControl":
    "I verified this Host and allow this app to save a revocable Thread control connection",
  "fleetOnboarding.trustControlShell":
    "I verified this Host and allow this app to save a revocable Thread control connection with explicit remote shell",
  "fleetOnboarding.shareRead":
    "I allow one client holding this invitation to request read-only access",
  "fleetOnboarding.shareReadRelay":
    "I allow one client holding this invitation to request read-only access through my trusted relay operator",
  "fleetOnboarding.shareReadShell":
    "I allow one client holding this invitation to request read-only access and explicitly opt in to remote shell",
  "fleetOnboarding.shareReadShellRelay":
    "I allow one client holding this invitation to request read-only access and explicitly opt in to remote shell through my trusted relay operator",
  "fleetOnboarding.shareControl":
    "I allow one client holding this invitation to request Thread control access",
  "fleetOnboarding.shareControlRelay":
    "I allow one client holding this invitation to request Thread control access through my trusted relay operator",
  "fleetOnboarding.shareControlShell":
    "I allow one client holding this invitation to request Thread control access and explicitly opt in to remote shell",
  "fleetOnboarding.shareControlShellRelay":
    "I allow one client holding this invitation to request Thread control access and explicitly opt in to remote shell through my trusted relay operator",
  "fleetOnboarding.thisMachine": "This machine",
  "fleetOnboarding.invalidInvitation": "Invalid Fleet invitation",
  "fleetOnboarding.invalidInvitationExpiry": "Invalid Fleet invitation expiry",
  "fleetOnboarding.parsedInvitationExpired":
    "Fleet invitation expired; request a fresh invitation",
  "fleetOnboarding.invalidInvitationEndpoint":
    "Invalid Fleet invitation endpoint; use one HTTPS origin",
  "fleetOnboarding.configuredPeersOnly":
    "Only user-configured peers are discovered; no automatic network scan, rendezvous or pairing.",
  "fleetOnboarding.httpsReachability":
    "Direct HTTPS needs a certificate trusted by the client and a route to the Host. Listener state and timestamped checks do not prove current client reachability.",
  "fleetOnboarding.networkPreparation":
    "Different networks need routing or a VPN arranged by the user, or an already configured reachable relay. Fleet does not set up routers, VPNs, certificates or relays.",
  "fleetOnboarding.relayTrust":
    "A relay is a trusted TLS termination point that can see pairing, requests and events; relay transport is not end-to-end encrypted.",
  "fleetOnboarding.invitationLimits":
    "Invitations are human-only bearer secrets, expire within five minutes and can pair once. Host and client grants still bound control and shell access.",
  "fleetHistory.readPrompt":
    "Read the remote Thread to view its public history",
  "fleetHistory.emptyHistory": "No history items returned",
  "fleetHistory.privateReasoning": "Private reasoning is not displayed",
  "fleetHistory.you": "You",
  "fleetHistory.agent": "Agent",
  "fleetHistory.item": "Item",
  "fleetHistory.remoteAttachment": "Remote attachment",
  "fleetHistory.boundedExcerpt": "Bounded excerpt",
  "fleetHistory.remoteImage": "[Remote image attachment]",
  "fleetHistory.completed": "completed",
  "fleetHistory.turnStatus": "Turn {{status}}",
  "fleetHistory.modelUsage":
    "Usage · {{inputTokens}} input / {{outputTokens}} output tokens",
  "fleetHistory.threadMetadata": "thread metadata",
  "fleetHistory.threadForked": "thread forked",
  "fleetHistory.threadInstruction": "thread instruction",
  "fleetHistory.threadConfigurationChanged": "thread configuration changed",
  "fleetHistory.contextCompaction": "context compaction",
  "fleetHistory.turnStarted": "turn started",
  "fleetHistory.turnAborted": "turn aborted",
  "fleetHistory.turnReplacementRequested": "turn replacement requested",
  "fleetHistory.userMessageQueued": "user message queued",
  "fleetHistory.userMessageQueueCancelled": "user message queue cancelled",
  "fleetHistory.reasoning": "reasoning",
  "fleetHistory.toolCall": "tool call",
  "fleetHistory.toolResult": "tool result",
  "fleetHistory.codeState": "code state",
  "fleetHistory.failure": "failure",
  "fleetComposer.statusActive": "active",
  "fleetComposer.statusIdle": "idle",
  "fleetHistory.statusCompleted": "completed",
  "fleetHistory.statusFailed": "failed",
  "fleetHistory.statusInterrupted": "interrupted",
  "fleetHistory.statusInProgress": "inProgress",

  "pluginSettings.namedActions": "{{name}} actions",

  "fleetSettings.routeIdentityMissing":
    "Fleet route identity is missing. Refresh Fleet before browsing this device.",
  "fleetSettings.exactThreadUnavailable":
    "The exact remote Thread is unavailable; no other Thread was selected.",
  "fleetSettings.chooseTargetWorkspace":
    "Choose this target's workspace before listing Threads.",
  "fleetSettings.routeChanged":
    "This device route or access changed. Reopen Browse before sending; the old remote Thread was not retargeted.",
  "fleetSettings.workspaceSelectedReopen":
    "Workspace selected. Reopen Browse to inspect this route before sending.",
  "fleetSettings.hostRefreshFailed": "Could not refresh Fleet hosting status.",
  "fleetSettings.routeHelp":
    "SSH uses your existing SSH setup. HTTPS uses a pinned Host ID and a one-time pairing code. Reachability is a timestamped check; test connections close afterwards and do not imply a live session.",
  "fleetSettings.machineDescription": "Machine description",
  "fleetSettings.machineDescriptionHelp":
    "Describe what this machine is for and when the Agent should use it. This is guidance only; it cannot grant permissions or change commands.",
  "fleetSettings.requestShell":
    "Request target-owned remote shell execution for this HTTPS device",
  "fleetSettings.shellHelp":
    "Shell is a separate opt-in on this client and the remote Host. It uses an existing target Thread’s current sandbox and remembered approvals, not local permissions. Unknown interactive approvals cannot be answered remotely and reject. Enabling a server-issued shell grant requires fresh pairing; changing this saved request flag alone cannot expand it.",
  "fleetSettings.clientHttpsEndpoint": "Client-facing HTTPS endpoint",
  "fleetSettings.allowShell":
    "Allow separately paired shell clients to request bounded commands on this Host",
  "fleetSettings.hostShellHelp":
    "Remote shell requires a fresh separate client grant and an explicit authorized workspace/target Thread. That Thread’s current sandbox and approvals apply; existing read-only or legacy grants never gain shell access. Interactive remote approval is not available.",
  "fleetSettings.includingShell":
    ", including separately authorized target-owned shell execution",
  "fleetSettings.advancedPairingCode": "Advanced: separate pairing code",
  "fleetSettings.shellGranted": " · Shell granted",
  "fleetSettings.noShellGrant": " · No shell grant",
  "fleetSettings.checkedTime": " · checked {{time}}",
  "fleetSettings.reachable": "Reachable",
  "fleetSettings.lastCheckFailed": "Last check failed",

  "settingsView.zenxSettings": "ZenX settings",
  "settingsView.openSidebar": "Open sidebar",
  "settingsView.settings": "Settings",
  "settingsView.makeZenxYourOwn": "Make ZenX your own",
  "settingsView.settingsSections": "Settings sections",
  "settingsView.plugins": "Plugins",
  "settingsView.manageThePluginsAvailableInZenx":
    "Manage the plugins available in ZenX.",
  "settingsView.checkApplicationStatus": "Check application status",
  "settingsView.retryApplyingSavedSettings": "Retry applying saved settings",
  "settingsView.saved": "Saved ·",
  "settingsView.takesEffectNextLaunch": "takes effect next launch",
  "settingsView.safeRestart": "Safe restart",
  "settingsView.archivedThreads": "Archived threads",
  "settingsView.restoreAnArchivedConversationToReturnItToThe":
    "Restore an archived conversation to return it to the sidebar.",
  "settingsView.loadingArchivedConversations":
    "Loading archived conversations…",
  "settingsView.tryAgain": "Try again",
  "settingsView.noArchivedConversationsConversationsYouArchiveWillAppearHere":
    "No archived conversations. Conversations you archive will appear here.",
  "settingsView.account": "Account",
  "settingsView.openaiSubscription": "OpenAI subscription",
  "settingsView.connectYourChatgptSubscriptionToUseItsModels":
    "Connect your ChatGPT subscription to use its models.",
  "settingsView.signOut": "Sign out",
  "settingsView.modelsProviders": "Models & providers",
  "settingsView.connectYourProvidersAndChooseTheModelsYouWant":
    "Connect your providers and choose the models you want to work with.",
  "settingsView.defaultModels": "Default models",
  "settingsView.chooseAModelForNewConversationsAndAnotherFor":
    "Choose a model for new conversations and another for naming them.",
  "settingsView.newWork": "New work",
  "settingsView.existingConversationsKeepTheirModelYouCanChangeIt":
    "Existing conversations keep their model. You can change it from the message box at any time.",
  "settingsView.providerProfiles": "Provider profiles",
  "settingsView.manageEachConnectionAndItsAvailableModels":
    "Manage each connection and its available models.",
  "settingsView.addProvider": "Add provider",
  "settingsView.addCustomProvider": "Add custom provider",
  "settingsView.addAKnownProvider": "Add a known Provider",
  "settingsView.chooseABuiltInConnectionPresetCustomApisUse":
    "Choose a built-in connection preset. Custom APIs use the separate custom flow.",
  "settingsView.addOpenaiSubscription": "Add OpenAI subscription",
  "settingsView.openaiSubscription2": "OpenAI subscription",
  "settingsView.addLocalDemo": "Add Local demo",
  "settingsView.localDemo": "Local demo",
  "settingsView.deterministicFakeDevProviderForLocalTesting":
    "Deterministic fake/dev Provider for local testing",
  "settingsView.cancel": "Cancel",
  "settingsView.default": "Default",
  "settingsView.title": "Title",
  "settingsView.edit": "Edit",
  "settingsView.delete": "Delete",
  "settingsView.cancel2": "Cancel",
  "settingsView.checkTheseFields": "Check these fields",
  "settingsView.providerLogo": "Provider Logo",
  "settingsView.providerLogoPngJpegOrWebpUpTo512":
    "Provider Logo (PNG, JPEG, or WebP; up to 512 KiB and 1024 × 1024; 4 MiB total)",
  "settingsView.removeLogo": "Remove Logo",
  "settingsView.storedKeysAreNeverShownEnterAValueOnly":
    "Stored keys are never shown. Enter a value only to add or replace this profile's key.",
  "settingsView.authenticationIsManagedByTheExistingOpenaiSignIn":
    "Authentication is managed by the existing OpenAI sign-in in Account.",
  "settingsView.localDemoWorksOfflineAndDoesNotNeedAn":
    "Local demo works offline and does not need an API key.",
  "settingsView.modelCatalog": "Model catalog",
  "settingsView.chooseTheModelsAvailableFromThisProviderOrAdd":
    "Choose the models available from this provider, or add one manually.",
  "settingsView.availableModels": "Available models",
  "settingsView.chooseModelsToAdd": "Choose models to add",
  "settingsView.searchAvailableModels": "Search available models",
  "settingsView.alreadyAdded": "Already added",
  "settingsView.noMatchingModels": "No matching models.",
  "settingsView.cancelSelection": "Cancel selection",
  "settingsView.addSelectedModels": "Add selected models (",
  "settingsView.remove": "Remove",
  "settingsView.addModel": "Add model",
  "settingsView.modelLimitReached1024RemoveAModelTo":
    "Model limit reached (1,024). Remove a model to add another.",
  "settingsView.selectAModel": "Select a model",
  "settingsView.selectAModel2": "Select a model",
  "settingsView.cancel3": "Cancel",
  "settingsView.unknown": "Unknown",
  "settingsView.noReasoningStrengthControl": "No reasoning strength control",
  "settingsView.manualConfiguration": "Manual configuration",
  "settingsView.lowMediumHigh": "low, medium, high",
  "settingsView.chooseADefault": "Choose a default",
  "settingsView.unknown2": "Unknown",
  "settingsView.text": "Text",
  "settingsView.textImage": "Text + image",
  "settingsView.imageOnly": "Image only",
  "settingsView.knownUnsupported": "Known unsupported",
  "settingsView.eG128000": "e.g. 128000",
  "settingsView.useTheModelProviderSPublishedTokenLimit":
    "Use the model provider's published token limit.",
  "settingsView.hideThisModelFromNormalSelection":
    "Hide this model from normal selection",
  "settingsView.delete2": "Delete",
  "settingsView.removeThisProviderAndItsSavedCredentialsExistingConversations":
    "Remove this provider and its saved credentials. Existing conversations keep their model selection.",
  "settingsView.addAnotherProviderBeforeDeletingTheOnlyProfile":
    "Add another Provider before deleting the only profile.",
  "settingsView.selectAModel3": "Select a model",
  "settingsView.selectAModel4": "Select a model",
  "settingsView.cancel4": "Cancel",
  "settingsView.appearance": "Appearance",
  "settingsView.themeColorAndContrast": "Theme, color, and contrast.",
  "settingsView.themeAndColor": "Theme and color",
  "settingsView.chooseHowZenxFeelsWhileKeepingEverySurfaceIn":
    "Choose how ZenX feels while keeping every surface in sync.",
  "settingsView.local": "Local",
  "settingsView.appearanceMode": "Appearance mode",
  "settingsView.liveAppearancePreview": "Live appearance preview",
  "settingsView.accent": "Accent",
  "settingsView.accent2": "Accent",
  "settingsView.contrast": "Contrast",
  "settingsView.changesApplyImmediatelySystemFollowsYourOperatingSystemLight":
    "Changes apply immediately. System follows your operating system; Light and Dark remember separate presets.",
  "settingsView.resetAppearance": "Reset appearance",
  "settingsView.general": "General",
  "settingsView.chooseHowZenxWorksWithYouAndYourProjects":
    "Choose how ZenX works with you and your projects.",
  "settingsView.interaction": "Interaction",
  "settingsView.sendWhileAReplyIsRunning": "Send while a reply is running",
  "settingsView.sendQueuedMessagesTogether": "Send queued messages together",
  "settingsView.runEachQueuedMessageSeparately":
    "Run each queued message separately",
  "settingsView.guideTheCurrentReplyDefault":
    "Guide the current reply (default)",
  "settingsView.interruptAndSend": "Interrupt and send",
  "settingsView.enterAndTheSendButtonUseThisChoiceCmd":
    "Enter and the send button use this choice. Cmd/Ctrl+Enter guides the current reply when a queue option is selected, or queues messages together otherwise. Shift+Enter adds a new line. This setting does not change messages already queued.",
  "settingsView.foregroundComputerControl": "Foreground computer control",
  "settingsView.highImpactAccessToTheDesktopYouAreActively":
    "High-impact access to the desktop you are actively using.",
  "settingsView.allowForegroundTakeover": "Allow foreground takeover",
  "settingsView.thisLetsZenxAgentsMoveThePointerTypeKeys":
    "This lets ZenX agents move the pointer, type keys, change focus, or scroll the app you are currently using.",
  "settingsView.allowForegroundComputerControl":
    "Allow foreground computer control",
  "settingsView.offByDefaultBrowserAutomationAndBackgroundSafeComputer":
    "Off by default. Browser automation and background-safe Computer tools do not need this permission. Apply to change which tools agents can use.",
  "settingsView.executionAndPermissions": "Execution and permissions",
  "settingsView.defaultProject": "Default project",
  "settingsView.approvalPolicy": "Approval policy",
  "settingsView.approvalRequired": "Approval required",
  "settingsView.fullAccess": "Full access",
  "settingsView.toolPresentation": "Tool presentation",
  "settingsView.directAndCodeRecommended": "Direct and code (recommended)",
  "settingsView.directToolsOnly": "Direct tools only",
  "settingsView.codeOnly": "Code only",
  "settingsView.chooseHowAgentsUseToolsCallThemDirectlyWrite":
    "Choose how agents use tools: call them directly, write JavaScript to combine them, or use both. Code has the same permissions as shell commands.",
  "settingsView.maximumToolRounds": "Maximum tool rounds",
  "settingsView.leaveBlankForUnlimitedStopAReplyAfterThis":
    "Leave blank for unlimited. Stop a reply after this many rounds of tool use.",
  "settingsView.manageProjectsFromTheSidebar":
    "Manage projects from the sidebar.",
  "settingsView.defaultsApplyToNewRepliesRunningRepliesKeepTheir":
    "Defaults apply to new replies. Running replies keep their current settings, and conversation-specific choices take priority.",
  "settingsView.localDiagnostics": "Local diagnostics",
  "settingsView.storedOnThisDeviceAndNeverSharedAutomatically":
    "Stored on this device and never shared automatically.",
  "settingsView.openDiagnosticsFolder": "Open diagnostics folder",
  "settingsView.authorizationCodeOrRedirectUrl":
    "Authorization code or redirect URL",
  "settingsView.continue": "Continue",
  "fleetSettings.fleetConnectionIsUnavailableInThisAppBuild":
    "Fleet connection is unavailable in this app build.",
  "fleetSettings.retry": "Retry",
  "fleetSettings.fleet": "Fleet",
  "fleetSettings.connectYourZenHostsEachDeviceKeepsItsOwn":
    "Connect your Zen Hosts. Each device keeps its own workspaces, Threads and permissions.",
  "fleetSettings.refreshFleet": "Refresh Fleet",
  "fleetSettings.devices": "Devices",
  "fleetSettings.sshUsesYourExistingSshSetupHttpsUsesA":
    "SSH uses your existing SSH setup. HTTPS uses a pinned Host ID and a one-time pairing code.",
  "fleetSettings.addDevice": "Add device",
  "fleetSettings.noRemoteDevicesConfigured": "No remote devices configured",
  "fleetSettings.test": "Test",
  "fleetSettings.browse": "Browse",
  "fleetSettings.edit": "Edit",
  "fleetSettings.remove": "Remove",
  "fleetSettings.deviceEditor": "Device editor",
  "fleetSettings.connection": "Connection",
  "fleetSettings.ssh": "SSH",
  "fleetSettings.httpsPairing": "HTTPS pairing",
  "fleetSettings.userDeviceOrSshConfigAlias": "user@device or SSH config alias",
  "fleetSettings.theseExactArgumentsRunOnTheRemoteDeviceThrough":
    "These exact arguments run on the remote device through verified SSH. Configure SSH keys and known hosts yourself before testing.",
  "fleetSettings.checkTheHostIdDirectlyOnTheRemoteDevice":
    "Check the Host ID directly on the remote device. Pairing verifies its identity; saved credentials stay in this app’s protected backend. To change the endpoint or identity, remove this device and pair again. Changing local access cannot expand a server-issued read-only grant. To upgrade, remove this saved device and pair again with Thread control selected; the remote Host must allow it.",
  "fleetSettings.iAllowZenxToCreateThreadsAndSendMessages":
    "I allow ZenX to create Threads and send messages that can run work on this remote device",
  "fleetSettings.cancel": "Cancel",
  "fleetSettings.remove2": "Remove",
  "fleetSettings.thisRemovesTheSavedConnectionFromThisAppRemote":
    "This removes the saved connection from this app. Remote Threads remain on their Host. Revoke this app on the remote Host to end its grant there.",
  "fleetSettings.removeDevice": "Remove device",
  "fleetSettings.cancel2": "Cancel",
  "fleetSettings.remoteWorkspacesAndThreads": "Remote workspaces and Threads ·",
  "fleetSettings.closeBrowser": "Close browser",
  "fleetSettings.remoteWorkspace": "Remote workspace",
  "fleetSettings.refreshThreads": "Refresh Threads",
  "fleetSettings.useSelectedWorkspace": "Use selected workspace",
  "fleetSettings.read": "Read",
  "fleetSettings.moreThreads": "More Threads",
  "fleetSettings.remoteThread": "Remote Thread",
  "fleetSettings.readOlderItems": "Read older items",
  "fleetSettings.messageBehavior": "Message behavior",
  "fleetSettings.addGuidanceToCurrentWork": "Add guidance to current work",
  "fleetSettings.queueNextWork": "Queue next work",
  "fleetSettings.interruptAndReplaceCurrentWork":
    "Interrupt and replace current work",
  "fleetSettings.sendingCanRunWorkOn": "Sending can run work on",
  "fleetSettings.sendToRemoteThread": "Send to remote Thread",
  "fleetSettings.hostThisDevice": "Host this device",
  "fleetSettings.allowPairedDesktopAndMobileClientsToReachThis":
    "Allow paired desktop and mobile clients to reach this Host over HTTPS.",
  "fleetSettings.hostId": "Host ID:",
  "fleetSettings.endpoint": "Endpoint:",
  "fleetSettings.relay": "Relay:",
  "fleetSettings.enableHttpsHosting": "Enable HTTPS hosting",
  "fleetSettings.useAnExactCertificateSanHostnameOrIpv4Address":
    "Use an exact certificate SAN hostname or IPv4 address and an explicit port matching the listener, with no trailing slash. Blank allows only native Origin-absent clients; Android WebSocket clients need this exact HTTPS endpoint. This does not enable browser pairing or broad CORS access.",
  "fleetSettings.anOptionalSelfHostedRelayTerminatesTlsAndCan":
    "An optional self-hosted relay terminates TLS and can see relayed pairing codes, messages and device credentials. Use a trusted operator; this is not end-to-end encrypted. The registration token is saved only in the protected backend; leave it blank to keep the existing token.",
  "fleetSettings.useExistingTlsFilesHostingDoesNotGenerateKeys":
    "Use existing TLS files. Hosting does not generate keys or change firewall/router settings. A loopback bind is reachable only on this computer; a network bind can expose this Host to other devices. Clients still require pairing.",
  "fleetSettings.iAllowThisHostToListenOn": "I allow this Host to listen on",
  "fleetSettings.andExposeItsWorkspacesAndThreadsToPairedClients":
    "and expose its workspaces and Threads to paired clients",
  "fleetSettings.iAllowPairedClientsWithControlAccessToCreate":
    "I allow paired clients with control access to create Threads and run work on this device",
  "fleetSettings.discardChanges": "Discard changes",
  "fleetSettings.createPairingCode": "Create pairing code",
  "fleetSettings.oneTimePairingCode": "One-time pairing code:",
  "fleetSettings.hostId2": "Host ID:",
  "fleetSettings.enterThisCodeAndTheHttpsEndpointOnThe":
    "Enter this code and the HTTPS endpoint on the client you want to pair. Anyone with this code can request access until it expires or is used.",
  "fleetSettings.hideCode": "Hide code",
  "fleetSettings.pairedClients": "Paired clients",
  "fleetSettings.noPairedClients": "No paired clients",
  "fleetSettings.revoke": "Revoke",
  "fleetSettings.revoke2": "Revoke",
  "fleetSettings.thisEndsThisClientSAccessToThisHost":
    "This ends this client’s access to this Host. It must pair again to reconnect.",
  "fleetSettings.revokeClient": "Revoke client",
  "fleetSettings.cancel3": "Cancel",
  "fleetSettings.readOnly": "Read only",
  "fleetSettings.threadControl": "Thread control",
  "fleetSettings.remoteHistory": "Remote history",
  "fleetSettings.excerptShown": "Excerpt shown",
  "fleetSettings.noHistoryItemsReturned": "No history items returned",
  "pluginSettings.loadingPlugins": "Loading plugins…",
  "pluginSettings.marketplace": "Marketplace",
  "pluginSettings.searchPlugins": "Search plugins",
  "pluginSettings.searchPlugins2": "Search plugins",
  "pluginSettings.searchNamePurposeOrPackage":
    "Search name, purpose, or package",
  "pluginSettings.clear": "Clear",
  "pluginSettings.pluginFilters": "Plugin filters",
  "pluginSettings.installFromSource": "Install from source…",
  "pluginSettings.installFromSource2": "Install from source",
  "pluginSettings.advancedPackageCodeIsTrustedToRunOnThis":
    "Advanced: package code is trusted to run on this computer after validation.",
  "pluginSettings.source": "Source",
  "pluginSettings.pluginSource": "Plugin source",
  "pluginSettings.npmRegistry": "npm registry",
  "pluginSettings.gitCommitPinned": "Git (commit pinned)",
  "pluginSettings.localDirectoryCopy": "Local directory copy",
  "pluginSettings.developmentLink": "Development link",
  "pluginSettings.packageOrPath": "Package or path",
  "pluginSettings.externalCatalogUnavailable": "External catalog unavailable",
  "pluginSettings.localPluginsRemainManageable":
    "Local plugins remain manageable.",
  "pluginSettings.retry": "Retry",
  "pluginSettings.loadingPlugins2": "Loading plugins…",
  "pluginSettings.noPluginsFound": "No plugins found",
  "pluginSettings.plugins": "Plugins",
  "pluginSettings.updateAvailable": "Update available",
  "pluginSettings.pluginDetails": "Plugin details",
  "pluginSettings.couldNotLoadThisPlugin": "Could not load this plugin.",
  "pluginSettings.errorDetails": "Error details",
  "pluginSettings.version": "version",
  "pluginSettings.reviewAccess": "Review access",
  "pluginSettings.closeDetails": "Close details",
  "pluginSettings.cancel": "Cancel",
  "pluginAccessReview.accessAndSetup": "Access and setup",
  "pluginAccessReview.enablingThePluginMakesItsToolsAvailableToAgents":
    "Enabling the plugin makes its tools available to agents. It does not grant access in macOS or connect Chrome.",
  "pluginAccessReview.refreshStatus": "Refresh status",
  "pluginAccessReview.requestedAccess": "Requested access",
  "pluginAccessReview.thisAppVersionCannotShowTheSelectedProviderS":
    "This app version cannot show the selected provider’s complete access list. Update ZenX before enabling it.",
  "pluginAccessReview.accessibility": "Accessibility",
  "pluginAccessReview.openAccessibilitySettings": "Open Accessibility settings",
  "pluginAccessReview.screenRecording": "Screen Recording",
  "pluginAccessReview.openScreenRecordingSettings":
    "Open Screen Recording settings",
  "pluginAccessReview.foregroundControl": "Foreground control",
  "pluginAccessReview.openGeneralSettings": "Open General settings",
  "pluginAccessReview.completeMacosSetup": "Complete macOS setup",
  "pluginAccessReview.inSystemSettingsPrivacySecurityAccessibilityTurnOnThe":
    "In System Settings → Privacy & Security → Accessibility, turn on the current ZenX app. If it is absent, click Add (+) and choose the ZenX.app you launched.",
  "pluginAccessReview.inScreenSystemAudioRecordingTurnOnZenxFor":
    "In Screen & System Audio Recording, turn on ZenX for screen access. If absent, click Add (+) and choose the same app.",
  "pluginAccessReview.relaunchZenxIfMacosAsksThenReturnHereZenx":
    "Relaunch ZenX if macOS asks, then return here. ZenX checks both access paths again when this page opens.",
  "pluginAccessReview.openBrowserSettings": "Open Browser settings",
  "chromeConnectionSettings.browser": "Browser",
  "chromeConnectionSettings.chooseWhereBrowserToolsWork":
    "Choose where Browser tools work.",
  "chromeConnectionSettings.browserMode": "Browser mode",
  "chromeConnectionSettings.zenxBrowser": "ZenX browser",
  "chromeConnectionSettings.connectedChrome": "Connected Chrome",
  "chromeConnectionSettings.changingThisModeTakesEffectAfterRestartingZenx":
    "Changing this mode takes effect after restarting ZenX.",
  "chromeConnectionSettings.1RegisterTheLocalConnector":
    "1. Register the local connector",
  "chromeConnectionSettings.letChromeConnectToThisInstalledZenxApp":
    "Let Chrome connect to this installed ZenX app.",
  "chromeConnectionSettings.2LoadTheZenxExtension":
    "2. Load the ZenX extension",
  "chromeConnectionSettings.openChromeExtensionsEnableDeveloperModeChooseLoadUnpacked":
    "Open chrome://extensions, enable Developer mode, choose Load unpacked, then select the folder opened here.",
  "chromeConnectionSettings.3ConnectYourBrowser": "3. Connect your browser",
  "chromeConnectionSettings.clickTheZenxExtensionOnceInChromeExistingAnd":
    "Click the ZenX extension once in Chrome. Existing and new web tabs become available without connecting each tab. Click the extension again to disconnect the whole browser.",
  "chromeConnectionSettings.keepUsingYourUsualChromeWindowsAndSignedIn":
    "Keep using your usual Chrome windows and signed-in pages. You and the Agent work in the same tabs; the sidebar shows the Agent’s latest view. Closing ZenX or disabling the extension ends the connection.",
  "contextCompactionPanel.contextCompaction": "Context compaction",
  "contextCompactionPanel.controlWhenHistoryIsSummarizedAndWhichOriginalItems":
    "Control when history is summarized and which original items the model keeps.",
  "contextCompactionPanel.agenticCompactionExperiment":
    "Agentic compaction experiment",
  "contextCompactionPanel.agenticCompactionExperimental":
    "Agentic compaction · Experimental",
  "contextCompactionPanel.enableAgenticCompaction": "Enable Agentic compaction",
  "contextCompactionPanel.enableAgenticCompactionExperimental":
    "Enable Agentic compaction (experimental)",
  "contextCompactionPanel.letTheAgentChooseWhenToReplaceItsWorking":
    "Let the agent choose when to replace its working context during a task. It writes continuation notes, saves details to files, and reads them when needed. Complete conversation history stays available to you.",
  "contextCompactionPanel.theSummaryPromptAndRetentionRulesBelowApplyTo":
    "The summary prompt and retention rules below apply to generated summaries, not to the agent’s own continuation text. Automatic compaction keeps its existing behavior.",
  "contextCompactionPanel.compactionBudget": "Compaction budget",
  "contextCompactionPanel.triggerAndBudget": "Trigger and budget",
  "contextCompactionPanel.compactionTrigger": "Compaction trigger (%)",
  "contextCompactionPanel.postCompactionBudget": "Post-compaction budget (%)",
  "contextCompactionPanel.percentagesUseTheSelectedModelSContextWindowThe":
    "Percentages use the selected model’s context window. The post-compaction budget covers both the summary and retained original items and cannot exceed the trigger. Token and image costs are estimates.",
  "contextCompactionPanel.automaticCompactionRunsAtCompletedTurnBoundariesOrBefore":
    "Automatic compaction runs at completed-turn boundaries or before the next turn, not during an unfinished turn. Complete history stays available in the conversation.",
  "contextCompactionPanel.retentionRules": "Retention rules",
  "contextCompactionPanel.originalItemsToRetain": "Original items to retain",
  "contextCompactionPanel.retentionMode": "Retention mode",
  "contextCompactionPanel.fillTheTokenBudgetWithRecentItems":
    "Fill the token budget with recent items",
  "contextCompactionPanel.keepTheMostRecentNItems":
    "Keep the most recent N items",
  "contextCompactionPanel.keepOnlyTheTypesSelectedBelow":
    "Keep only the types selected below",
  "contextCompactionPanel.numberOfRecentItems": "Number of recent items",
  "contextCompactionPanel.last10Items": "Last 10 items",
  "contextCompactionPanel.last20Items": "Last 20 items",
  "contextCompactionPanel.howOriginalItemsAreCounted":
    "How original items are counted",
  "contextCompactionPanel.itemsIncludeUserAndAgentMessagesReasoningToolCalls":
    "Items include user and agent messages, reasoning, tool calls, and tool results. Execution markers do not count. Related tool items are kept together, so the actual count can be higher. Budget mode fills from the latest completed turn; the count and type rules consider the full history.",
  "contextCompactionPanel.preserveAllUserMessages":
    "Preserve all user messages",
  "contextCompactionPanel.preserveAllUserMessages2":
    "Preserve all user messages",
  "contextCompactionPanel.agentFinalMessages": "Agent final messages",
  "contextCompactionPanel.noAdditionalFinalMessages":
    "No additional final messages",
  "contextCompactionPanel.preserveAllFinalMessages":
    "Preserve all final messages",
  "contextCompactionPanel.preserveTheMostRecentNFinalMessages":
    "Preserve the most recent N final messages",
  "contextCompactionPanel.numberOfFinalMessages": "Number of final messages",
  "contextCompactionPanel.aFinalMessageIsTheFinalAgentReplyOf":
    "A final message is the final agent reply of a successfully completed turn. Intermediate tool commentary and partial replies from failed turns do not count.",
  "contextCompactionPanel.howRetentionRulesCombine":
    "How retention rules combine",
  "contextCompactionPanel.theseRulesCombineSelectingUserMessagesOrFinalReplies":
    "These rules combine: selecting user messages or final replies adds them to the retained items. Explicitly retained items will not be silently dropped to fit the budget; if they cannot fit, compaction reports a failure. Selecting no types in the last mode keeps only the summary.",
  "contextCompactionPanel.compactionInstruction": "Compaction instruction",
  "contextCompactionPanel.summaryInstruction": "Summary instruction",
  "contextCompactionPanel.compactionPrompt": "Compaction prompt",
  "contextCompactionPanel.replacesTheDefaultInstructionPreserveGoalsDecisionsConstraintsUnfinished":
    "Replaces the default instruction. Preserve goals, decisions, constraints, unfinished work, identifiers, and important tool outcomes. Ask for a summary without tool calls.",
  "contextCompactionPanel.restoreDefaultPrompt": "Restore default prompt",
  "contextCompactionPanel.resetAllCompactionSettings":
    "Reset all compaction settings",
  "workflowSettingsPanel.workflows": "Workflows",
  "workflowSettingsPanel.createUserScopedSlashCommandsThatExpandIntoMessage":
    "Create user-scoped Slash commands that expand into message drafts. Review or edit the expanded prompt before sending it.",
  "workflowSettingsPanel.slashCommands": "Slash commands",
  "workflowSettingsPanel.namesUseLowercaseLettersNumbersAndHyphensCompactIs":
    "Names use lowercase letters, numbers, and hyphens. /compact is built in and cannot be replaced. Use",
  "workflowSettingsPanel.whereTypedArgumentsShouldAppear":
    "where typed arguments should appear.",
  "workflowSettingsPanel.addCommand": "Add command",
  "workflowSettingsPanel.noCustomSlashCommands": "No custom Slash commands.",
  "workflowSettingsPanel.enabled": "Enabled",
  "workflowSettingsPanel.delete": "Delete",
  "workflowSettingsPanel.name": "Name",
  "workflowSettingsPanel.description": "Description",
  "workflowSettingsPanel.prompt": "Prompt",
  "workflowSettingsPanel.threadTitlePrompt": "Thread title prompt",
  "workflowSettingsPanel.use": "Use",
  "workflowSettingsPanel.forTheFirstRequestThisAuxiliaryPromptIsNot":
    "for the first request. This auxiliary prompt is not added to the Thread conversation.",
  "workflowSettingsPanel.restoreDefault": "Restore default",
  "workflowSettingsPanel.prompt2": "Prompt",
  "skillsSettingsPanel.skills": "Skills",
  "skillsSettingsPanel.importInstructionsAndTheirResourcesManualSkillsStayOut":
    "Import instructions and their resources. Manual Skills stay out of model context until you choose them from the slash menu.",
  "skillsSettingsPanel.importASkill": "Import a Skill",
  "skillsSettingsPanel.chooseADirectoryContainingSkillMdZenKeepsA":
    "Choose a directory containing SKILL.md. Zen keeps a complete local copy; the original is never modified.",
  "skillsSettingsPanel.skillDirectory": "Skill directory",
  "skillsSettingsPanel.absoluteDirectoryPath": "Absolute directory path",
  "skillsSettingsPanel.browse": "Browse…",
  "skillsSettingsPanel.loadingSkills": "Loading Skills…",
  "skillsSettingsPanel.findASkill": "Find a Skill ·",
  "skillsSettingsPanel.imported": "imported",
  "skillsSettingsPanel.nameDescriptionOrSource": "Name, description or source",
  "skillsSettingsPanel.automaticModeSharesOnlyNameDescriptionAndLocationUp":
    "Automatic mode shares only name, description and location (up to",
  "skillsSettingsPanel.kibTotalInstructionsLoadWhenUsedDisabledSkillsCannot":
    "KiB total). Instructions load when used. Disabled Skills cannot be selected or loaded.",
  "skillsSettingsPanel.noSkillsImported": "No Skills imported",
  "skillsSettingsPanel.yourModelReceivesNoSkillsMetadataImportADirectory":
    "Your model receives no Skills metadata. Import a directory to make it available in the slash menu.",
  "skillsSettingsPanel.effectiveMode": "Effective mode ·",
  "skillsSettingsPanel.manualUse": "Manual use",
  "skillsSettingsPanel.automaticallyVisible": "Automatically visible",
  "skillsSettingsPanel.disabled": "Disabled",
  "skillsSettingsPanel.sourceAndConfiguration": "Source and configuration",
  "skillsSettingsPanel.importedFrom": "Imported from:",
  "skillsSettingsPanel.localCopy": "Local copy:",
  "skillsSettingsPanel.yourOverrideTakesPrecedenceOverAgentsZenYamlThen":
    "Your override takes precedence over agents/zen.yaml, then the manual default. Changes apply to future sends; previously loaded history stays intact.",
  "skillsSettingsPanel.usePackageDefault": "Use package default",
  "subscriptionUsageCard.subscriptionUsage": "Subscription usage",
  "subscriptionUsageCard.subscriptionUsage2": "Subscription usage",
  "subscriptionUsageCard.quotaWindowsForTheChatgptAccountSignedInTo":
    "Quota windows for the ChatGPT account signed in to ZenX.",
  "subscriptionUsageCard.refreshSubscriptionUsage":
    "Refresh subscription usage",
  "subscriptionUsageCard.signInWithOpenaiToViewYourSubscriptionUsage":
    "Sign in with OpenAI to view your subscription usage.",
  "subscriptionUsageCard.loadingSubscriptionUsage":
    "Loading subscription usage…",
  "subscriptionUsageCard.couldNotLoadUsageCheckYourConnectionOrSign":
    "Could not load usage. Check your connection or sign in again, then refresh.",
  "subscriptionUsageCard.updated": "Updated",
  "rtkSettingsCard.rtkExperiment": "RTK experiment",
  "rtkSettingsCard.compactShellOutput": "Compact shell output",
  "rtkSettingsCard.experimentalRtk": "Experimental · RTK",
  "rtkSettingsCard.reduceRepetitiveTestOutputSentToTheModelWhile":
    "Reduce repetitive test output sent to the model while keeping the original output available to read back.",
  "rtkSettingsCard.compactShellOutputWithRtk": "Compact shell output with RTK",
  "rtkSettingsCard.appleSiliconMacsCargoTestOnlyCommandsRunAs":
    "Apple silicon Macs · cargo test only. Commands run as usual. Shell output inside run_code stays unchanged.",
  "settingsView.loadingLocalSettings": "Loading local settings…",
  "settingsView.arrowup": "ArrowUp",
  "settingsView.arrowdown": "ArrowDown",
  "settingsView.arrowleft": "ArrowLeft",
  "settingsView.arrowright": "ArrowRight",
  "settingsView.home": "Home",
  "settingsView.end": "End",
  "settingsView.compactShellOutput": "Compact shell output",
  "settingsView.appSettings": "App settings",
  "settingsView.messageSending": "Message sending",
  "settingsView.unsavedChangesAcrossSettingsRunningTurnsKeepTheirCurrent":
    "Unsaved changes across settings. Running turns keep their current configuration.",
  "settingsView.unsavedSendingPreferenceRunningTurnsContinueUninterrupted":
    "Unsaved sending preference. Running turns continue uninterrupted.",
  "settingsView.yourSettingsAreUpToDate": "Your settings are up to date.",
  "settingsView.applying": "Applying…",
  "settingsView.apply": "Apply",
  "settingsView.unavailableJournal": "Unavailable journal",
  "settingsView.restoring": "Restoring…",
  "settingsView.unarchive": "Unarchive",
  "settingsView.notConfigured": "Not configured",
  "settingsView.signedIn": "Signed in",
  "settingsView.notSignedIn": "Not signed in",
  "settingsView.accountConnected": "Account connected",
  "settingsView.connectAnAccount": "Connect an account",
  "settingsView.addAnOpenaiSubscriptionInModelsProviderToGet":
    "Add an OpenAI subscription in Models & provider to get started.",
  "settingsView.yourSignInDetailsAreStoredSecurelyOnThis":
    "Your sign-in details are stored securely on this device.",
  "settingsView.signInToConnectYourSubscription":
    "Sign in to connect your subscription.",
  "settingsView.waitingForBrowser": "Waiting for browser…",
  "settingsView.signInWithOpenai": "Sign in with OpenAI",
  "settingsView.defaultModel": "Default model",
  "settingsView.titleModel": "Title model",
  "settingsView.oneSubscriptionAccountIsAlreadyConfigured":
    "One subscription account is already configured",
  "settingsView.usesTheSignInManagedInAccount":
    "Uses the sign-in managed in Account",
  "settingsView.thisBuiltInProviderIsAlreadyConfigured":
    "This built-in Provider is already configured",
  "settingsView.openaiCompatibleApiPreset": "OpenAI-compatible API preset",
  "settingsView.providerAdded": "Provider added",
  "settingsView.providerSaved": "Provider saved",
  "settingsView.providerDeleted": "Provider deleted",
  "settingsView.addProviderProfile": "Add Provider profile",
  "settingsView.aProviderCanHaveAtMost1024Models":
    "A Provider can have at most 1,024 models. Remove models before saving.",
  "settingsView.waitForTheProviderLogoToFinishLoading":
    "Wait for the Provider Logo to finish loading",
  "settingsView.chooseAReplacementDefaultModel":
    "Choose a replacement default model",
  "settingsView.chooseAReplacementTitleModel":
    "Choose a replacement title model",
  "settingsView.displayName": "Display name",
  "settingsView.providerName": "Provider name",
  "settingsView.baseUrl": "Base URL",
  "settingsView.apiKey": "API key",
  "settingsView.apiKeySavedLeaveBlankToKeep":
    "API key saved — leave blank to keep",
  "settingsView.required": "Required",
  "settingsView.chooseAPngJpegOrWebpProviderLogo":
    "Choose a PNG, JPEG, or WebP Provider Logo",
  "settingsView.providerLogoMustBeAtMost512Kib":
    "Provider Logo must be at most 512 KiB",
  "settingsView.fetchTheOfficialCodexModelCatalog":
    "Fetch the official Codex model catalog",
  "settingsView.fetchModelIdsFromThisProvider":
    "Fetch model IDs from this Provider",
  "settingsView.saveAnApiKeyBeforeDiscovery":
    "Save an API key before discovery",
  "settingsView.officialCatalogIsUnchangedUsingTheLocalCache":
    "Official catalog is unchanged; using the local cache.",
  "settingsView.officialMetadataUpdatedInTheDraftSaveProviderTo":
    "Official metadata updated in the draft. Save provider to apply.",
  "settingsView.fetchingModels": "Fetching models…",
  "settingsView.getAvailableModels": "Get available models",
  "settingsView.chooseAdditionalModelsOfficialMetadataIsUpdatedInThe":
    "Choose additional models. Official metadata is updated in the draft; manual settings are preserved. Save provider to apply.",
  "settingsView.selectTheModelsYouWantExistingModelsAndTheir":
    "Select the models you want. Existing models and their settings stay unchanged.",
  "settingsView.sendingOneTinyImageTestRequestProviderChargesMay":
    "Sending one tiny image test request; Provider charges may apply…",
  "settingsView.imageProbeSucceededSupportWasSaved":
    "Image probe succeeded; support was saved.",
  "settingsView.providerExplicitlyRejectedImageInputUnsupportedWasSaved":
    "Provider explicitly rejected image input; unsupported was saved.",
  "settingsView.imageProbeWasInconclusiveCapabilityRemainsUnknown":
    "Image probe was inconclusive; capability remains Unknown.",
  "settingsView.replacementDefaultModel": "Replacement default model",
  "settingsView.replacementTitleModel": "Replacement title model",
  "settingsView.adding": "Adding…",
  "settingsView.saving": "Saving…",
  "settingsView.saveProvider": "Save provider",
  "settingsView.testingImageSupport": "Testing image support…",
  "settingsView.testImageSupport": "Test image support",
  "settingsView.deleting": "Deleting…",
  "settingsView.deleteProvider": "Delete provider",
  "settingsView.lightPreset": "Light preset",
  "settingsView.darkPreset": "Dark preset",
  "settingsView.optedIn": "Opted in",
  "settingsView.blocked": "Blocked",
  "settingsView.noProjectConfigured": "No project configured",
  "settingsView.enterAWholeNumberOf1OrMore":
    "Enter a whole number of 1 or more.",
  "settingsView.couldNotOpenDiagnosticsFolder":
    "Could not open diagnostics folder.",
  "fleetSettings.loadingFleet": "Loading Fleet…",
  "fleetSettings.fleetConfigurationChangedWhileYouWereEditingCancelThe":
    "Fleet configuration changed while you were editing. Cancel the device editor or discard hosting changes, then refresh before saving.",
  "fleetSettings.fleetStatusRefreshed": "Fleet status refreshed",
  "fleetSettings.notChecked": "Not checked",
  "fleetSettings.checking": "Checking…",
  "fleetSettings.connectionFailed": "Connection failed",
  "fleetSettings.connected": "Connected",
  "fleetSettings.escape": "Escape",
  "fleetSettings.deviceId": "Device ID",
  "fleetSettings.label": "Label",
  "fleetSettings.sshHost": "SSH host",
  "fleetSettings.commandArgumentsOnePerLine":
    "Command arguments (one per line)",
  "fleetSettings.httpsEndpoint": "HTTPS endpoint",
  "fleetSettings.remoteHostId": "Remote Host ID",
  "fleetSettings.workspaceIdOptional": "Workspace ID (optional)",
  "fleetSettings.oneTimePairingCode2": "One-time pairing code",
  "fleetSettings.saving": "Saving…",
  "fleetSettings.pairDevice": "Pair device",
  "fleetSettings.saveDevice": "Save device",
  "fleetSettings.deviceRemoved": "Device removed",
  "fleetSettings.controlEnabled": "Control enabled",
  "fleetSettings.chooseAWorkspace": "Choose a workspace",
  "fleetSettings.allWorkspaces": "All workspaces",
  "fleetSettings.workspaceSelectedForThisDevice":
    "Workspace selected for this device",
  "fleetSettings.chooseAWorkspaceToBrowseItsThreads":
    "Choose a workspace to browse its Threads",
  "fleetSettings.noThreadsInThisWorkspace": "No Threads in this workspace",
  "fleetSettings.messageAcceptedByTheRemoteHostWorkMayStill":
    "Message accepted by the remote Host. Work may still be running; refresh to check its reply.",
  "fleetSettings.messageToRemoteThread": "Message to remote Thread",
  "fleetSettings.hostingEnabled": "Hosting enabled",
  "fleetSettings.hostingDisabled": "Hosting disabled",
  "fleetSettings.registeredNotConnected": "Registered · not connected",
  "fleetSettings.notRegistered": "Not registered",
  "fleetSettings.bindAddress": "Bind address",
  "fleetSettings.port": "Port",
  "fleetSettings.tlsCertificateFile": "TLS certificate file",
  "fleetSettings.tlsPrivateKeyFile": "TLS private key file",
  "fleetSettings.androidFacingHttpsEndpoint": "Android-facing HTTPS endpoint",
  "fleetSettings.relayEndpointOptional": "Relay endpoint (optional)",
  "fleetSettings.relayRegistrationToken": "Relay registration token",
  "fleetSettings.savedInBackendLeaveBlankToKeepIt":
    "Saved in backend; leave blank to keep it",
  "fleetSettings.enterTheTrustedRelaySRegistrationToken":
    "Enter the trusted relay’s registration token",
  "fleetSettings.maximumClientAccess": "Maximum client access",
  "fleetSettings.enterABindAddressAPortFrom165535":
    "Enter a bind address, a port from 1–65535 and existing TLS certificate/key file paths.",
  "fleetSettings.useAnHttpsRelayOriginWithoutAPathQuery":
    "Use an HTTPS relay origin without a path, query, fragment or embedded credentials.",
  "fleetSettings.enterTheTrustedRelayEndpointBeforeItsRegistrationToken":
    "Enter the trusted relay endpoint before its registration token.",
  "fleetSettings.useAnExactHttpsHostnameOrIpv4AddressWith":
    "Use an exact HTTPS hostname or IPv4 address with the listener’s explicit port for Android. The Host will verify the certificate SAN.",
  "fleetSettings.hostingConfigurationSaved": "Hosting configuration saved",
  "fleetSettings.applyHosting": "Apply hosting",
  "fleetSettings.revoked": "Revoked",
  "fleetSettings.paired": "Paired",
  "fleetSettings.clientRevoked": "Client revoked",
  "fleetSettings.item": "Item",
  "pluginSettings.all": "All",
  "pluginSettings.installed": "Installed",
  "pluginSettings.builtIn": "Built in",
  "pluginSettings.installing": "Installing…",
  "pluginSettings.chooseTarball": "Choose tarball…",
  "pluginSettings.installSource": "Install source",
  "pluginSettings.noPluginsMatchThisFilter": "No plugins match this filter.",
  "pluginSettings.tryADifferentSearch": "Try a different search.",
  "pluginSettings.install": "Install",
  "pluginSettings.reinstalling": "Reinstalling…",
  "pluginSettings.reinstall": "Reinstall",
  "pluginSettings.applying": "Applying…",
  "pluginSettings.disable": "Disable",
  "pluginSettings.enable": "Enable",
  "pluginSettings.updating": "Updating…",
  "pluginSettings.opening": "Opening…",
  "pluginSettings.update": "Update…",
  "pluginSettings.uninstall": "Uninstall",
  "pluginSettings.removeThePluginKeepItsSavedData":
    "Remove the plugin; keep its saved data.",
  "pluginSettings.deleteData": "Delete data",
  "pluginSettings.disableThePluginBeforeDeletingItsData":
    "Disable the plugin before deleting its data.",
  "pluginSettings.permanentlyDeleteThisPluginSSavedData":
    "Permanently delete this plugin’s saved data.",
  "pluginSettings.uninstallThisPluginAndItsToolsItsDataStays":
    "Uninstall this plugin and its tools. Its data stays on this device.",
  "pluginSettings.permanentlyDeleteThisPluginSSavedDataYourConversations":
    "Permanently delete this plugin's saved data. Your conversations and other plugins will be kept.",
  "pluginSettings.confirmUninstall": "Confirm uninstall",
  "pluginSettings.confirmDeleteData": "Confirm delete data",
  "pluginAccessReview.checking": "Checking…",
  "pluginAccessReview.unknown": "Unknown",
  "pluginAccessReview.allowedByMacos": "Allowed by macOS",
  "pluginAccessReview.needsSetup": "Needs setup",
  "pluginAccessReview.notApplicable": "Not applicable",
  "pluginAccessReview.zenxChecksWhetherItsNativeHelperCanInspectOpen":
    "ZenX checks whether its native helper can inspect open windows. No window details are saved by this check.",
  "pluginAccessReview.zenxChecksASmallWindowPreviewAndDiscardsIt":
    "ZenX checks a small window preview and discards it. If Screen Recording is already on, reopen ZenX; if still blocked, remove its old entry and add this ZenX.app again.",
  "pluginAccessReview.optedIn": "Opted in",
  "pluginAccessReview.offOptional": "Off (optional)",
  "pluginAccessReview.globalPointerKeyboardFocusAndScrollingRequireASeparate":
    "Global pointer, keyboard, focus and scrolling require a separate opt-in. Background-safe actions do not.",
  "pluginAccessReview.connectedChrome": "Connected Chrome",
  "pluginAccessReview.zenxBrowser": "ZenX browser",
  "pluginAccessReview.statusUnavailable": "Status unavailable",
  "pluginAccessReview.couldNotReadChromeConnectionStateRefreshStatusTo":
    "Could not read Chrome connection state. Refresh status to try again.",
  "chromeConnectionSettings.chromeConnected": "Chrome connected",
  "chromeConnectionSettings.chromeNotConnected": "Chrome not connected",
  "chromeConnectionSettings.removing": "Removing…",
  "chromeConnectionSettings.removeConnector": "Remove connector",
  "chromeConnectionSettings.registering": "Registering…",
  "chromeConnectionSettings.registerConnector": "Register connector",
  "chromeConnectionSettings.opening": "Opening…",
  "chromeConnectionSettings.showExtensionFolder": "Show extension folder",
  "chromeConnectionSettings.waitingForChrome": "Waiting for Chrome",
  "workflowSettingsPanel.describeWhatThisWorkflowDoes":
    "Describe what this workflow does",
  "workflowSettingsPanel.usingTheZenxDefault": "Using the ZenX default",
  "workflowSettingsPanel.customPrompt": "Custom prompt",
  "skillsSettingsPanel.skillImportedCheckItsEffectiveModeBelow":
    "Skill imported. Check its effective mode below.",
  "skillsSettingsPanel.saving": "Saving…",
  "skillsSettingsPanel.importSkill": "Import Skill",
  "skillsSettingsPanel.yourOverride": "Your override",
  "skillsSettingsPanel.packagePolicy": "Package policy",
  "skillsSettingsPanel.default": "Default",
  "skillsSettingsPanel.userOverrideRemoved": "User override removed.",
  "subscriptionUsageCard.refreshing": "Refreshing…",
  "subscriptionUsageCard.refresh": "Refresh",
  "subscriptionUsageCard.planNotProvided": "Plan not provided",
  "subscriptionUsageCard.remainingNotProvided": "Remaining not provided",
  "subscriptionUsageCard.usageNotProvided": "Usage not provided",
  "subscriptionUsageCard.resetTimeNotProvided": "Reset time not provided",
  "rtkSettingsCard.rtkIsNotIncludedInThisBuild":
    "RTK is not included in this build.",
  "rtkSettingsCard.applyToSaveTheChangeTakesEffectNextLaunch":
    "Apply to save. The change takes effect next launch.",
  "rtkSettingsCard.checkApplicationStatusBelowBeforeMakingAnotherChange":
    "Check application status below before making another change.",
  "rtkSettingsCard.offByDefaultChangesTakeEffectNextLaunchRunning":
    "Off by default. Changes take effect next launch; running tasks keep their current behavior.",
  "settingsView.modelsProvider": "Models & provider",
  "settingsView.contextCompaction": "Context compaction",
  "settingsView.skills": "Skills",
  "settingsView.workflows": "Workflows",
  "settingsView.fleet": "Fleet",
  "settingsView.providerSettingsWereSavedButApplyingThemIsUnconfirmed":
    "Provider settings were saved, but applying them is unconfirmed. Check application status before using the provider.",
  "settingsView.providerSettingsWereSavedButFinalizationFailedCheckApplication":
    "Provider settings were saved, but finalization failed. Check application status before using the provider.",
  "settingsView.anotherWindowChangedSettingsThisProviderWasNotSaved":
    "Another window changed settings. This provider was not saved. Your edits are still here; reload settings before trying again.",
  "settingsView.thisProviderWasNotSavedReviewItsConnectionAnd":
    "This provider was not saved. Review its connection and model fields, then try again.",
  "settingsView.thisProviderWasNotSavedCheckApplicationStatusThen":
    "This provider was not saved. Check application status, then try again.",
  "settingsView.couldNotConfirmWhetherThisProviderWasSavedCheck":
    "Could not confirm whether this provider was saved. Check application status before trying again.",
  "settingsView.enterADisplayName": "Enter a display name",
  "settingsView.addAtLeastOneModel": "Add at least one model",
  "settingsView.noId": "no ID",
  "settingsView.enterAProviderName": "Enter a provider name",
  "settingsView.enterAnApiKey": "Enter an API key",
  "settingsView.enterAnApiKeyBecauseThisProfileHasNo":
    "Enter an API key because this profile has no saved key",
  "settingsView.enterAValidBaseUrl": "Enter a valid Base URL",
  "settingsView.baseUrlMustUseHttpsLoopbackHttpIsAllowed":
    "Base URL must use HTTPS (loopback HTTP is allowed)",
  "settingsView.removeCredentialsFromTheBaseUrl":
    "Remove credentials from the Base URL",
  "settingsView.removeTheQueryOrFragmentFromTheBaseUrl":
    "Remove the query or fragment from the Base URL",
  "settingsView.localTesting": "Local testing",
  "settingsView.clearBlue": "Clear blue",
  "settingsView.softViolet": "Soft violet",
  "settingsView.freshGreen": "Fresh green",
  "settingsView.reasoningUnknown": "reasoning unknown",
  "settingsView.noReasoningStrengthControl2": "no reasoning strength control",
  "settingsView.inputUnknown": "input unknown",
  "settingsView.noInputModalities": "no input modalities",
  "settingsView.contextRequired": "context required",
  "settingsView.settingsSaved": "Settings saved",
  "settingsView.noChanges": "No changes",
  "settingsView.changesAppliedRunningTurnsKeepTheirCurrentConfiguration":
    "Changes applied · running turns keep their current configuration",
  "settingsView.savedApplicationNotYetConfirmedCheckApplicationStatusBefore":
    "Saved · application not yet confirmed. Check application status before saving more changes.",
  "fleetSettings.fleetConnectionIsUnavailable":
    "Fleet connection is unavailable",
  "fleetSettings.useAUniqueDeviceIdOf164Letters":
    "Use a unique device ID of 1–64 letters, numbers, underscores or hyphens; local is reserved.",
  "fleetSettings.thatDeviceIdIsAlreadyConfigured":
    "That device ID is already configured.",
  "fleetSettings.enterADeviceLabel": "Enter a device label.",
  "fleetSettings.confirmRemoteThreadControlBeforeSaving":
    "Confirm remote Thread control before saving.",
  "fleetSettings.enterAnSshHostAndNonEmptyCommandArguments":
    "Enter an SSH host and non-empty command arguments, one per line.",
  "fleetSettings.useAnHttpsEndpointWithoutEmbeddedCredentials":
    "Use an HTTPS endpoint without embedded credentials.",
  "fleetSettings.enterTheRemoteHostIdShownByThatDevice":
    "Enter the remote Host ID shown by that device.",
  "fleetSettings.enterACurrentOneTimePairingCodeFromThe":
    "Enter a current one-time pairing code from the remote Host.",
  "fleetSettings.devicePairedBrowseItToChooseAWorkspace":
    "Device paired. Browse it to choose a workspace.",
  "fleetSettings.deviceSaved": "Device saved",
  "fleetSettings.invalidFleetSettingsResponseRetryAfterCheckingTheHost":
    "Invalid Fleet settings response; retry after checking the Host connection.",
  "fleetSettings.invalidFleetClientListRetryAfterCheckingTheHost":
    "Invalid Fleet client list; retry after checking the Host connection.",
  "pluginSettings.pluginInstalledAndEnabled": "Plugin installed and enabled.",
  "pluginSettings.pluginTarballInstalledAndEnabled":
    "Plugin tarball installed and enabled.",
  "pluginSettings.installedSource": "Installed source",
  "pluginSettings.localDirectorySnapshot": "Local directory snapshot",
  "pluginSettings.appResourcePackage": "App Resource package",
  "pluginAccessReview.thisAppVersionCannotReadCurrentSetupStatus":
    "This app version cannot read current setup status.",
  "pluginAccessReview.notRequested": "Not requested",
  "pluginAccessReview.checkFailed": "Check failed",
  "pluginAccessReview.couldNotVerify": "Could not verify",
  "pluginAccessReview.noChromeSetupNeeded": "No Chrome setup needed",
  "pluginAccessReview.externalEndpointConfigured":
    "External endpoint configured",
  "pluginAccessReview.connectorUnavailable": "Connector unavailable",
  "pluginAccessReview.chromeNotConnected": "Chrome not connected",
  "pluginAccessReview.checkingWhichBrowserModeZenxIsUsing":
    "Checking which browser mode ZenX is using.",
  "pluginAccessReview.usesASeparateZenxBrowserSessionNoChromeConnector":
    "Uses a separate ZenX browser session. No Chrome connector or macOS desktop permission is needed.",
  "pluginAccessReview.theConnectedChromeConnectorIsNotRunningApplyThe":
    "The Connected Chrome connector is not running. Apply the browser mode and restart ZenX, then check Browser settings.",
  "pluginAccessReview.registerTheLocalConnectorLoadTheExtensionThenClick":
    "Register the local connector, load the extension, then click it in Chrome. General settings shows each step.",
  "subscriptionUsageCard.quotaWindow": "Quota window",
  "rtkSettingsCard.unavailable": "Unavailable",
  "rtkSettingsCard.unsavedChange": "Unsaved change",
  "rtkSettingsCard.applicationUnconfirmed": "Application unconfirmed",
  "rtkSettingsCard.restartRequired": "Restart required",
  "rtkSettingsCard.on": "On",
  "rtkSettingsCard.off": "Off",
  "settingsView.addNamedProvider": "Add {{name}}",
  "settingsView.editNamedProvider": "Edit {{name}}",
  "settingsView.deleteNamedProvider": "Delete {{name}}",
  "settingsView.moreModels_one":
    "You can add {{count}} more model (1,024 max).",
  "settingsView.selectNamedModel": "Select {{name}}",
  "settingsView.addedModels_one":
    "Added {{count}} model to the draft. Save provider to apply.",
  "settingsView.modelNumber": "Model {{number}}",
  "settingsView.removeModelNumber": "Remove model {{number}}",
  "settingsView.modelNumberDisplayName": "Model {{number}} display name",
  "settingsView.modelNumberDescription": "Model {{number}} description",
  "settingsView.modelNumberReasoningMetadata":
    "Model {{number}} reasoning metadata",
  "settingsView.modelNumberReasoningEfforts":
    "Model {{number}} reasoning efforts",
  "settingsView.modelNumberDefaultReasoningEffort":
    "Model {{number}} default reasoning effort",
  "settingsView.modelNumberInputModalities":
    "Model {{number}} input modalities",
  "settingsView.modelNumberContextWindowRequired":
    "Model {{number}} context window (Required)",
  "settingsView.modelNumberEnterId": "Model {{number}}: enter a model ID",
  "settingsView.modelNumberIdTooLong":
    "Model {{number}}: model ID must be 512 characters or fewer",
  "settingsView.savedPendingRestart":
    "Saved · {{fields}} takes effect next launch",
  "settingsView.settingsFinalizationFailed":
    "Settings were saved, but finalization failed: {{error}}",
  "settingsView.settingsMutationOutcomeUnknown":
    "Settings mutation failed: {{error}}. Authoritative state could not be reconciled: {{reason}}. Outcome is unknown.",
  "settingsView.moreModels_other":
    "You can add {{count}} more models (1,024 max).",
  "settingsView.addedModels_other":
    "Added {{count}} models to the draft. Save provider to apply.",
  "fleetSettings.testDevice": "Test {{name}}",
  "fleetSettings.browseDevice": "Browse {{name}}",
  "fleetSettings.editDevice": "Edit {{name}}",
  "fleetSettings.readThread": "Read {{name}}",
  "pluginSettings.managePlugin": "Manage {{name}}",
  "pluginSettings.continueEnabling": "Continue enabling {{name}}",
  "pluginSettings.confirmAction": "Confirm {{action}}",
  "pluginSettings.installVersion": "Install v{{version}}",
  "pluginSettings.updateVersion": "Update to v{{version}}",
  "skillsSettingsPanel.modeForSkill": "Mode for {{name}} ({{id}})",
  "workflowSettingsPanel.commandNumberName": "Command {{number}} name",
  "workflowSettingsPanel.commandNumberDescription":
    "Command {{number}} description",
  "workflowSettingsPanel.commandNumberPrompt": "Command {{number}} prompt",
  "pluginProductPage.namedCommands": "{{name}} commands",
  "rtkSettingsCard.savedStateRestart":
    "Saved {{state}}. Use Safe restart when tasks are idle, or relaunch ZenX later.",
  "rtkSettingsCard.onLower": "on",
  "rtkSettingsCard.offLower": "off",
  "subscriptionUsageCard.plan": "{{name}} plan",
  "subscriptionUsageCard.percentRemaining": "{{value}}% remaining",
  "subscriptionUsageCard.percentUsed": "{{value}}% used",
  "subscriptionUsageCard.windowRemaining": "{{name}} remaining",
  "subscriptionUsageCard.resets": "Resets {{time}}",
  "subscriptionUsageCard.dayWindow_one": "{{count}}-day window",
  "subscriptionUsageCard.dayWindow_other": "{{count}}-day window",
  "subscriptionUsageCard.hourWindow_one": "{{count}}-hour window",
  "subscriptionUsageCard.hourWindow_other": "{{count}}-hour window",
  "subscriptionUsageCard.minuteWindow_one": "{{count}}-minute window",
  "subscriptionUsageCard.minuteWindow_other": "{{count}}-minute window",
  "subscriptionUsageCard.secondWindow_one": "{{count}}-second window",
  "subscriptionUsageCard.secondWindow_other": "{{count}}-second window",
  "settingsView.neutral": "Neutral",
  "settingsView.cool": "Cool",
  "settingsView.warm": "Warm",
  "settingsView.modelLimitReached":
    "Model limit reached (1,024). Remove a model to add another.",
  "settingsView.apiKeySaved": "API key saved",
  "settingsView.apiKeyNotSaved": "API key not saved",
  "settingsView.openaiCompatibleApi": "OpenAI-compatible API",
  "fleetSettings.sendingCanInterrupt":
    "Sending can run work on {{name}} and interrupt its current task.",
  "fleetSettings.sendingCanRunWork": "Sending can run work on {{name}}.",
  "fleetSettings.codeExpires": " · Expires {{time}}",
  "fleetSettings.shortLivedCode": " · Short-lived; use it now",
  "fleetSettings.access": "Access",
  "pluginAccessReview.allowed": "Allowed",
  "pluginAccessReview.verified": "Verified",
  "pluginAccessReview.connected": "Connected",
  "pluginAccessReview.externalChromeEndpoint":
    "ZenX is using an externally configured Chrome debugging endpoint. Check that endpoint if tabs are missing.",
  "pluginSettings.commitPinnedGit": "Commit-pinned Git",
  "pluginSettings.tarball": "Tarball",
  "pluginSettings.enabled": "Enabled",
  "pluginSettings.disabled": "Disabled",
  "pluginSettings.uninstalled": "Uninstalled",
  "pluginSettings.available": "Available",
  "pluginSettings.unavailable": "Unavailable",
  "settingsView.providerGlobalRoles": "{{name}} global roles",
  "settingsView.modelRow": "Model {{number}} ({{id}})",
  "settingsView.modelRowUniqueId": "{{row}}: use a unique model ID",
  "settingsView.modelRowNeedReasoning":
    "{{row}}: enter at least one supported reasoning effort",
  "settingsView.modelRowUniqueReasoning":
    "{{row}}: use each reasoning effort only once",
  "settingsView.modelRowDefaultReasoning":
    "{{row}}: choose a default from the supported reasoning efforts",
  "settingsView.modelRowPositiveContext":
    "{{row}}: enter a positive whole number for context window",
  "fleetSettings.androidConnectionsFrom":
    ", including Android connections from {{endpoint}}",
  "fleetSettings.throughRelay":
    " through {{endpoint}}, whose operator can see relayed credentials and messages",
  "pluginSettings.capabilityRefreshFailed":
    "{{success}} Agent capability refresh failed: {{error}}",
  "pluginSettings.namedVersionInstalled":
    "{{name}} v{{version}} installed and enabled.",
  "pluginSettings.namedVersionUpdated": "{{name}} updated to v{{version}}.",
  "pluginSettings.namedInstalled": "{{name}} installed and enabled.",
  "pluginSettings.namedToggled": "{{name}} {{state}}.",
  "pluginSettings.namedUpdated": "{{name}} updated successfully.",
  "pluginSettings.namedAccessDetails": "{{name}} access details",
  "pluginSettings.namedUninstalled": "{{name}} uninstalled. Its data was kept.",
  "pluginSettings.namedDataDeleted": "{{name}} data deleted.",
  "pluginSettings.disabledLower": "disabled",
  "pluginSettings.enabledLower": "enabled",
  "pluginAccessReview.namedAccessSetup": "{{name}} access and setup",
  "pluginAccessReview.chromeTabsAvailable_one":
    "{{count}} Chrome tab available. Agents and you use the same signed-in tabs.",
  "pluginAccessReview.chromeTabsAvailable_other":
    "{{count}} Chrome tabs available. Agents and you use the same signed-in tabs.",
  "chromeConnectionSettings.tabsAvailable_one": "{{count}} tab available",
  "chromeConnectionSettings.tabsAvailable_other": "{{count}} tabs available",
  "skillsSettingsPanel.namedModeSaved": "{{name}} mode saved.",
  "fleetSettings.removeNamedDevice": "Remove {{name}}",
  "fleetSettings.revokeNamedClient": "Revoke {{name}}",
  "workflowSettingsPanel.commandNameHelp":
    "Names use lowercase letters, numbers, and hyphens. /compact is built in and cannot be replaced. Use {{placeholder}} where typed arguments should appear.",
  "workflowSettingsPanel.titlePromptHelp":
    "Use {{placeholder}} for the first request. This auxiliary prompt is not added to the Thread conversation.",
  "skillsSettingsPanel.findImportedSkills_one":
    "Find a Skill · {{count}} imported",
  "skillsSettingsPanel.findImportedSkills_other":
    "Find a Skill · {{count}} imported",
  "skillsSettingsPanel.automaticModeHelp":
    "Automatic mode shares only name, description and location (up to {{kib}} KiB total). Instructions load when used. Disabled Skills cannot be selected or loaded.",
  "settingsView.contextTokens": "{{value}} context",
} as const;

export const zhCN: Record<keyof typeof en, string> = {
  "fleetComposer.catalogFailedPreserved":
    "{{error}} 你的文字已保留，没有改用本机。",
  "fleetComposer.snapshotChecked": "快照检查时间：{{time}}",
  "fleetComposer.operationFailedInspect":
    "{{error}} 请先检查所选远程机器，再尝试操作。没有自动重试任何操作。",
  "fleetComposer.earlierOperationUncertain":
    "先前在 {{deviceId}} 上执行的 Fleet 操作结果尚不确定：{{error}}。请先检查该机器，再重试。",
  "fleetComposer.acceptedAfterLeaving":
    "离开该视图后，机器 {{deviceId}} 上的会话 {{threadId}} 已接收消息。接收消息不代表任务已完成。",
  "fleetComposer.messageAccepted":
    "{{deviceId}} 已接收消息；目标机器可能仍在运行任务",
  "fleetComposer.acceptedSnapshotUnavailable":
    "{{deviceId}} 已接收消息，但无法获取最新快照：{{error}}。请刷新查看；没有重试发送消息。",
  "fleetComposer.machineLocked":
    "机器已锁定 · {{deviceId}} · 会话 {{threadId}}",
  "fleetComposer.localCatalogUnavailable": "Fleet 目录不可用：{{error}}",
  "fleetComposer.newConversationOn": "在 {{name}} 上创建新会话",
  "fleetComposer.modelDefault": "{{name}} · 默认",
  "fleetComposer.snapshotScope":
    "{{deviceId}} · {{route}} · {{workspace}} · {{status}}。这是经检查的公开快照，并非远程历史的完整本地副本。",
  "fleetComposer.verifiedSshRoute": "已验证的 SSH 路由",
  "fleetComposer.notChecked": "尚未检查",
  "fleetComposer.snapshotUnavailable": "不可用 · 上次快照可能已过时",
  "fleetComposer.unknownStatus": "未知",
  "fleetComposer.createDescription":
    "创建会话会使用目标机器当前的默认设置和所选 Zen 模型。首先创建空闲会话；发送消息才会开始任务。",
  "fleetComposer.attachmentWarning":
    "此远程入口仅支持文字。发送前请移除本地图片或附件，或返回“本机”；没有丢弃任何内容。",
  "fleetComposer.createdAfterLeaving":
    "离开草稿后，已在 {{deviceId}} 上创建远程会话 {{threadId}}；请先检查该会话，再创建其他会话。没有发送任何消息。",
  "fleetComposer.inspectOutcome":
    "需要检查操作结果。请刷新远程会话，或重新打开该机器的目录；自动重试已禁用。",
  "fleetComposer.machine": "机器",
  "fleetComposer.thisMachine": "本机",
  "fleetComposer.machineOwnsThread": "会话及其权限由所选机器管理",
  "fleetComposer.remoteConversation": "远程会话",
  "fleetComposer.targetPermissions":
    "使用目标机器的权限和模型。本地会话保持不变。",
  "fleetComposer.reloadCatalog": "重新加载目标目录",
  "fleetComposer.loadingCatalog": "正在加载该机器的工作区和模型…",
  "fleetComposer.targetWorkspace": "目标工作区",
  "fleetComposer.chooseWorkspace": "选择目标工作区",
  "fleetComposer.newThreadModel": "新会话使用的模型",
  "fleetComposer.chooseModel": "选择目标模型",
  "fleetComposer.targetReasoning": "目标推理强度",
  "fleetComposer.targetDefault": "目标默认设置",
  "fleetComposer.openExistingThread": "打开已有远程会话",
  "fleetComposer.createOrChooseThread": "创建新会话，或选择已有会话",
  "fleetComposer.refreshThread": "刷新远程会话",
  "fleetComposer.history": "远程会话历史",
  "fleetComposer.readOnly": "此机器为只读；你可以查看已有会话。",
  "fleetComposer.messageToThread": "发送给远程会话的消息",
  "fleetComposer.taskForMachine": "远程机器的任务",
  "fleetComposer.messageBehavior": "远程消息行为",
  "fleetComposer.guidance": "添加指导",
  "fleetComposer.followUp": "将后续任务加入队列",
  "fleetComposer.replacement": "中断并替换",
  "fleetComposer.sending": "正在发送至目标…",
  "fleetComposer.send": "发送至远程会话",
  "fleetComposer.start": "在所选机器上开始",
  "fleetComposer.newDraft": "在此机器上创建新草稿",
  "fleetComposer.returnLocal": "返回本机",
  "fleetOnboarding.invitationExpired":
    "此邀请已过期。请向目标机器的用户索取新邀请。",
  "fleetOnboarding.invitationExpiredRetry": "此邀请已过期。请索取新邀请。",
  "fleetOnboarding.invalidMachineId":
    "机器 ID 只能使用字母、数字、连字符或下划线。",
  "fleetOnboarding.duplicateMachineId":
    "此机器 ID 已配置。请选择其他 ID，或检查已有设备。",
  "fleetOnboarding.machineNameRequired": "请输入机器名称。",
  "fleetOnboarding.pairedChecking": "已配对。正在检查该机器…",
  "fleetOnboarding.pairedCheckFailed":
    "已配对，但连接检查失败。已保存的信任关系仍然保留；解决错误后，请对该设备执行“测试”。",
  "fleetOnboarding.issuerExpired":
    "邀请已过期。请在另一位用户准备好后创建新邀请。",
  "fleetOnboarding.clientsRefreshFailed":
    "无法刷新已配对客户端。再次分享前，请检查 Fleet 状态。",
  "fleetOnboarding.sharingScopeChanged":
    "Fleet 主机或分享范围已变更。分享新邀请前，请刷新、检查并重新确认。",
  "fleetOnboarding.clipboardUnavailable":
    "剪贴板不可用。请选择邀请字段，再使用系统的“复制”操作。",
  "fleetOnboarding.pairedReachable":
    "已配对且可访问：{{name}}。这只是一次连接检查，并非持续的在线会话。",
  "fleetOnboarding.setupDescription":
    "请让那台机器上的 Agent 检查 Fleet 是否已就绪。由该机器的用户创建邀请，然后在这里检查并配对。",
  "fleetOnboarding.endpointRequirement":
    "目标机器必须已有可信且可访问的 HTTPS 端点，或已配置中继。处于无关联网络的机器无法自动发现彼此。邀请只能在此设置页面中使用；请勿粘贴到 Agent 会话中。",
  "fleetOnboarding.preparePrompt":
    "可以这样询问：“检查这台机器的 Fleet 是否已就绪，并说明缺少什么。仅准备不含秘密信息的设置。托管和配对须由我批准。”",
  "fleetOnboarding.readinessDescription":
    "所有 Agent 都可使用内置 Fleet 插件。已有的禁用设置和常规工具权限仍然有效。只读的就绪检查工具会报告已知设备和准备步骤；它不能安装证书、配置网络或建立信任关系。",
  "fleetOnboarding.loopbackWarning":
    "这是回环地址，只能访问接收邀请的这台计算机；连接另一台机器时，请使用已配置的网络端点。",
  "fleetOnboarding.verifyHostDescription":
    "请直接在目标机器上或通过可信渠道核实此主机 ID。HTTPS 证书检查仍然生效。描述仅用于指导 Agent 使用机器，不能授予访问权限。服务器授予的只读权限必须重新配对后才能升级。",
  "fleetOnboarding.shellConsent":
    "允许明确授权、范围受限的远程 Shell，沿用目标会话现有的沙盒和审批",
  "fleetOnboarding.issuerDescription":
    "请通过私密且可信的渠道分享邀请。邀请包含端点和主机 ID，五分钟后过期，且只能使用一次。创建新邀请会替换原有配对码。请勿将邀请放入 Agent 会话或日志。",
  "fleetOnboarding.issuerEndpointDescription":
    "请使用已配置的客户端端点、已连接的中继，或此主机的监听地址。DNS、网络连通性和可信 TLS 必须已就绪。回环监听地址只能在同一台计算机上使用。",
  "fleetOnboarding.connectMachine": "连接另一台机器",
  "fleetOnboarding.useInvitation": "使用邀请",
  "fleetOnboarding.prepareWithAgent": "与 Agent 一起准备",
  "fleetOnboarding.checkSetup": "检查本机设置",
  "fleetOnboarding.invitation": "邀请",
  "fleetOnboarding.reviewInvitation": "检查邀请",
  "fleetOnboarding.cancelInvitation": "取消邀请",
  "fleetOnboarding.reviewMachineInvitation": "检查机器邀请",
  "fleetOnboarding.machineId": "机器 ID",
  "fleetOnboarding.machineName": "机器名称",
  "fleetOnboarding.machineDescription": "机器描述",
  "fleetOnboarding.access": "访问权限",
  "fleetOnboarding.invitationAccess": "邀请访问权限",
  "fleetOnboarding.readOnly": "只读",
  "fleetOnboarding.threadControl": "会话控制",
  "fleetOnboarding.pairing": "正在配对…",
  "fleetOnboarding.pairAndCheck": "配对并检查",
  "fleetOnboarding.inviteClient": "邀请客户端",
  "fleetOnboarding.invitationEndpoint": "邀请端点",
  "fleetOnboarding.invitationMachineName": "邀请中的机器名称",
  "fleetOnboarding.creating": "正在创建…",
  "fleetOnboarding.createInvitation": "创建邀请",
  "fleetOnboarding.shareInvitation": "分享邀请",
  "fleetOnboarding.copied": "已复制",
  "fleetOnboarding.copyInvitation": "复制邀请",
  "fleetOnboarding.hideInvitation": "隐藏邀请",
  "fleetOnboarding.readinessSummary":
    "凭证存储：{{credentialStore}} · 托管：{{hosting}} · 可信端点：{{endpoint}}",
  "fleetOnboarding.credentialsReady": "就绪",
  "fleetOnboarding.credentialsNeedEncryption": "需要操作系统加密",
  "fleetOnboarding.hostRunning": "运行中",
  "fleetOnboarding.hostNotRunning": "未运行",
  "fleetOnboarding.endpointConfigured": "已配置",
  "fleetOnboarding.endpointNeedsConfiguration": "需要配置",
  "fleetOnboarding.hostId": "主机 ID：{{hostId}}",
  "fleetOnboarding.endpoint": "端点：{{endpoint}}",
  "fleetOnboarding.expiresAt": "到期时间：{{time}}",
  "fleetOnboarding.shareExpiryWarning":
    "{{time}} 到期。任何持有此邀请的人都能请求访问。隐藏邀请会清除此页面上的内容；一次性配对码在使用、替换或到期前仍然有效。",
  "fleetOnboarding.trustRead":
    "我已核实此主机，并允许此应用保存可撤销的只读连接",
  "fleetOnboarding.trustReadShell":
    "我已核实此主机，并允许此应用保存可撤销的只读连接，包含明确授权的远程 Shell",
  "fleetOnboarding.trustControl":
    "我已核实此主机，并允许此应用保存可撤销的会话控制连接",
  "fleetOnboarding.trustControlShell":
    "我已核实此主机，并允许此应用保存可撤销的会话控制连接，包含明确授权的远程 Shell",
  "fleetOnboarding.shareRead": "我允许一个持有此邀请的客户端请求只读访问权限",
  "fleetOnboarding.shareReadRelay":
    "我允许一个持有此邀请的客户端通过我信任的中继运营者请求只读访问权限",
  "fleetOnboarding.shareReadShell":
    "我允许一个持有此邀请的客户端请求只读访问权限，并明确选择启用远程 Shell",
  "fleetOnboarding.shareReadShellRelay":
    "我允许一个持有此邀请的客户端通过我信任的中继运营者请求只读访问权限，并明确选择启用远程 Shell",
  "fleetOnboarding.shareControl":
    "我允许一个持有此邀请的客户端请求会话控制访问权限",
  "fleetOnboarding.shareControlRelay":
    "我允许一个持有此邀请的客户端通过我信任的中继运营者请求会话控制访问权限",
  "fleetOnboarding.shareControlShell":
    "我允许一个持有此邀请的客户端请求会话控制访问权限，并明确选择启用远程 Shell",
  "fleetOnboarding.shareControlShellRelay":
    "我允许一个持有此邀请的客户端通过我信任的中继运营者请求会话控制访问权限，并明确选择启用远程 Shell",
  "fleetOnboarding.thisMachine": "本机",
  "fleetOnboarding.invalidInvitation": "Fleet 邀请无效",
  "fleetOnboarding.invalidInvitationExpiry": "Fleet 邀请的到期时间无效",
  "fleetOnboarding.parsedInvitationExpired": "Fleet 邀请已过期；请索取新邀请",
  "fleetOnboarding.invalidInvitationEndpoint":
    "Fleet 邀请端点无效；请使用单一 HTTPS 源地址",
  "fleetOnboarding.configuredPeersOnly":
    "仅发现用户已配置的对等端；不会自动扫描网络、寻找连接端或配对。",
  "fleetOnboarding.httpsReachability":
    "直接 HTTPS 连接需要客户端信任的证书，以及到主机的网络路由。监听状态和带时间戳的检查不能证明客户端当前可访问。",
  "fleetOnboarding.networkPreparation":
    "不同网络之间需要用户安排路由或 VPN，或使用已配置且可访问的中继。Fleet 不会配置路由器、VPN、证书或中继。",
  "fleetOnboarding.relayTrust":
    "中继是受信任的 TLS 终止点，可看到配对、请求和事件；中继传输并非端到端加密。",
  "fleetOnboarding.invitationLimits":
    "邀请是仅供人工使用的持有者秘密，五分钟内过期，且只能配对一次。控制和 Shell 访问仍受主机与客户端授权范围限制。",
  "fleetHistory.readPrompt": "读取远程会话以查看其公开历史",
  "fleetHistory.emptyHistory": "未返回历史记录",
  "fleetHistory.privateReasoning": "不显示私有推理内容",
  "fleetHistory.you": "你",
  "fleetHistory.agent": "Agent",
  "fleetHistory.item": "记录项",
  "fleetHistory.remoteAttachment": "远程附件",
  "fleetHistory.boundedExcerpt": "截取的片段",
  "fleetHistory.remoteImage": "[远程图片附件]",
  "fleetHistory.completed": "已完成",
  "fleetHistory.turnStatus": "轮次 {{status}}",
  "fleetHistory.modelUsage":
    "用量 · 输入 {{inputTokens}} / 输出 {{outputTokens}} token",
  "fleetHistory.threadMetadata": "会话元数据",
  "fleetHistory.threadForked": "会话已分支",
  "fleetHistory.threadInstruction": "会话指令",
  "fleetHistory.threadConfigurationChanged": "会话配置已变更",
  "fleetHistory.contextCompaction": "上下文压缩",
  "fleetHistory.turnStarted": "轮次已开始",
  "fleetHistory.turnAborted": "轮次已中止",
  "fleetHistory.turnReplacementRequested": "已请求替换轮次",
  "fleetHistory.userMessageQueued": "用户消息已加入队列",
  "fleetHistory.userMessageQueueCancelled": "排队的用户消息已取消",
  "fleetHistory.reasoning": "推理",
  "fleetHistory.toolCall": "工具调用",
  "fleetHistory.toolResult": "工具结果",
  "fleetHistory.codeState": "代码状态",
  "fleetHistory.failure": "失败",
  "fleetComposer.statusActive": "运行中",
  "fleetComposer.statusIdle": "空闲",
  "fleetHistory.statusCompleted": "已完成",
  "fleetHistory.statusFailed": "失败",
  "fleetHistory.statusInterrupted": "已中断",
  "fleetHistory.statusInProgress": "进行中",

  "pluginSettings.namedActions": "{{name}} 操作",

  "fleetSettings.routeIdentityMissing":
    "缺少 Fleet 路由标识。请刷新 Fleet 后再浏览此设备。",
  "fleetSettings.exactThreadUnavailable":
    "目标远端会话不可用；未选择任何其他会话。",
  "fleetSettings.chooseTargetWorkspace": "列出会话前，请先选择此目标的工作区。",
  "fleetSettings.routeChanged":
    "此设备的路由或访问权限已变更。请重新打开浏览后再发送；原远端会话未被重定向。",
  "fleetSettings.workspaceSelectedReopen":
    "工作区已选择。请重新打开浏览并检查此路由后再发送。",
  "fleetSettings.hostRefreshFailed": "无法刷新 Fleet 托管状态。",
  "fleetSettings.routeHelp":
    "SSH 使用现有 SSH 配置。HTTPS 使用固定 Host ID 和一次性配对码。可达性是带时间戳的检查；测试连接随后关闭，不代表持续会话。",
  "fleetSettings.machineDescription": "机器说明",
  "fleetSettings.machineDescriptionHelp":
    "描述此机器的用途以及 Agent 应在何时使用它。这仅作为指引，不会授予权限或更改命令。",
  "fleetSettings.requestShell":
    "为此 HTTPS 设备请求由目标管理的远端 Shell 执行",
  "fleetSettings.shellHelp":
    "Shell 需在此客户端及远端 Host 上分别明确启用。它使用现有目标会话的当前沙箱和已记录的批准，不使用本地权限。未知的交互批准无法远端处理，请求将被拒绝。启用服务器授予的 Shell 权限需重新配对；仅更改此已保存的请求选项不能扩大权限。",
  "fleetSettings.clientHttpsEndpoint": "客户端访问的 HTTPS 端点",
  "fleetSettings.allowShell":
    "允许单独配对的 Shell 客户端在此 Host 上请求有范围限制的命令",
  "fleetSettings.hostShellHelp":
    "远端 Shell 需要新的独立客户端授权，并需明确授权工作区和目标会话。适用该会话的当前沙箱和批准；现有只读或旧授权不会获得 Shell 权限。不支持远端交互批准。",
  "fleetSettings.includingShell": "，包括单独授权的目标管理 Shell 执行",
  "fleetSettings.advancedPairingCode": "高级：单独配对码",
  "fleetSettings.shellGranted": " · 已授予 Shell 权限",
  "fleetSettings.noShellGrant": " · 未授予 Shell 权限",
  "fleetSettings.checkedTime": " · 检查时间 {{time}}",
  "fleetSettings.reachable": "可达",
  "fleetSettings.lastCheckFailed": "上次检查失败",

  "settingsView.zenxSettings": "ZenX 设置",
  "settingsView.openSidebar": "打开侧边栏",
  "settingsView.settings": "设置",
  "settingsView.makeZenxYourOwn": "按你的习惯配置 ZenX",
  "settingsView.settingsSections": "设置分类",
  "settingsView.plugins": "插件",
  "settingsView.manageThePluginsAvailableInZenx": "管理ZenX中可用的插件。",
  "settingsView.checkApplicationStatus": "检查应用状态",
  "settingsView.retryApplyingSavedSettings": "重试应用保存的设置",
  "settingsView.saved": "已保存·",
  "settingsView.takesEffectNextLaunch": "下次启动时生效",
  "settingsView.safeRestart": "安全重启",
  "settingsView.archivedThreads": "已归档会话",
  "settingsView.restoreAnArchivedConversationToReturnItToThe":
    "恢复已归档的会话，使其重新出现在侧边栏。",
  "settingsView.loadingArchivedConversations": "正在加载已归档会话…",
  "settingsView.tryAgain": "重试",
  "settingsView.noArchivedConversationsConversationsYouArchiveWillAppearHere":
    "暂无已归档会话。归档的会话会显示在这里。",
  "settingsView.account": "账户",
  "settingsView.openaiSubscription": "OpenAI 订阅",
  "settingsView.connectYourChatgptSubscriptionToUseItsModels":
    "连接您的ChatGPT 订阅以使用其模型。",
  "settingsView.signOut": "退出登录",
  "settingsView.modelsProviders": "模型与服务商",
  "settingsView.connectYourProvidersAndChooseTheModelsYouWant":
    "连接您的服务商并选择您想要使用的模型。",
  "settingsView.defaultModels": "默认模型",
  "settingsView.chooseAModelForNewConversationsAndAnotherFor":
    "为新会话选择默认模型，并另选一个用于生成会话名称的模型。",
  "settingsView.newWork": "新会话",
  "settingsView.existingConversationsKeepTheirModelYouCanChangeIt":
    "现有会话继续使用原模型。你可以随时在消息输入框中更改。",
  "settingsView.providerProfiles": "服务商配置",
  "settingsView.manageEachConnectionAndItsAvailableModels":
    "管理每个连接及其可用模型。",
  "settingsView.addProvider": "添加服务商",
  "settingsView.addCustomProvider": "添加自定义服务商",
  "settingsView.addAKnownProvider": "添加已知服务商",
  "settingsView.chooseABuiltInConnectionPresetCustomApisUse":
    "选择内置连接预设。自定义 API 请使用单独的自定义流程。",
  "settingsView.addOpenaiSubscription": "添加OpenAI 订阅",
  "settingsView.openaiSubscription2": "OpenAI 订阅",
  "settingsView.addLocalDemo": "添加本地演示",
  "settingsView.localDemo": "本地演示",
  "settingsView.deterministicFakeDevProviderForLocalTesting":
    "用于本地测试的确定性模拟服务商",
  "settingsView.cancel": "取消",
  "settingsView.default": "默认",
  "settingsView.title": "标题",
  "settingsView.edit": "编辑",
  "settingsView.delete": "删除",
  "settingsView.cancel2": "取消",
  "settingsView.checkTheseFields": "检查这些字段",
  "settingsView.providerLogo": "服务商徽标",
  "settingsView.providerLogoPngJpegOrWebpUpTo512":
    "服务商徽标（PNG、JPEG 或 WebP；单张不超过 512 KiB 和 1024 × 1024；总计不超过 4 MiB）",
  "settingsView.removeLogo": "移除徽标",
  "settingsView.storedKeysAreNeverShownEnterAValueOnly":
    "从不显示存储的密钥。仅输入一个值以添加或替换此配置文件的密钥。",
  "settingsView.authenticationIsManagedByTheExistingOpenaiSignIn":
    "身份验证由“账户”中的 OpenAI 登录管理。",
  "settingsView.localDemoWorksOfflineAndDoesNotNeedAn":
    "本地演示离线工作，不需要API 密钥。",
  "settingsView.modelCatalog": "模型目录",
  "settingsView.chooseTheModelsAvailableFromThisProviderOrAdd":
    "选择此服务商提供的模型，或手动添加一个。",
  "settingsView.availableModels": "可用模型",
  "settingsView.chooseModelsToAdd": "选择要添加的模型",
  "settingsView.searchAvailableModels": "搜索可用模型",
  "settingsView.alreadyAdded": "已添加",
  "settingsView.noMatchingModels": "没有匹配的模型。",
  "settingsView.cancelSelection": "取消选择",
  "settingsView.addSelectedModels": "添加所选模型（",
  "settingsView.remove": "移除",
  "settingsView.addModel": "添加模型",
  "settingsView.modelLimitReached1024RemoveAModelTo":
    "已达到模型上限（1,024 个）。请先移除一个模型，再添加新模型。",
  "settingsView.selectAModel": "选择一个模型",
  "settingsView.selectAModel2": "选择一个模型",
  "settingsView.cancel3": "取消",
  "settingsView.unknown": "未知",
  "settingsView.noReasoningStrengthControl": "无推理强度控制",
  "settingsView.manualConfiguration": "手动配置",
  "settingsView.lowMediumHigh": "低、中、高",
  "settingsView.chooseADefault": "选择默认值",
  "settingsView.unknown2": "未知",
  "settingsView.text": "文本",
  "settingsView.textImage": "文字+图片",
  "settingsView.imageOnly": "仅图片",
  "settingsView.knownUnsupported": "已知不受支持",
  "settingsView.eG128000": "例如：128000",
  "settingsView.useTheModelProviderSPublishedTokenLimit":
    "使用模型服务商的已发布令牌限制。",
  "settingsView.hideThisModelFromNormalSelection": "从正常选择中隐藏此模型",
  "settingsView.delete2": "删除",
  "settingsView.removeThisProviderAndItsSavedCredentialsExistingConversations":
    "删除此服务商及其保存的凭据。现有对话保留其模型选择。",
  "settingsView.addAnotherProviderBeforeDeletingTheOnlyProfile":
    "在删除唯一配置文件之前添加另一个服务商。",
  "settingsView.selectAModel3": "选择一个模型",
  "settingsView.selectAModel4": "选择一个模型",
  "settingsView.cancel4": "取消",
  "settingsView.appearance": "外观",
  "settingsView.themeColorAndContrast": "主题、颜色和对比度。",
  "settingsView.themeAndColor": "主题和颜色",
  "settingsView.chooseHowZenxFeelsWhileKeepingEverySurfaceIn":
    "选择 ZenX 的外观，并使所有界面保持一致。",
  "settingsView.local": "本地",
  "settingsView.appearanceMode": "外观模式",
  "settingsView.liveAppearancePreview": "实时外观预览",
  "settingsView.accent": "强调色",
  "settingsView.accent2": "强调色",
  "settingsView.contrast": "对比度",
  "settingsView.changesApplyImmediatelySystemFollowsYourOperatingSystemLight":
    "更改立即应用。系统跟随您的操作系统；浅色和深色记住单独的预设。",
  "settingsView.resetAppearance": "重置外观",
  "settingsView.general": "通用",
  "settingsView.chooseHowZenxWorksWithYouAndYourProjects":
    "选择ZenX如何与您和您的项目合作。",
  "settingsView.interaction": "交互",
  "settingsView.sendWhileAReplyIsRunning": "正在运行回复时发送",
  "settingsView.sendQueuedMessagesTogether": "一起发送排队消息",
  "settingsView.runEachQueuedMessageSeparately": "分别运行每个排队的消息",
  "settingsView.guideTheCurrentReplyDefault": "引导当前回复（默认）",
  "settingsView.interruptAndSend": "中断并发送",
  "settingsView.enterAndTheSendButtonUseThisChoiceCmd":
    "Enter键和发送按钮使用此选项。Cmd/Ctrl + Enter在选择队列选项时引导当前回复，否则将消息排在一起。Shift + Enter可添加新行。此设置不会更改已排队的消息。",
  "settingsView.foregroundComputerControl": "前台电脑控制",
  "settingsView.highImpactAccessToTheDesktopYouAreActively":
    "对您正在使用的桌面具有高影响力的访问权限。",
  "settingsView.allowForegroundTakeover": "允许前台接管",
  "settingsView.thisLetsZenxAgentsMoveThePointerTypeKeys":
    "这允许 ZenX 智能体移动指针、输入按键、切换焦点，或滚动你当前使用的应用。",
  "settingsView.allowForegroundComputerControl": "允许前台计算机控制",
  "settingsView.offByDefaultBrowserAutomationAndBackgroundSafeComputer":
    "默认关闭。浏览器自动化和可在后台安全运行的 Computer 工具不需要此权限。点击“应用”后，智能体可使用的工具才会改变。",
  "settingsView.executionAndPermissions": "执行和权限",
  "settingsView.defaultProject": "默认项目",
  "settingsView.approvalPolicy": "审批策略",
  "settingsView.approvalRequired": "需要批准",
  "settingsView.fullAccess": "完全访问权限",
  "settingsView.toolPresentation": "工具调用方式",
  "settingsView.directAndCodeRecommended": "直接调用与代码（推荐）",
  "settingsView.directToolsOnly": "仅直接调用工具",
  "settingsView.codeOnly": "仅代码",
  "settingsView.chooseHowAgentsUseToolsCallThemDirectlyWrite":
    "选择智能体使用工具的方式：直接调用它们，编写JavaScript以组合它们，或同时使用两者。代码具有与shell命令相同的权限。",
  "settingsView.maximumToolRounds": "最大工具轮次",
  "settingsView.leaveBlankForUnlimitedStopAReplyAfterThis":
    "留空表示不限制。达到此工具调用轮次后停止回复。",
  "settingsView.manageProjectsFromTheSidebar": "从侧边栏管理项目。",
  "settingsView.defaultsApplyToNewRepliesRunningRepliesKeepTheir":
    "默认值适用于新回复。运行中的回复会保留当前设置；会话专属选项优先。",
  "settingsView.localDiagnostics": "本地诊断",
  "settingsView.storedOnThisDeviceAndNeverSharedAutomatically":
    "存储在此设备上，从不自动共享。",
  "settingsView.openDiagnosticsFolder": "打开诊断文件夹",
  "settingsView.authorizationCodeOrRedirectUrl": "授权码或重定向URL",
  "settingsView.continue": "继续",
  "fleetSettings.fleetConnectionIsUnavailableInThisAppBuild":
    "此应用版本暂不支持设备连接。",
  "fleetSettings.retry": "重试",
  "fleetSettings.fleet": "设备",
  "fleetSettings.connectYourZenHostsEachDeviceKeepsItsOwn":
    "连接你的 Zen 主机。每台设备保留各自的工作区、会话和权限。",
  "fleetSettings.refreshFleet": "刷新设备",
  "fleetSettings.devices": "设备",
  "fleetSettings.sshUsesYourExistingSshSetupHttpsUsesA":
    "SSH 使用你现有的连接配置。HTTPS 使用固定的主机 ID 和一次性配对码。",
  "fleetSettings.addDevice": "添加设备",
  "fleetSettings.noRemoteDevicesConfigured": "未配置远程设备",
  "fleetSettings.test": "测试",
  "fleetSettings.browse": "浏览",
  "fleetSettings.edit": "编辑",
  "fleetSettings.remove": "移除",
  "fleetSettings.deviceEditor": "编辑设备",
  "fleetSettings.connection": "连接",
  "fleetSettings.ssh": "SSH",
  "fleetSettings.httpsPairing": "HTTPS配对",
  "fleetSettings.userDeviceOrSshConfigAlias": "user @ device或SSH配置别名",
  "fleetSettings.theseExactArgumentsRunOnTheRemoteDeviceThrough":
    "这些确切的参数通过经过验证的SSH在远程设备上运行。在测试之前，请自行配置SSH密钥和已知主机。",
  "fleetSettings.checkTheHostIdDirectlyOnTheRemoteDevice":
    "请直接在远程设备上核对主机 ID。配对会验证设备身份；保存的凭据留在本应用的受保护后端。若要更改端点或身份，请移除此设备并重新配对。本地访问设置不能扩大服务器授予的只读权限；若要升级为会话控制，请移除设备并选择“会话控制”重新配对，远程主机也必须允许。",
  "fleetSettings.iAllowZenxToCreateThreadsAndSendMessages":
    "我允许 ZenX 在此远程设备上创建会话并发送可执行任务的消息",
  "fleetSettings.cancel": "取消",
  "fleetSettings.remove2": "移除",
  "fleetSettings.thisRemovesTheSavedConnectionFromThisAppRemote":
    "这会从本应用移除保存的连接。远程会话仍保留在对应主机上。若要终止此应用在远程主机上的权限，请在远程主机上撤销授权。",
  "fleetSettings.removeDevice": "移除设备",
  "fleetSettings.cancel2": "取消",
  "fleetSettings.remoteWorkspacesAndThreads": "远程工作区和会话·",
  "fleetSettings.closeBrowser": "关闭浏览器",
  "fleetSettings.remoteWorkspace": "远程工作区",
  "fleetSettings.refreshThreads": "刷新会话",
  "fleetSettings.useSelectedWorkspace": "使用所选工作区",
  "fleetSettings.read": "读取",
  "fleetSettings.moreThreads": "更多会话",
  "fleetSettings.remoteThread": "远程会话",
  "fleetSettings.readOlderItems": "读取更早的条目",
  "fleetSettings.messageBehavior": "消息处理方式",
  "fleetSettings.addGuidanceToCurrentWork": "补充当前任务的指引",
  "fleetSettings.queueNextWork": "将新任务排队",
  "fleetSettings.interruptAndReplaceCurrentWork": "中断并替换当前任务",
  "fleetSettings.sendingCanRunWorkOn": "发送可以运行工作",
  "fleetSettings.sendToRemoteThread": "发送到远程会话",
  "fleetSettings.hostThisDevice": "托管此设备",
  "fleetSettings.allowPairedDesktopAndMobileClientsToReachThis":
    "允许配对的桌面和移动客户端通过HTTPS连接到此主机。",
  "fleetSettings.hostId": "主机 ID ：",
  "fleetSettings.endpoint": "端点：",
  "fleetSettings.relay": "中继：",
  "fleetSettings.enableHttpsHosting": "启用HTTPS托管",
  "fleetSettings.useAnExactCertificateSanHostnameOrIpv4Address":
    "输入证书 SAN 中的准确主机名或 IPv4 地址，并指定与监听器一致的端口，不要在末尾加斜杠。留空时仅允许不带 Origin 的原生客户端；Android WebSocket 客户端需要这个准确的 HTTPS 端点。此设置不会启用浏览器配对或宽泛的 CORS 访问。",
  "fleetSettings.anOptionalSelfHostedRelayTerminatesTlsAndCan":
    "可选的自托管中继会终止 TLS，并可看到经过它的配对码、消息和设备凭据。请使用可信任的运营方；该连接并非端到端加密。注册令牌只保存在受保护后端；留空可保留现有令牌。",
  "fleetSettings.useExistingTlsFilesHostingDoesNotGenerateKeys":
    "使用已有的 TLS 文件。启用托管不会生成密钥，也不会更改防火墙或路由器设置。绑定到回环地址时只有本机可访问；绑定到网络地址时，其他设备可能也能访问此主机。客户端仍需配对。",
  "fleetSettings.iAllowThisHostToListenOn": "我允许此主机监听",
  "fleetSettings.andExposeItsWorkspacesAndThreadsToPairedClients":
    "并向配对的客户端公开其工作区和会话",
  "fleetSettings.iAllowPairedClientsWithControlAccessToCreate":
    "我允许具有控制访问权限的配对客户端创建会话并在此设备上运行工作",
  "fleetSettings.discardChanges": "放弃更改",
  "fleetSettings.createPairingCode": "创建配对码",
  "fleetSettings.oneTimePairingCode": "一次性配对码：",
  "fleetSettings.hostId2": "主机 ID ：",
  "fleetSettings.enterThisCodeAndTheHttpsEndpointOnThe":
    "在要配对的客户端上输入此代码和HTTPS 端点。拥有此代码的任何人都可以申请访问权限，直至代码过期或被使用。",
  "fleetSettings.hideCode": "隐藏代码",
  "fleetSettings.pairedClients": "已配对的客户端",
  "fleetSettings.noPairedClients": "暂无已配对的客户端",
  "fleetSettings.revoke": "撤销",
  "fleetSettings.revoke2": "撤销",
  "fleetSettings.thisEndsThisClientSAccessToThisHost":
    "此操作将终止此客户端对该主机的访问权限。它需要重新配对才能连接。",
  "fleetSettings.revokeClient": "撤销客户端访问权限",
  "fleetSettings.cancel3": "取消",
  "fleetSettings.readOnly": "只读",
  "fleetSettings.threadControl": "螺纹控制",
  "fleetSettings.remoteHistory": "远程历史记录",
  "fleetSettings.excerptShown": "显示摘录",
  "fleetSettings.noHistoryItemsReturned": "未返回历史记录项目",
  "pluginSettings.loadingPlugins": "正在加载插件…",
  "pluginSettings.marketplace": "插件市场",
  "pluginSettings.searchPlugins": "搜索插件",
  "pluginSettings.searchPlugins2": "搜索插件",
  "pluginSettings.searchNamePurposeOrPackage": "搜索名称、用途或软件包",
  "pluginSettings.clear": "清除",
  "pluginSettings.pluginFilters": "插件筛选",
  "pluginSettings.installFromSource": "从来源安装…",
  "pluginSettings.installFromSource2": "从来源安装",
  "pluginSettings.advancedPackageCodeIsTrustedToRunOnThis":
    "高级：验证后，软件包代码将以受信任方式在此电脑上运行。",
  "pluginSettings.source": "来源",
  "pluginSettings.pluginSource": "插件源",
  "pluginSettings.npmRegistry": "npm registry",
  "pluginSettings.gitCommitPinned": "Git（固定提交）",
  "pluginSettings.localDirectoryCopy": "本地目录副本",
  "pluginSettings.developmentLink": "开发链接",
  "pluginSettings.packageOrPath": "软件包或路径",
  "pluginSettings.externalCatalogUnavailable": "外部目录不可用",
  "pluginSettings.localPluginsRemainManageable": "仍可管理本地插件。",
  "pluginSettings.retry": "重试",
  "pluginSettings.loadingPlugins2": "正在加载插件…",
  "pluginSettings.noPluginsFound": "未找到插件",
  "pluginSettings.plugins": "插件",
  "pluginSettings.updateAvailable": "有可用更新",
  "pluginSettings.pluginDetails": "插件详情",
  "pluginSettings.couldNotLoadThisPlugin": "无法加载此插件。",
  "pluginSettings.errorDetails": "错误详情",
  "pluginSettings.version": "版本",
  "pluginSettings.reviewAccess": "查看访问权限",
  "pluginSettings.closeDetails": "关闭详情",
  "pluginSettings.cancel": "取消",
  "pluginAccessReview.accessAndSetup": "访问权限与设置",
  "pluginAccessReview.enablingThePluginMakesItsToolsAvailableToAgents":
    "启用插件后，智能体便可使用其工具。此操作不会授予 macOS 权限或连接 Chrome。",
  "pluginAccessReview.refreshStatus": "刷新状态",
  "pluginAccessReview.requestedAccess": "所需权限",
  "pluginAccessReview.thisAppVersionCannotShowTheSelectedProviderS":
    "当前版本无法显示所选服务商的完整权限列表。请先更新 ZenX，再启用该服务商。",
  "pluginAccessReview.accessibility": "辅助功能",
  "pluginAccessReview.openAccessibilitySettings": "打开“辅助功能”设置",
  "pluginAccessReview.screenRecording": "屏幕录制",
  "pluginAccessReview.openScreenRecordingSettings": "打开屏幕录制设置",
  "pluginAccessReview.foregroundControl": "前台控制",
  "pluginAccessReview.openGeneralSettings": "打开“通用”设置",
  "pluginAccessReview.completeMacosSetup": "完成 macOS 设置",
  "pluginAccessReview.inSystemSettingsPrivacySecurityAccessibilityTurnOnThe":
    "在“系统设置”→“隐私与安全性”→“辅助功能”中启用当前 ZenX 应用。如果列表中没有它，请点击“添加”（+），选择你启动的 ZenX.app。",
  "pluginAccessReview.inScreenSystemAudioRecordingTurnOnZenxFor":
    "在“屏幕与系统音频录制”中启用 ZenX 的屏幕访问权限。如果列表中没有它，请点击“添加”（+），选择同一个应用。",
  "pluginAccessReview.relaunchZenxIfMacosAsksThenReturnHereZenx":
    "如果 macOS 提示，请重新启动 ZenX，然后返回这里。页面打开时，ZenX 会重新检查两项权限。",
  "pluginAccessReview.openBrowserSettings": "打开浏览器设置",
  "chromeConnectionSettings.browser": "浏览器",
  "chromeConnectionSettings.chooseWhereBrowserToolsWork":
    "选择浏览器工具的工作位置。",
  "chromeConnectionSettings.browserMode": "浏览器模式",
  "chromeConnectionSettings.zenxBrowser": "ZenX 浏览器",
  "chromeConnectionSettings.connectedChrome": "已连接的 Chrome",
  "chromeConnectionSettings.changingThisModeTakesEffectAfterRestartingZenx":
    "重新启动ZenX后，更改此模式生效。",
  "chromeConnectionSettings.1RegisterTheLocalConnector": "1. 注册本地连接器",
  "chromeConnectionSettings.letChromeConnectToThisInstalledZenxApp":
    "允许 Chrome 连接到本机安装的 ZenX。",
  "chromeConnectionSettings.2LoadTheZenxExtension": "2. 加载 ZenX 扩展程序",
  "chromeConnectionSettings.openChromeExtensionsEnableDeveloperModeChooseLoadUnpacked":
    "打开 chrome://extensions，启用“开发者模式”，选择“加载已解压的扩展程序”，然后选取此处打开的文件夹。",
  "chromeConnectionSettings.3ConnectYourBrowser": "3. 连接浏览器",
  "chromeConnectionSettings.clickTheZenxExtensionOnceInChromeExistingAnd":
    "在 Chrome 中点击一次 ZenX 扩展程序。现有和新打开的网页标签页都会可用，无需逐个连接。再次点击扩展程序即可断开整个浏览器。",
  "chromeConnectionSettings.keepUsingYourUsualChromeWindowsAndSignedIn":
    "你可以继续使用平常的 Chrome 窗口和已登录的页面。你和智能体共用同一批标签页；侧边栏显示智能体最近看到的页面。关闭 ZenX 或停用扩展程序会断开连接。",
  "contextCompactionPanel.contextCompaction": "上下文压缩",
  "contextCompactionPanel.controlWhenHistoryIsSummarizedAndWhichOriginalItems":
    "设置何时总结历史记录，以及模型保留哪些原始条目。",
  "contextCompactionPanel.agenticCompactionExperiment": "智能体自主压缩实验",
  "contextCompactionPanel.agenticCompactionExperimental":
    "智能体自主压缩 · 实验性",
  "contextCompactionPanel.enableAgenticCompaction": "启用智能体自主压缩",
  "contextCompactionPanel.enableAgenticCompactionExperimental":
    "启用智能体自主压缩（实验性）",
  "contextCompactionPanel.letTheAgentChooseWhenToReplaceItsWorking":
    "让智能体在任务执行期间自行决定何时替换工作上下文。它会编写续接笔记、将细节保存到文件，并在需要时重新读取。你仍可查看完整会话历史。",
  "contextCompactionPanel.theSummaryPromptAndRetentionRulesBelowApplyTo":
    "下方的摘要提示词和保留规则只适用于生成的摘要，不适用于智能体自行编写的续接文本。自动压缩行为保持不变。",
  "contextCompactionPanel.compactionBudget": "压缩预算",
  "contextCompactionPanel.triggerAndBudget": "触发阈值与预算",
  "contextCompactionPanel.compactionTrigger": "压缩触发阈值（%）",
  "contextCompactionPanel.postCompactionBudget": "压缩后预算（%）",
  "contextCompactionPanel.percentagesUseTheSelectedModelSContextWindowThe":
    "百分比按所选模型的上下文窗口计算。压缩后预算同时涵盖摘要和保留的原始条目，且不能超过触发阈值。Token 和图像成本均为估算值。",
  "contextCompactionPanel.automaticCompactionRunsAtCompletedTurnBoundariesOrBefore":
    "自动压缩会在一轮回复完成时或下一轮开始前运行，不会在未完成的回复中执行。完整历史仍可在会话中查看。",
  "contextCompactionPanel.retentionRules": "保留规则",
  "contextCompactionPanel.originalItemsToRetain": "保留的原始条目",
  "contextCompactionPanel.retentionMode": "保留模式",
  "contextCompactionPanel.fillTheTokenBudgetWithRecentItems":
    "用最近的条目填满 Token 预算",
  "contextCompactionPanel.keepTheMostRecentNItems": "保留最近 N 个条目",
  "contextCompactionPanel.keepOnlyTheTypesSelectedBelow":
    "仅保留下面选择的类型",
  "contextCompactionPanel.numberOfRecentItems": "最近条目的数量",
  "contextCompactionPanel.last10Items": "最后10项",
  "contextCompactionPanel.last20Items": "最后20项",
  "contextCompactionPanel.howOriginalItemsAreCounted": "原始条目的计数方式",
  "contextCompactionPanel.itemsIncludeUserAndAgentMessagesReasoningToolCalls":
    "条目包括用户和智能体消息、推理、工具调用及工具结果。执行标记不计入。相关工具条目会一同保留，因此实际数量可能更多。预算模式从最近完成的一轮向前填充；数量和类型规则则考虑完整历史。",
  "contextCompactionPanel.preserveAllUserMessages": "保留所有用户消息",
  "contextCompactionPanel.preserveAllUserMessages2": "保留所有用户消息",
  "contextCompactionPanel.agentFinalMessages": "智能体的最终消息",
  "contextCompactionPanel.noAdditionalFinalMessages": "不额外保留最终回复",
  "contextCompactionPanel.preserveAllFinalMessages": "保留所有最终消息",
  "contextCompactionPanel.preserveTheMostRecentNFinalMessages":
    "保留最近的N条最终消息",
  "contextCompactionPanel.numberOfFinalMessages": "最终回复的数量",
  "contextCompactionPanel.aFinalMessageIsTheFinalAgentReplyOf":
    "最终回复是智能体在一轮成功完成时给出的最后一条回复。中间的工具说明和失败轮次中的部分回复不计入。",
  "contextCompactionPanel.howRetentionRulesCombine": "保留规则如何组合",
  "contextCompactionPanel.theseRulesCombineSelectingUserMessagesOrFinalReplies":
    "这些规则会合并生效：选择保留用户消息或最终回复，会将其加入保留条目。明确保留的条目不会为了适应预算而被静默丢弃；如果预算不足，压缩会报告失败。在最后一种模式中不选择任何类型时，只保留摘要。",
  "contextCompactionPanel.compactionInstruction": "压缩指令",
  "contextCompactionPanel.summaryInstruction": "摘要说明",
  "contextCompactionPanel.compactionPrompt": "压缩提示词",
  "contextCompactionPanel.replacesTheDefaultInstructionPreserveGoalsDecisionsConstraintsUnfinished":
    "替换默认指令。请保留目标、决策、约束、未完成事项、标识符和重要工具结果，并要求生成摘要而不调用工具。",
  "contextCompactionPanel.restoreDefaultPrompt": "恢复默认提示词",
  "contextCompactionPanel.resetAllCompactionSettings": "重置所有压缩设置",
  "workflowSettingsPanel.workflows": "工作流",
  "workflowSettingsPanel.createUserScopedSlashCommandsThatExpandIntoMessage":
    "创建仅供自己使用的斜杠命令，将其展开为消息草稿。发送前可检查或编辑展开后的提示词。",
  "workflowSettingsPanel.slashCommands": "斜杠命令",
  "workflowSettingsPanel.namesUseLowercaseLettersNumbersAndHyphensCompactIs":
    "名称只能使用小写字母、数字和连字符。/compact 是内置命令，不能覆盖。使用",
  "workflowSettingsPanel.whereTypedArgumentsShouldAppear":
    "表示输入参数插入的位置。",
  "workflowSettingsPanel.addCommand": "添加命令",
  "workflowSettingsPanel.noCustomSlashCommands": "暂无自定义斜杠命令。",
  "workflowSettingsPanel.enabled": "已启用",
  "workflowSettingsPanel.delete": "删除",
  "workflowSettingsPanel.name": "名称",
  "workflowSettingsPanel.description": "说明",
  "workflowSettingsPanel.prompt": "提示词",
  "workflowSettingsPanel.threadTitlePrompt": "会话标题提示词",
  "workflowSettingsPanel.use": "使用",
  "workflowSettingsPanel.forTheFirstRequestThisAuxiliaryPromptIsNot":
    "表示首条请求。此辅助提示词不会添加到会话内容中。",
  "workflowSettingsPanel.restoreDefault": "恢复默认值",
  "workflowSettingsPanel.prompt2": "提示词",
  "skillsSettingsPanel.skills": "技能",
  "skillsSettingsPanel.importInstructionsAndTheirResourcesManualSkillsStayOut":
    "导入技能指令及其资源。手动技能只有在你从斜杠菜单选择后才会进入模型上下文。",
  "skillsSettingsPanel.importASkill": "导入技能",
  "skillsSettingsPanel.chooseADirectoryContainingSkillMdZenKeepsA":
    "选择包含 SKILL.md 的目录。Zen 会保留完整的本地副本，不会修改原始目录。",
  "skillsSettingsPanel.skillDirectory": "技能目录",
  "skillsSettingsPanel.absoluteDirectoryPath": "绝对目录路径",
  "skillsSettingsPanel.browse": "浏览…",
  "skillsSettingsPanel.loadingSkills": "正在加载技能…",
  "skillsSettingsPanel.findASkill": "查找技能·",
  "skillsSettingsPanel.imported": "已导入",
  "skillsSettingsPanel.nameDescriptionOrSource": "名称、描述或来源",
  "skillsSettingsPanel.automaticModeSharesOnlyNameDescriptionAndLocationUp":
    "自动模式仅共享名称、描述和位置（总计最多",
  "skillsSettingsPanel.kibTotalInstructionsLoadWhenUsedDisabledSkillsCannot":
    "KiB）。使用时才会加载指令。已禁用的技能无法选择或加载。",
  "skillsSettingsPanel.noSkillsImported": "未导入技能",
  "skillsSettingsPanel.yourModelReceivesNoSkillsMetadataImportADirectory":
    "模型尚未收到任何技能元数据。导入目录后，就可以从斜杠菜单使用。",
  "skillsSettingsPanel.effectiveMode": "有效模式·",
  "skillsSettingsPanel.manualUse": "手动使用",
  "skillsSettingsPanel.automaticallyVisible": "自动可见",
  "skillsSettingsPanel.disabled": "已禁用",
  "skillsSettingsPanel.sourceAndConfiguration": "源和配置",
  "skillsSettingsPanel.importedFrom": "导入自：",
  "skillsSettingsPanel.localCopy": "本地副本：",
  "skillsSettingsPanel.yourOverrideTakesPrecedenceOverAgentsZenYamlThen":
    "你的覆盖设置优先于 agents/zen.yaml，其次是手动模式默认值。更改仅影响后续发送；已加载的历史保持不变。",
  "skillsSettingsPanel.usePackageDefault": "使用软件包默认值",
  "subscriptionUsageCard.subscriptionUsage": "订阅使用情况",
  "subscriptionUsageCard.subscriptionUsage2": "订阅使用情况",
  "subscriptionUsageCard.quotaWindowsForTheChatgptAccountSignedInTo":
    "查看当前在 ZenX 登录的 ChatGPT 账户的额度窗口。",
  "subscriptionUsageCard.refreshSubscriptionUsage": "刷新订阅使用情况",
  "subscriptionUsageCard.signInWithOpenaiToViewYourSubscriptionUsage":
    "使用 OpenAI 登录，查看订阅额度。",
  "subscriptionUsageCard.loadingSubscriptionUsage": "正在加载订阅使用情况……",
  "subscriptionUsageCard.couldNotLoadUsageCheckYourConnectionOrSign":
    "无法加载使用情况。请检查连接或重新登录，然后刷新。",
  "subscriptionUsageCard.updated": "已更新",
  "rtkSettingsCard.rtkExperiment": "RTK 实验",
  "rtkSettingsCard.compactShellOutput": "压缩 Shell 输出",
  "rtkSettingsCard.experimentalRtk": "实验性 · RTK",
  "rtkSettingsCard.reduceRepetitiveTestOutputSentToTheModelWhile":
    "减少发送给模型的重复测试输出，同时保留可回看的原始输出。",
  "rtkSettingsCard.compactShellOutputWithRtk": "使用 RTK 压缩 Shell 输出",
  "rtkSettingsCard.appleSiliconMacsCargoTestOnlyCommandsRunAs":
    "仅适用于 Apple 芯片 Mac 的 cargo test。命令照常运行；run_code 中的原始 Shell 输出保持不变。",
  "settingsView.loadingLocalSettings": "正在加载本地设置……",
  "settingsView.arrowup": "向上箭头",
  "settingsView.arrowdown": "向下箭头",
  "settingsView.arrowleft": "向左箭头",
  "settingsView.arrowright": "向右箭头",
  "settingsView.home": "首页",
  "settingsView.end": "结束",
  "settingsView.compactShellOutput": "压缩 Shell 输出",
  "settingsView.appSettings": "应用设置",
  "settingsView.messageSending": "消息正在发送",
  "settingsView.unsavedChangesAcrossSettingsRunningTurnsKeepTheirCurrent":
    "跨设置的未保存更改。运行中的轮次保留其当前配置。",
  "settingsView.unsavedSendingPreferenceRunningTurnsContinueUninterrupted":
    "未保存的发送首选项。运行转弯继续不间断。",
  "settingsView.yourSettingsAreUpToDate": "您的设置已更新。",
  "settingsView.applying": "正在应用……",
  "settingsView.apply": "应用",
  "settingsView.unavailableJournal": "不可用的日记账",
  "settingsView.restoring": "正在还原……",
  "settingsView.unarchive": "取消封存",
  "settingsView.notConfigured": "未配置",
  "settingsView.signedIn": "已登录",
  "settingsView.notSignedIn": "未登录",
  "settingsView.accountConnected": "账号已关联",
  "settingsView.connectAnAccount": "关联账号",
  "settingsView.addAnOpenaiSubscriptionInModelsProviderToGet":
    "在模型和服务商中添加OpenAI 订阅以开始使用。",
  "settingsView.yourSignInDetailsAreStoredSecurelyOnThis":
    "您的登录详细信息将安全地存储在此设备上。",
  "settingsView.signInToConnectYourSubscription": "登录以连接您的订阅。",
  "settingsView.waitingForBrowser": "正在等待浏览器…",
  "settingsView.signInWithOpenai": "使用OpenAI登入",
  "settingsView.defaultModel": "默认模型",
  "settingsView.titleModel": "标题模型",
  "settingsView.oneSubscriptionAccountIsAlreadyConfigured":
    "已配置一个订阅帐户",
  "settingsView.usesTheSignInManagedInAccount": "使用“帐户”中管理的登录",
  "settingsView.thisBuiltInProviderIsAlreadyConfigured": "此内置服务商已配置",
  "settingsView.openaiCompatibleApiPreset": "OpenAI兼容API预设",
  "settingsView.providerAdded": "服务商已添加",
  "settingsView.providerSaved": "服务商已保存",
  "settingsView.providerDeleted": "服务商已删除",
  "settingsView.addProviderProfile": "添加服务商配置文件",
  "settingsView.aProviderCanHaveAtMost1024Models":
    "每个服务商最多可配置 1,024 个模型。请先移除多余模型再保存。",
  "settingsView.waitForTheProviderLogoToFinishLoading":
    "等待服务商徽标完成加载",
  "settingsView.chooseAReplacementDefaultModel": "选择替换默认模型",
  "settingsView.chooseAReplacementTitleModel": "选择一个替换标题模型",
  "settingsView.displayName": "显示名称",
  "settingsView.providerName": "服务商名称",
  "settingsView.baseUrl": "基础 URL",
  "settingsView.apiKey": "API 密钥",
  "settingsView.apiKeySavedLeaveBlankToKeep": "API 密钥已保存—留空以保留",
  "settingsView.required": "必填",
  "settingsView.chooseAPngJpegOrWebpProviderLogo":
    "选择PNG、JPEG或WebP服务商徽标",
  "settingsView.providerLogoMustBeAtMost512Kib": "服务商徽标最多必须为512 KiB",
  "settingsView.fetchTheOfficialCodexModelCatalog": "获取官方Codex模型目录",
  "settingsView.fetchModelIdsFromThisProvider": "从此服务商获取模型 ID",
  "settingsView.saveAnApiKeyBeforeDiscovery": "在发现之前保存API 密钥",
  "settingsView.officialCatalogIsUnchangedUsingTheLocalCache":
    "官方目录未更改；使用本地缓存。",
  "settingsView.officialMetadataUpdatedInTheDraftSaveProviderTo":
    "官方元数据已更新到草稿。保存服务商配置后生效。",
  "settingsView.fetchingModels": "正在获取模型…",
  "settingsView.getAvailableModels": "获取可用模型",
  "settingsView.chooseAdditionalModelsOfficialMetadataIsUpdatedInThe":
    "选择其他模型。官方元数据会更新到草稿，手动设置保持不变。保存服务商配置后生效。",
  "settingsView.selectTheModelsYouWantExistingModelsAndTheir":
    "选择所需的模型。现有模型及其设置保持不变。",
  "settingsView.sendingOneTinyImageTestRequestProviderChargesMay":
    "正在发送一次小型图像测试请求；服务商可能收取费用…",
  "settingsView.imageProbeSucceededSupportWasSaved":
    "图像探测成功；支持已保存。",
  "settingsView.providerExplicitlyRejectedImageInputUnsupportedWasSaved":
    "服务商明确拒绝图像输入；已保存“不支持”状态。",
  "settingsView.imageProbeWasInconclusiveCapabilityRemainsUnknown":
    "图像探测尚无定论；功能仍未知。",
  "settingsView.replacementDefaultModel": "替换默认模型",
  "settingsView.replacementTitleModel": "替换标题模型",
  "settingsView.adding": "正在新增…",
  "settingsView.saving": "正在保存…",
  "settingsView.saveProvider": "保存服务商",
  "settingsView.testingImageSupport": "正在测试图像支持……",
  "settingsView.testImageSupport": "测试图像支持",
  "settingsView.deleting": "正在删除…",
  "settingsView.deleteProvider": "删除服务商",
  "settingsView.lightPreset": "浅色预设",
  "settingsView.darkPreset": "深色预设",
  "settingsView.optedIn": "已选择加入",
  "settingsView.blocked": "已屏蔽",
  "settingsView.noProjectConfigured": "未配置项目",
  "settingsView.enterAWholeNumberOf1OrMore": "请输入不小于 1 的整数。",
  "settingsView.couldNotOpenDiagnosticsFolder": "无法打开诊断文件夹。",
  "fleetSettings.loadingFleet": "正在加载设备…",
  "fleetSettings.fleetConfigurationChangedWhileYouWereEditingCancelThe":
    "在您编辑时，设备配置已更改。取消设备编辑器或放弃托管更改，然后刷新后再保存。",
  "fleetSettings.fleetStatusRefreshed": "设备状态已刷新",
  "fleetSettings.notChecked": "未选中",
  "fleetSettings.checking": "正在检查……",
  "fleetSettings.connectionFailed": "连接失败",
  "fleetSettings.connected": "已连接",
  "fleetSettings.escape": "Esc",
  "fleetSettings.deviceId": "设备 ID",
  "fleetSettings.label": "标签",
  "fleetSettings.sshHost": "SSH主机",
  "fleetSettings.commandArgumentsOnePerLine": "命令参数（每行一个）",
  "fleetSettings.httpsEndpoint": "HTTPS 端点",
  "fleetSettings.remoteHostId": "远程主机 ID",
  "fleetSettings.workspaceIdOptional": "工作区ID （可选）",
  "fleetSettings.oneTimePairingCode2": "一次性配对码",
  "fleetSettings.saving": "正在保存…",
  "fleetSettings.pairDevice": "配对设备",
  "fleetSettings.saveDevice": "保存设备",
  "fleetSettings.deviceRemoved": "设备已移除",
  "fleetSettings.controlEnabled": "控制已启用",
  "fleetSettings.chooseAWorkspace": "选择工作区",
  "fleetSettings.allWorkspaces": "所有工作区",
  "fleetSettings.workspaceSelectedForThisDevice": "为此设备选择的工作区",
  "fleetSettings.chooseAWorkspaceToBrowseItsThreads":
    "选择工作区以浏览其中的会话",
  "fleetSettings.noThreadsInThisWorkspace": "此工作区暂无会话",
  "fleetSettings.messageAcceptedByTheRemoteHostWorkMayStill":
    "远程主机已接收消息。任务可能仍在运行；请刷新查看回复。",
  "fleetSettings.messageToRemoteThread": "给远程会话的消息",
  "fleetSettings.hostingEnabled": "已启用托管",
  "fleetSettings.hostingDisabled": "已停用托管",
  "fleetSettings.registeredNotConnected": "已注册·未连接",
  "fleetSettings.notRegistered": "未注册",
  "fleetSettings.bindAddress": "绑定地址",
  "fleetSettings.port": "端口",
  "fleetSettings.tlsCertificateFile": "TLS证书文件",
  "fleetSettings.tlsPrivateKeyFile": "TLS私钥文件",
  "fleetSettings.androidFacingHttpsEndpoint": "面向Android的HTTPS 端点",
  "fleetSettings.relayEndpointOptional": "中继端点（可选）",
  "fleetSettings.relayRegistrationToken": "中继注册令牌",
  "fleetSettings.savedInBackendLeaveBlankToKeepIt": "保存在后端；留空以保留它",
  "fleetSettings.enterTheTrustedRelaySRegistrationToken":
    "输入受信任中继的注册令牌",
  "fleetSettings.maximumClientAccess": "最大客户端访问权限",
  "fleetSettings.enterABindAddressAPortFrom165535":
    "输入绑定地址、1–65535之间的端口和现有的TLS证书/密钥文件路径。",
  "fleetSettings.useAnHttpsRelayOriginWithoutAPathQuery":
    "使用没有路径、查询、片段或嵌入凭据的HTTPS中继源。",
  "fleetSettings.enterTheTrustedRelayEndpointBeforeItsRegistrationToken":
    "在注册令牌之前输入受信任的中继端点。",
  "fleetSettings.useAnExactHttpsHostnameOrIpv4AddressWith":
    "请输入与监听器端口一致的准确 HTTPS 主机名或 IPv4 地址，供 Android 使用。主机会验证证书 SAN。",
  "fleetSettings.hostingConfigurationSaved": "主机配置已保存",
  "fleetSettings.applyHosting": "应用托管设置",
  "fleetSettings.revoked": "已撤销",
  "fleetSettings.paired": "已配对",
  "fleetSettings.clientRevoked": "已撤销客户端访问权限",
  "fleetSettings.item": "项目",
  "pluginSettings.all": "全部",
  "pluginSettings.installed": "已安装",
  "pluginSettings.builtIn": "内置",
  "pluginSettings.installing": "正在安装…",
  "pluginSettings.chooseTarball": "选择 tarball…",
  "pluginSettings.installSource": "安装源",
  "pluginSettings.noPluginsMatchThisFilter": "没有与此筛选器匹配的插件。",
  "pluginSettings.tryADifferentSearch": "请尝试其他搜索方式。",
  "pluginSettings.install": "安装",
  "pluginSettings.reinstalling": "正在重新安装…",
  "pluginSettings.reinstall": "重新安装",
  "pluginSettings.applying": "正在应用……",
  "pluginSettings.disable": "禁用",
  "pluginSettings.enable": "启用",
  "pluginSettings.updating": "正在更新…",
  "pluginSettings.opening": "正在打开…",
  "pluginSettings.update": "更新…",
  "pluginSettings.uninstall": "卸载",
  "pluginSettings.removeThePluginKeepItsSavedData":
    "删除插件；保留其保存的数据。",
  "pluginSettings.deleteData": "删除数据",
  "pluginSettings.disableThePluginBeforeDeletingItsData":
    "在删除数据之前禁用插件。",
  "pluginSettings.permanentlyDeleteThisPluginSSavedData":
    "永久删除此插件保存的数据。",
  "pluginSettings.uninstallThisPluginAndItsToolsItsDataStays":
    "卸载此插件及其工具。其数据保留在此设备上。",
  "pluginSettings.permanentlyDeleteThisPluginSSavedDataYourConversations":
    "永久删除此插件保存的数据。会话和其他插件将保留。",
  "pluginSettings.confirmUninstall": "确认卸载",
  "pluginSettings.confirmDeleteData": "确认删除数据",
  "pluginAccessReview.checking": "正在检查……",
  "pluginAccessReview.unknown": "未知",
  "pluginAccessReview.allowedByMacos": "由macOS允许",
  "pluginAccessReview.needsSetup": "需要设置",
  "pluginAccessReview.notApplicable": "不适用",
  "pluginAccessReview.zenxChecksWhetherItsNativeHelperCanInspectOpen":
    "ZenX 会检查本机辅助程序能否查看已打开的窗口。此次检查不会保存窗口详情。",
  "pluginAccessReview.zenxChecksASmallWindowPreviewAndDiscardsIt":
    "ZenX 会检查一张小型窗口预览并立即丢弃。如果已启用屏幕录制权限，请重新启动 ZenX；若仍被阻止，请移除旧条目，再重新添加当前 ZenX.app。",
  "pluginAccessReview.optedIn": "已开启",
  "pluginAccessReview.offOptional": "关闭（可选）",
  "pluginAccessReview.globalPointerKeyboardFocusAndScrollingRequireASeparate":
    "控制全局指针、键盘、焦点和滚动需要单独开启权限。后台安全操作无需此权限。",
  "pluginAccessReview.connectedChrome": "已连接的Chrome浏览器",
  "pluginAccessReview.zenxBrowser": "ZenX浏览器",
  "pluginAccessReview.statusUnavailable": "状态不可用",
  "pluginAccessReview.couldNotReadChromeConnectionStateRefreshStatusTo":
    "无法读取Chrome连接状态。请刷新状态以重试。",
  "chromeConnectionSettings.chromeConnected": "Chrome 已连接",
  "chromeConnectionSettings.chromeNotConnected": "Chrome 未连接",
  "chromeConnectionSettings.removing": "正在移除…",
  "chromeConnectionSettings.removeConnector": "移除连接器",
  "chromeConnectionSettings.registering": "正在注册…",
  "chromeConnectionSettings.registerConnector": "注册连接器",
  "chromeConnectionSettings.opening": "正在打开…",
  "chromeConnectionSettings.showExtensionFolder": "显示扩展程序文件夹",
  "chromeConnectionSettings.waitingForChrome": "等待 Chrome…",
  "workflowSettingsPanel.describeWhatThisWorkflowDoes": "描述此工作流的用途",
  "workflowSettingsPanel.usingTheZenxDefault": "使用 ZenX 默认设置",
  "workflowSettingsPanel.customPrompt": "自定义提示词",
  "skillsSettingsPanel.skillImportedCheckItsEffectiveModeBelow":
    "技能已导入。请在下方查看其生效模式。",
  "skillsSettingsPanel.saving": "正在保存…",
  "skillsSettingsPanel.importSkill": "导入技能",
  "skillsSettingsPanel.yourOverride": "您的覆盖设置",
  "skillsSettingsPanel.packagePolicy": "软件包策略",
  "skillsSettingsPanel.default": "默认",
  "skillsSettingsPanel.userOverrideRemoved": "已移除用户覆盖设置。",
  "subscriptionUsageCard.refreshing": "正在刷新…",
  "subscriptionUsageCard.refresh": "刷新",
  "subscriptionUsageCard.planNotProvided": "未提供订阅计划",
  "subscriptionUsageCard.remainingNotProvided": "未提供剩余额度",
  "subscriptionUsageCard.usageNotProvided": "未提供使用量",
  "subscriptionUsageCard.resetTimeNotProvided": "未提供重置时间",
  "rtkSettingsCard.rtkIsNotIncludedInThisBuild": "RTK未包含在此版本中。",
  "rtkSettingsCard.applyToSaveTheChangeTakesEffectNextLaunch":
    "点击“应用”以保存；更改将在下次启动时生效。",
  "rtkSettingsCard.checkApplicationStatusBelowBeforeMakingAnotherChange":
    "在进行其他更改之前，请在下面检查应用状态。",
  "rtkSettingsCard.offByDefaultChangesTakeEffectNextLaunchRunning":
    "默认情况下关闭。更改将在下次启动时生效；正在运行的任务保留其当前行为。",
  "settingsView.modelsProvider": "模型与服务商",
  "settingsView.contextCompaction": "上下文压缩",
  "settingsView.skills": "技能",
  "settingsView.workflows": "工作流程",
  "settingsView.fleet": "设备",
  "settingsView.providerSettingsWereSavedButApplyingThemIsUnconfirmed":
    "服务商设置已保存，但应用它们未经确认。在使用服务商之前检查应用程序状态。",
  "settingsView.providerSettingsWereSavedButFinalizationFailedCheckApplication":
    "服务商设置已保存，但完成失败。在使用服务商之前检查应用程序状态。",
  "settingsView.anotherWindowChangedSettingsThisProviderWasNotSaved":
    "另一个窗口更改了设置。此服务商未保存。您的编辑仍在此处；请重新加载设置，然后重试。",
  "settingsView.thisProviderWasNotSavedReviewItsConnectionAnd":
    "此服务商未保存。查看其连接和模型字段，然后重试。",
  "settingsView.thisProviderWasNotSavedCheckApplicationStatusThen":
    "此服务商未保存。请检查应用状态，然后重试。",
  "settingsView.couldNotConfirmWhetherThisProviderWasSavedCheck":
    "无法确认此服务商是否已保存。请检查应用状态，然后重试。",
  "settingsView.enterADisplayName": "输入显示名称",
  "settingsView.addAtLeastOneModel": "添加至少一个模型",
  "settingsView.noId": "无 ID",
  "settingsView.enterAProviderName": "输入服务商名称",
  "settingsView.enterAnApiKey": "输入API 密钥",
  "settingsView.enterAnApiKeyBecauseThisProfileHasNo":
    "输入API 密钥，因为此配置文件没有保存的密钥",
  "settingsView.enterAValidBaseUrl": "请输入有效的基础 URL",
  "settingsView.baseUrlMustUseHttpsLoopbackHttpIsAllowed":
    "基础 URL必须使用HTTPS （允许环回HTTP ）",
  "settingsView.removeCredentialsFromTheBaseUrl": "从基础 URL中删除凭据",
  "settingsView.removeTheQueryOrFragmentFromTheBaseUrl":
    "从基础 URL中删除查询或片段",
  "settingsView.localTesting": "本地测试",
  "settingsView.clearBlue": "清澈蓝",
  "settingsView.softViolet": "柔和紫",
  "settingsView.freshGreen": "清新绿",
  "settingsView.reasoningUnknown": "推理未知",
  "settingsView.noReasoningStrengthControl2": "无推理强度控制",
  "settingsView.inputUnknown": "输入未知",
  "settingsView.noInputModalities": "无输入模式",
  "settingsView.contextRequired": "需要上下文",
  "settingsView.settingsSaved": "设置已保存",
  "settingsView.noChanges": "无变化",
  "settingsView.changesAppliedRunningTurnsKeepTheirCurrentConfiguration":
    "已应用更改·运行中的轮次保留其当前配置",
  "settingsView.savedApplicationNotYetConfirmedCheckApplicationStatusBefore":
    "已保存，但尚未确认设置已应用。请先检查应用状态，再保存更多更改。",
  "fleetSettings.fleetConnectionIsUnavailable": "设备连接不可用",
  "fleetSettings.useAUniqueDeviceIdOf164Letters":
    "使用1–64个字母、数字、下划线或连字符的唯一设备 ID ；保留本地ID。",
  "fleetSettings.thatDeviceIdIsAlreadyConfigured": "该设备 ID已配置。",
  "fleetSettings.enterADeviceLabel": "输入设备标签。",
  "fleetSettings.confirmRemoteThreadControlBeforeSaving":
    "保存前确认远程会话控制。",
  "fleetSettings.enterAnSshHostAndNonEmptyCommandArguments":
    "输入SSH主机和非空命令参数，每行一个。",
  "fleetSettings.useAnHttpsEndpointWithoutEmbeddedCredentials":
    "使用没有嵌入凭据的HTTPS 端点。",
  "fleetSettings.enterTheRemoteHostIdShownByThatDevice":
    "输入该设备显示的远程主机 ID。",
  "fleetSettings.enterACurrentOneTimePairingCodeFromThe":
    "输入远程主机提供的当前一次性配对码。",
  "fleetSettings.devicePairedBrowseItToChooseAWorkspace":
    "设备已配对。浏览它以选择工作区。",
  "fleetSettings.deviceSaved": "设备已保存",
  "fleetSettings.invalidFleetSettingsResponseRetryAfterCheckingTheHost":
    "设备设置响应无效。请检查主机连接后重试。",
  "fleetSettings.invalidFleetClientListRetryAfterCheckingTheHost":
    "设备客户端列表无效。请检查主机连接后重试。",
  "pluginSettings.pluginInstalledAndEnabled": "插件已安装并启用。",
  "pluginSettings.pluginTarballInstalledAndEnabled":
    "插件 tarball 已安装并启用。",
  "pluginSettings.installedSource": "已安装源",
  "pluginSettings.localDirectorySnapshot": "本地目录快照",
  "pluginSettings.appResourcePackage": "应用资源软件包",
  "pluginAccessReview.thisAppVersionCannotReadCurrentSetupStatus":
    "此应用版本无法读取当前设置状态。",
  "pluginAccessReview.notRequested": "未申请",
  "pluginAccessReview.checkFailed": "检查失败",
  "pluginAccessReview.couldNotVerify": "无法验证",
  "pluginAccessReview.noChromeSetupNeeded": "无需设置Chrome浏览器",
  "pluginAccessReview.externalEndpointConfigured": "外部端点已配置",
  "pluginAccessReview.connectorUnavailable": "连接器不可用",
  "pluginAccessReview.chromeNotConnected": "Chrome未连接",
  "pluginAccessReview.checkingWhichBrowserModeZenxIsUsing":
    "检查ZenX使用的浏览器模式。",
  "pluginAccessReview.usesASeparateZenxBrowserSessionNoChromeConnector":
    "使用单独的ZenX浏览器会话。无需Chrome连接器或macOS桌面权限。",
  "pluginAccessReview.theConnectedChromeConnectorIsNotRunningApplyThe":
    "“已连接的 Chrome”连接器未运行。请应用浏览器模式并重启 ZenX，然后检查浏览器设置。",
  "pluginAccessReview.registerTheLocalConnectorLoadTheExtensionThenClick":
    "注册本地连接器、加载扩展程序，然后在 Chrome 中点击它。“通用”设置列出了每一步。",
  "subscriptionUsageCard.quotaWindow": "配额窗口",
  "rtkSettingsCard.unavailable": "不可用",
  "rtkSettingsCard.unsavedChange": "未保存的更改",
  "rtkSettingsCard.applicationUnconfirmed": "应用状态未确认",
  "rtkSettingsCard.restartRequired": "需要重新启动",
  "rtkSettingsCard.on": "开启",
  "rtkSettingsCard.off": "关闭",
  "settingsView.addNamedProvider": "添加{{name}}",
  "settingsView.editNamedProvider": "编辑{{name}}",
  "settingsView.deleteNamedProvider": "删除{{name}}",
  "settingsView.moreModels_one": "还可添加 {{count}} 个模型（最多 1,024 个）。",
  "settingsView.selectNamedModel": "选择{{name}}",
  "settingsView.addedModels_one":
    "已将 {{count}} 个模型加入草稿。保存 Provider 后生效。",
  "settingsView.modelNumber": "模型{{number}}",
  "settingsView.removeModelNumber": "移除模型{{number}}",
  "settingsView.modelNumberDisplayName": "模型{{number}}显示名称",
  "settingsView.modelNumberDescription": "模型{{number}}描述",
  "settingsView.modelNumberReasoningMetadata": "模型{{number}}推理元数据",
  "settingsView.modelNumberReasoningEfforts": "模型 {{number}} 的推理强度选项",
  "settingsView.modelNumberDefaultReasoningEffort":
    "模型 {{number}} 的默认推理强度",
  "settingsView.modelNumberInputModalities": "模型 {{number}} 的输入模态",
  "settingsView.modelNumberContextWindowRequired":
    "模型{{number}}上下文窗口（必填）",
  "settingsView.modelNumberEnterId": "模型{{number}} ：输入模型 ID",
  "settingsView.modelNumberIdTooLong":
    "模型{{number}} ：模型 ID不得超过512个字符",
  "settingsView.savedPendingRestart": "已保存 · {{fields}} 将在下次启动时生效",
  "settingsView.settingsFinalizationFailed":
    "设置已保存，但完成失败：{{error}}",
  "settingsView.settingsMutationOutcomeUnknown":
    "设置更改失败：{{error}}。无法重新确认当前配置：{{reason}}。结果未知。",
  "settingsView.moreModels_other":
    "还可添加 {{count}} 个模型（最多 1,024 个）。",
  "settingsView.addedModels_other":
    "已将 {{count}} 个模型加入草稿。保存 Provider 后生效。",
  "fleetSettings.testDevice": "测试{{name}}",
  "fleetSettings.browseDevice": "浏览{{name}}",
  "fleetSettings.editDevice": "编辑{{name}}",
  "fleetSettings.readThread": "阅读{{name}}",
  "pluginSettings.managePlugin": "管理{{name}}",
  "pluginSettings.continueEnabling": "继续启用{{name}}",
  "pluginSettings.confirmAction": "确认{{action}}",
  "pluginSettings.installVersion": "安装 v{{version}}",
  "pluginSettings.updateVersion": "更新到 v{{version}}",
  "skillsSettingsPanel.modeForSkill": "{{name}}的模式（ {{id}} ）",
  "workflowSettingsPanel.commandNumberName": "命令{{number}}名称",
  "workflowSettingsPanel.commandNumberDescription": "命令{{number}}说明",
  "workflowSettingsPanel.commandNumberPrompt": "命令 {{number}} 的提示词",
  "pluginProductPage.namedCommands": "{{name}}命令",
  "rtkSettingsCard.savedStateRestart":
    "已保存为{{state}}。任务空闲时可安全重启，或稍后重新启动 ZenX。",
  "rtkSettingsCard.onLower": "开启",
  "rtkSettingsCard.offLower": "关闭",
  "subscriptionUsageCard.plan": "{{name}} 计划",
  "subscriptionUsageCard.percentRemaining": "剩余 {{value}}%",
  "subscriptionUsageCard.percentUsed": "已使用 {{value}}%",
  "subscriptionUsageCard.windowRemaining": "剩余{{name}}",
  "subscriptionUsageCard.resets": "{{time}} 重置",
  "subscriptionUsageCard.dayWindow_one": "{{count}} 天窗口",
  "subscriptionUsageCard.dayWindow_other": "{{count}} 天窗口",
  "subscriptionUsageCard.hourWindow_one": "{{count}} 小时窗口",
  "subscriptionUsageCard.hourWindow_other": "{{count}} 小时窗口",
  "subscriptionUsageCard.minuteWindow_one": "{{count}} 分钟窗口",
  "subscriptionUsageCard.minuteWindow_other": "{{count}} 分钟窗口",
  "subscriptionUsageCard.secondWindow_one": "{{count}} 秒窗口",
  "subscriptionUsageCard.secondWindow_other": "{{count}} 秒窗口",
  "settingsView.neutral": "中性",
  "settingsView.cool": "冷色",
  "settingsView.warm": "暖色",
  "settingsView.modelLimitReached":
    "已达到模型上限（1,024 个）。请先移除一个模型，再添加新模型。",
  "settingsView.apiKeySaved": "API 密钥已保存",
  "settingsView.apiKeyNotSaved": "API 密钥未保存",
  "settingsView.openaiCompatibleApi": "OpenAI兼容API",
  "fleetSettings.sendingCanInterrupt":
    "发送消息可能在 {{name}} 上执行任务，并中断当前任务。",
  "fleetSettings.sendingCanRunWork": "发送消息可能在 {{name}} 上执行任务。",
  "fleetSettings.codeExpires": " · {{time}}到期",
  "fleetSettings.shortLivedCode": " · 有效期很短，请立即使用",
  "fleetSettings.access": "访问",
  "pluginAccessReview.allowed": "允许",
  "pluginAccessReview.verified": "已验证",
  "pluginAccessReview.connected": "已连接",
  "pluginAccessReview.externalChromeEndpoint":
    "ZenX 正在使用外部配置的 Chrome 调试端点。如果标签页缺失，请检查该端点。",
  "pluginSettings.commitPinnedGit": "固定提交的 Git",
  "pluginSettings.tarball": "Tarball",
  "pluginSettings.enabled": "已启用",
  "pluginSettings.disabled": "已禁用",
  "pluginSettings.uninstalled": "已卸载",
  "pluginSettings.available": "可用",
  "pluginSettings.unavailable": "不可用",
  "settingsView.providerGlobalRoles": "{{name}}全局角色",
  "settingsView.modelRow": "模型{{number}} （ {{id}} ）",
  "settingsView.modelRowUniqueId": "{{row}} ：使用唯一的模型 ID",
  "settingsView.modelRowNeedReasoning": "{{row}}：请至少添加一种支持的推理强度",
  "settingsView.modelRowUniqueReasoning": "{{row}}：每种推理强度只能添加一次",
  "settingsView.modelRowDefaultReasoning":
    "{{row}}：请从支持的推理强度中选择默认值",
  "settingsView.modelRowPositiveContext": "{{row}}：上下文窗口必须是正整数",
  "fleetSettings.androidConnectionsFrom": "，包括来自{{endpoint}}的Android连接",
  "fleetSettings.throughRelay":
    "通过{{endpoint}} ，其操作员可以看到中继的凭据和消息",
  "pluginSettings.capabilityRefreshFailed":
    "{{success}} 智能体能力刷新失败：{{error}}",
  "pluginSettings.namedVersionInstalled":
    "{{name}} v{{version}} 已安装并启用。",
  "pluginSettings.namedVersionUpdated": "{{name}} 已更新到 v{{version}}。",
  "pluginSettings.namedInstalled": "{{name}}已安装并启用。",
  "pluginSettings.namedToggled": "{{name}}：{{state}}。",
  "pluginSettings.namedUpdated": "{{name}}已成功更新。",
  "pluginSettings.namedAccessDetails": "{{name}}访问详情",
  "pluginSettings.namedUninstalled": "{{name}}已卸载。其数据已保留。",
  "pluginSettings.namedDataDeleted": "{{name}}数据已删除。",
  "pluginSettings.disabledLower": "已禁用",
  "pluginSettings.enabledLower": "已启用",
  "pluginAccessReview.namedAccessSetup": "{{name}} 的访问权限与设置",
  "pluginAccessReview.chromeTabsAvailable_one":
    "可使用 {{count}} 个 Chrome 标签页。智能体与你共用这些已登录的标签页。",
  "pluginAccessReview.chromeTabsAvailable_other":
    "可使用 {{count}} 个 Chrome 标签页。智能体与你共用这些已登录的标签页。",
  "chromeConnectionSettings.tabsAvailable_one": "可使用 {{count}} 个标签页",
  "chromeConnectionSettings.tabsAvailable_other": "可使用 {{count}} 个标签页",
  "skillsSettingsPanel.namedModeSaved": "{{name}}模式已保存。",
  "fleetSettings.removeNamedDevice": "移除 {{name}}",
  "fleetSettings.revokeNamedClient": "撤销 {{name}} 的访问权限",
  "workflowSettingsPanel.commandNameHelp":
    "名称只能使用小写字母、数字和连字符。/compact 是内置命令，不能覆盖。在需要插入输入参数的位置使用 {{placeholder}}。",
  "workflowSettingsPanel.titlePromptHelp":
    "用 {{placeholder}} 表示首条请求。此辅助提示词不会添加到会话内容中。",
  "skillsSettingsPanel.findImportedSkills_one":
    "查找技能 · 已导入 {{count}} 个",
  "skillsSettingsPanel.findImportedSkills_other":
    "查找技能 · 已导入 {{count}} 个",
  "skillsSettingsPanel.automaticModeHelp":
    "自动模式仅共享名称、描述和位置（总计最多 {{kib}} KiB）。使用时才会加载指令。已禁用的技能无法选择或加载。",
  "settingsView.contextTokens": "{{value}} Token 上下文",
};
