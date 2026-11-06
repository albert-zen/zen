import assert from "node:assert/strict";
import { it } from "node:test";
import {
  APP_SHOT_DEFAULT_CHORD,
  parseAppShotKeyChord,
  validateAppShotKeyChord,
  appShotKeyChordAccelerator,
  appShotKeyChordPreference,
  appShotKeyChordFromEvent,
  appShotPortalTrigger,
} from "../src/app-shot-key-chord.js";

it("normalizes T3 key syntax into parseable canonical preferences", () => {
  for (const [input, key] of [
    [" Mod + SHIFT + 2 ", "2"],
    ["ctrl+space", " "],
    ["option+esc", "escape"],
    ["meta+up", "arrowup"],
    ["ctrl++", "+"],
    ["ctrl+Plus", "+"],
  ]) {
    const chord = parseAppShotKeyChord(input)!;
    assert.equal(chord.key, key);
    assert.deepEqual(
      parseAppShotKeyChord(appShotKeyChordPreference(chord)),
      chord,
    );
  }
  for (const invalid of [
    null,
    {},
    2,
    "",
    "ctrl",
    "ctrl+a+b",
    "ctrl++x",
    "ctrl+f25",
    "ctrl+é",
    "ctrl+unknown",
  ]) {
    assert.equal(parseAppShotKeyChord(invalid), null);
  }
  assert.equal(
    appShotKeyChordPreference(APP_SHOT_DEFAULT_CHORD),
    "mod+shift+2",
  );
});

it("strictly validates IPC values without coercion or extra properties", () => {
  const base = APP_SHOT_DEFAULT_CHORD;
  for (const invalid of [
    null,
    [],
    "mod+shift+2",
    {},
    { ...base, extra: false },
    { ...base, shiftKey: 1 },
    { ...base, key: 2 },
    { ...base, key: "é" },
    { ...base, key: "f25" },
    { ...base, key: "__proto__" },
    { ...base, [Symbol("extra")]: true },
  ]) {
    assert.throws(() => validateAppShotKeyChord(invalid, "linux"));
  }
  assert.throws(
    () =>
      validateAppShotKeyChord(
        {
          ...base,
          get key() {
            throw new Error("getter ran");
          },
        },
        "linux",
      ),
    /only a key/,
  );
  assert.deepEqual(validateAppShotKeyChord({ ...base, key: "Esc" }, "linux"), {
    ...base,
    key: "escape",
  });
  assert.throws(
    () => validateAppShotKeyChord(parseAppShotKeyChord("2"), "linux"),
    /at least one modifier/,
  );
});

it("blocks physical single-modifier conflicts, including alias and duplicate Mod bypasses", () => {
  for (const platform of ["linux", "Win32", "MacIntel", "darwin"]) {
    for (const key of "acfnopqstvwxz") {
      assert.throws(() =>
        validateAppShotKeyChord(parseAppShotKeyChord(`mod+${key}`), platform),
      );
    }
    for (const text of [
      "shift+2",
      "control+c",
      "ctrl+d",
      "ctrl+z",
      "option+tab",
      "meta+l",
      "cmd+space",
    ]) {
      assert.throws(
        () => validateAppShotKeyChord(parseAppShotKeyChord(text), platform),
        text,
      );
    }
    assert.deepEqual(
      validateAppShotKeyChord(APP_SHOT_DEFAULT_CHORD, platform),
      APP_SHOT_DEFAULT_CHORD,
    );
    assert.doesNotThrow(() =>
      validateAppShotKeyChord(parseAppShotKeyChord("mod+shift+c"), platform),
    );
  }
  for (const text of ["ctrl+mod+c", "control+mod+d", "ctrl+mod+z"]) {
    assert.throws(
      () => validateAppShotKeyChord(parseAppShotKeyChord(text), "linux"),
      text,
    );
  }
  for (const text of ["meta+mod+c", "cmd+mod+q", "meta+mod+space"]) {
    assert.throws(
      () => validateAppShotKeyChord(parseAppShotKeyChord(text), "MacIntel"),
      text,
    );
  }
  assert.throws(() =>
    validateAppShotKeyChord(parseAppShotKeyChord("meta+c"), "MacIntel"),
  );
  assert.throws(() =>
    validateAppShotKeyChord(parseAppShotKeyChord("ctrl+a"), "linux"),
  );
});

it("maps supported keys consistently into Electron and Wayland accelerator names", () => {
  for (const [input, electron, portal] of [
    ["mod+shift+2", "CommandOrControl+Shift+2", "CTRL+SHIFT+2"],
    ["meta+ctrl+alt+space", "Super+Control+Alt+Space", "CTRL+ALT+LOGO+space"],
    ["ctrl+plus", "Control+Plus", "CTRL+plus"],
    ["alt+up", "Alt+Up", "ALT+Up"],
    ["ctrl+esc", "Control+Esc", "CTRL+Escape"],
    ["alt+enter", "Alt+ENTER", "ALT+Return"],
    ["alt+f24", "Alt+F24", "ALT+F24"],
    ["alt+?", "Alt+?", "ALT+question"],
  ]) {
    const chord = parseAppShotKeyChord(input)!;
    assert.equal(appShotKeyChordAccelerator(chord), electron);
    assert.equal(appShotPortalTrigger(chord), portal);
  }
  assert.throws(
    () => appShotPortalTrigger({ ...APP_SHOT_DEFAULT_CHORD, key: "dead" }),
    /isn't supported/,
  );
  // Every ASCII printable punctuation character has a portal keysym and round-trips.
  for (let code = 33; code <= 126; code++) {
    const key = String.fromCharCode(code).toLowerCase();
    const chord = validateAppShotKeyChord(
      { ...APP_SHOT_DEFAULT_CHORD, key },
      "linux",
    );
    assert.deepEqual(
      parseAppShotKeyChord(appShotKeyChordPreference(chord)),
      chord,
    );
    assert.ok(appShotPortalTrigger(chord));
  }
});

it("records T3 default physical digits/punctuation and layout letters on each platform", () => {
  const event = {
    key: "@",
    code: "Digit2",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
  };
  assert.deepEqual(
    appShotKeyChordFromEvent(event, "linux"),
    APP_SHOT_DEFAULT_CHORD,
  );
  assert.deepEqual(
    appShotKeyChordFromEvent(
      { ...event, metaKey: true, ctrlKey: false },
      "MacIntel",
    ),
    APP_SHOT_DEFAULT_CHORD,
  );
  assert.deepEqual(
    appShotKeyChordFromEvent(
      { ...event, metaKey: true, ctrlKey: false },
      "darwin",
    ),
    APP_SHOT_DEFAULT_CHORD,
  );
  assert.equal(
    appShotKeyChordFromEvent({ ...event, key: "?", code: "KeyM" }, "linux")
      ?.key,
    "?",
  );
  assert.equal(
    appShotKeyChordFromEvent({ ...event, key: "Z", code: "KeyY" }, "linux")
      ?.key,
    "z",
  );
  assert.equal(
    appShotKeyChordFromEvent(
      { ...event, key: "€", code: "Digit5", altKey: true },
      "linux",
    )?.key,
    "5",
  );
  assert.equal(
    appShotKeyChordFromEvent(
      { ...event, key: "÷", code: "Slash", altKey: true },
      "MacIntel",
    )?.key,
    "/",
  );
  assert.equal(
    appShotKeyChordFromEvent({ ...event, key: "+", code: "Equal" }, "linux")
      ?.key,
    "=",
  );
  for (const key of [
    "Control",
    "Shift",
    "Meta",
    "Alt",
    "Dead",
    "Unidentified",
    "F25",
    "é",
  ]) {
    assert.equal(
      appShotKeyChordFromEvent({ ...event, key, code: "" }, "linux"),
      null,
    );
  }
  assert.equal(
    appShotKeyChordFromEvent({ ...event, key: " ", code: "Space" }, "linux")
      ?.key,
    " ",
  );
  assert.equal(
    appShotKeyChordFromEvent(
      { ...event, key: "Escape", code: "Escape" },
      "linux",
    )?.key,
    "escape",
  );
});

it("copies valid own data fields explicitly even when they are non-enumerable", () => {
  const input = { ...APP_SHOT_DEFAULT_CHORD, modKey: false };
  Object.defineProperty(input, "ctrlKey", { value: true, enumerable: false });
  assert.equal(
    appShotKeyChordAccelerator(validateAppShotKeyChord(input, "linux")),
    "Control+Shift+2",
  );
});

it("reserves ZenX navigation, platform zoom and explicit OS actions without losing fixed picker compatibility", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const key of "123456789")
      assert.throws(
        () =>
          validateAppShotKeyChord(parseAppShotKeyChord(`mod+${key}`), platform),
        /ZenX navigation/,
      );
    assert.doesNotThrow(() =>
      validateAppShotKeyChord(APP_SHOT_DEFAULT_CHORD, platform),
    );
    assert.doesNotThrow(() =>
      validateAppShotKeyChord(parseAppShotKeyChord("mod+alt+2"), platform),
    );
  }
  for (const text of [
    "mod+0",
    "mod+plus",
    "mod+-",
    "meta+0",
    "meta+plus",
    "meta+-",
    "mod+shift+=",
    "meta+shift+plus",
  ])
    assert.throws(
      () => validateAppShotKeyChord(parseAppShotKeyChord(text), "darwin"),
      /zoom/,
    );
  for (const platform of ["win32", "linux"]) {
    assert.throws(
      () => validateAppShotKeyChord(parseAppShotKeyChord("alt+f4"), platform),
      /close windows/,
    );
    assert.doesNotThrow(() =>
      validateAppShotKeyChord(parseAppShotKeyChord("mod+0"), platform),
    );
    assert.doesNotThrow(() =>
      validateAppShotKeyChord(parseAppShotKeyChord("mod+plus"), platform),
    );
  }
  assert.throws(
    () =>
      validateAppShotKeyChord(
        parseAppShotKeyChord("ctrl+shift+escape"),
        "win32",
      ),
    /Task Manager/,
  );
  assert.throws(
    () =>
      validateAppShotKeyChord(
        parseAppShotKeyChord("mod+shift+escape"),
        "win32",
      ),
    /Task Manager/,
  );
  assert.doesNotThrow(() =>
    validateAppShotKeyChord(
      parseAppShotKeyChord("ctrl+shift+escape"),
      "darwin",
    ),
  );
  assert.doesNotThrow(() =>
    validateAppShotKeyChord(parseAppShotKeyChord("ctrl+shift+escape"), "linux"),
  );
});
