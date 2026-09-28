# ZenX Android (development fixture)

Independent Expo/React Native Android client scaffold. No Host networking yet: all shown data is explicitly labelled demo fixture, added addresses are unpaired, commands are rejected. This is **not** a connected Android client. No Provider key, Agent runtime or canonical journal on device. Desktop stays Electron.

## Local

From `apps/mobile`: `npm ci && npm test && npm run typecheck`; with a local JDK 17, Android SDK/platform tools/build tools and accepted Android licenses, run `npm run prebuild`, then `npm run android` (dev client; not Expo Go). For a self-contained debug APK run `cd android && ./gradlew assembleDebug`; output `android/app/build/outputs/apk/debug/app-debug.apk`. `android/` is generated and ignored. Development fixtures remain fixture-only inside the APK. No EAS login required.

The Host contract at `artifacts/inbox-dispatch-20260924/remote-host/CONTRACT.md` is owned by the other line. Transport integration must use its actual authentication, read/subscribe and command acknowledgements; do not infer success from HTTP dispatch or transport timeouts. Switching devices/workspaces cancels old subscriptions and ignores stale responses; an existing thread's cwd is never mutated. The demo primary-device ID preference uses Android SecureStore; it is not a paired credential. Added addresses are visibly unpaired and cannot show fixture threads. Pairing/revocation and real credentials require the verified Host contract, not a mock.
