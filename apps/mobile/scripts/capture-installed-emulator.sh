#!/usr/bin/env bash
# Only uses a system image already present on this runner. No sdkmanager/license acceptance.
set -euo pipefail
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$SDK" || ! -x "$SDK/emulator/emulator" || ! -x "$SDK/platform-tools/adb" || ! -x "$SDK/cmdline-tools/latest/bin/avdmanager" ]]; then
  echo 'NO_ANDROID_SCREENSHOT: emulator/adb/avdmanager not preinstalled'
  exit 0
fi
image="$(find "$SDK/system-images" -path '*/x86_64/package.xml' -print 2>/dev/null | head -1 || true)"
if [[ -z "$image" ]]; then
  echo 'NO_ANDROID_SCREENSHOT: no preinstalled Android system image; no license accepted or download requested'
  exit 0
fi
image_dir="$(dirname "$image")"
image_id="$(echo "${image_dir#"$SDK/system-images/"}" | tr / ';')"
work="$(mktemp -d)"
export ANDROID_AVD_HOME="$work/avd"
mkdir -p "$ANDROID_AVD_HOME"
cleanup() {
  "$SDK/platform-tools/adb" -s emulator-5554 emu kill >/dev/null 2>&1 || true
  if [[ -n "${emulator_pid:-}" ]]; then kill "$emulator_pid" >/dev/null 2>&1 || true; wait "$emulator_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
printf 'no\n' | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd --force -n zenx_mobile_ci -k "$image_id" -p "$ANDROID_AVD_HOME/zenx_mobile_ci.avd"
"$SDK/emulator/emulator" -avd zenx_mobile_ci -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect -port 5554 >"$work/emulator.log" 2>&1 &
emulator_pid=$!
for i in $(seq 1 100); do
  if [[ "$("$SDK/platform-tools/adb" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" == '1' ]]; then break; fi
  sleep 2
done
if [[ "$("$SDK/platform-tools/adb" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" != '1' ]]; then
  echo 'NO_ANDROID_SCREENSHOT: preinstalled emulator did not boot within 200s'
  exit 0
fi
"$SDK/platform-tools/adb" -s emulator-5554 install -r android/app/build/outputs/apk/debug/app-debug.apk
"$SDK/platform-tools/adb" -s emulator-5554 shell am start -n dev.zenx.mobile/.MainActivity
sleep 12
if ! "$SDK/platform-tools/adb" -s emulator-5554 shell dumpsys activity activities | grep -q 'dev.zenx.mobile'; then
  echo 'NO_ANDROID_SCREENSHOT: mobile Activity not visible'
  exit 0
fi
mkdir -p evidence
"$SDK/platform-tools/adb" -s emulator-5554 exec-out screencap -p > evidence/android-fixture-emulator.png
file evidence/android-fixture-emulator.png
