# ZenX Android (development fixture)

Independent Expo/React Native Android client scaffold. No Host networking yet: all shown data is explicitly labelled demo fixture, added addresses are unpaired, commands are rejected. This is **not** a connected Android client. No Provider key, Agent runtime or canonical journal on device. Desktop stays Electron.

## Local

From `apps/mobile`: `npm ci && npm test && npm run typecheck`; with a local JDK 17, Android SDK/platform tools/build tools and accepted Android licenses, run `npm run prebuild`, then `npm run android` (dev client; not Expo Go). For a self-contained debug APK run `cd android && ./gradlew assembleDebug`; output `android/app/build/outputs/apk/debug/app-debug.apk`. `android/` is generated and ignored. Development fixtures remain fixture-only inside the APK. No EAS login required.

The Host contract at `artifacts/inbox-dispatch-20260924/remote-host/CONTRACT.md` is owned by the other line. Transport integration must use its actual authentication, read/subscribe and command acknowledgements; do not infer success from HTTP dispatch or transport timeouts. Switching devices/workspaces cancels old subscriptions and ignores stale responses; an existing thread's cwd is never mutated. The demo primary-device ID preference uses Android SecureStore; it is not a paired credential. Added addresses are visibly unpaired and cannot show fixture threads. Pairing/revocation and real credentials require the verified Host contract, not a mock.

## Remote integration (stacked on Host PR #212)

Development Host is an **isolated CLI fake provider**, not the daily desktop app. Enter its Host ID and HTTPS origin; pair using the fresh one-use code from its protected file. The Android app checks OS TLS trust, pairs over HTTPS `/pair`, keeps the device credential in Android SecureStore, and verifies `zen/remote/hello` identity before exposing workspaces/threads. No fallback to HTTP, no TLS bypass, no credential in URL. Grants expire when the isolated Host process restarts; re-pair explicitly. `src/remote-core.ts` uses the one shared native contract at `src/protocol/native/remote-wire.ts` through Metro watchFolders; no duplicate wire package.

`npm run test:host` (after `npm ci` at repo root) runs an ephemeral local CA-trusted TLS Host with two clients and fake provider; no user Host, listener or paid account. Host PR #212 R1 found two blockers (slow unauthenticated pair shutdown; >2 MiB recovery). The stacked integration now includes Host owner R2 candidate c6bbd65 (cherry-picked locally) and uses shared v1 wire: paged recovery with fragmented text, epoch/watermark checks and reset discard. Unit coverage includes >2 MiB reconstructed text, page reset and epoch gap; local CA-trusted real TLS Host + second client test covers short history. R2 **has not passed independent review**; do not claim production approval. No Android emulator screenshot has been taken.
