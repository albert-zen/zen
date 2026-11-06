// Adapted from T3 Code @337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17.
/*!
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

export interface AppShotKeyChord {
  key: string;
  modKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const APP_SHOT_DEFAULT_CHORD: AppShotKeyChord = Object.freeze({
  key: "2",
  modKey: true,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: true,
});

const MODIFIERS = [
  "modKey",
  "metaKey",
  "ctrlKey",
  "altKey",
  "shiftKey",
] as const;
const isMac = (platform: string): boolean =>
  /mac|darwin|iphone|ipad|ipod/i.test(platform);
const KEY_ALIASES: Readonly<Record<string, string>> = {
  space: " ",
  plus: "+",
  esc: "escape",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
};
const PORTAL_KEY_NAMES: Readonly<Record<string, string>> = {
  " ": "space",
  escape: "Escape",
  enter: "Return",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  "+": "plus",
  "-": "minus",
  "=": "equal",
  ",": "comma",
  ".": "period",
  "/": "slash",
  ";": "semicolon",
  "'": "apostrophe",
  "[": "bracketleft",
  "]": "bracketright",
  "\\": "backslash",
  "`": "grave",
  "!": "exclam",
  "@": "at",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "^": "asciicircum",
  "&": "ampersand",
  "*": "asterisk",
  "(": "parenleft",
  ")": "parenright",
  _: "underscore",
  ":": "colon",
  '"': "quotedbl",
  "{": "braceleft",
  "}": "braceright",
  "|": "bar",
  "<": "less",
  ">": "greater",
  "?": "question",
  "~": "asciitilde",
};
function normalizeKey(value: string): string | null {
  const key = value.toLowerCase();
  const normalized = Object.hasOwn(KEY_ALIASES, key) ? KEY_ALIASES[key]! : key;
  return Object.hasOwn(PORTAL_KEY_NAMES, normalized) ||
    /^[a-z0-9]$/.test(normalized) ||
    /^f([1-9]|1\d|2[0-4])$/.test(normalized)
    ? normalized
    : null;
}

/** Parse preference text only. Validation of modifiers/conflicts is a separate boundary. */
export function parseAppShotKeyChord(value: unknown): AppShotKeyChord | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const tokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount++;
    tokens.pop();
  }
  if (trailingEmptyCount) tokens.push("+");
  if (tokens.some((token) => !token)) return null;
  const chord: AppShotKeyChord = {
    key: "",
    modKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };
  for (const token of tokens) {
    switch (token) {
      case "mod":
        chord.modKey = true;
        break;
      case "cmd":
      case "meta":
        chord.metaKey = true;
        break;
      case "ctrl":
      case "control":
        chord.ctrlKey = true;
        break;
      case "alt":
      case "option":
        chord.altKey = true;
        break;
      case "shift":
        chord.shiftKey = true;
        break;
      default: {
        const key = normalizeKey(token);
        if (chord.key || key === null) return null;
        chord.key = key;
      }
    }
  }
  return chord.key ? chord : null;
}

/** Strict IPC shape, supported keys and common editing/system collisions. */
export function validateAppShotKeyChord(
  value: unknown,
  platform: string,
): AppShotKeyChord {
  const fields = ["key", ...MODIFIERS];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== fields.length ||
    !fields.every(
      (field) =>
        Object.hasOwn(value, field) &&
        "value" in Object.getOwnPropertyDescriptor(value, field)!,
    )
  ) {
    throw new Error(
      "App Shot shortcut must contain only a key and five boolean modifiers.",
    );
  }
  const input = value as AppShotKeyChord;
  if (
    typeof input.key !== "string" ||
    !MODIFIERS.every((field) => typeof input[field] === "boolean")
  ) {
    throw new Error(
      "App Shot shortcut requires a string key and boolean modifiers.",
    );
  }
  const key = normalizeKey(input.key);
  if (key === null)
    throw new Error(
      "This key isn't supported as an App Shot shortcut. Choose another key.",
    );
  const chord: AppShotKeyChord = {
    key,
    modKey: input.modKey,
    metaKey: input.metaKey,
    ctrlKey: input.ctrlKey,
    altKey: input.altKey,
    shiftKey: input.shiftKey,
  };
  const meta = chord.metaKey || (chord.modKey && isMac(platform));
  const ctrl = chord.ctrlKey || (chord.modKey && !isMac(platform));
  const count = [meta, ctrl, chord.altKey, chord.shiftKey].filter(
    Boolean,
  ).length;
  if (!count) throw new Error("App Shot shortcuts need at least one modifier.");
  // Existing ZenX navigation and macOS menu accelerators must remain usable.
  const primary = isMac(platform) ? meta : ctrl;
  if (
    count === 1 &&
    primary &&
    (/^[1-9]$/.test(key) || (isMac(platform) && ["0", "+", "-"].includes(key)))
  )
    throw new Error(
      "This shortcut is used by ZenX navigation or zoom. Add another modifier.",
    );
  if (
    isMac(platform) &&
    meta &&
    !ctrl &&
    !chord.altKey &&
    chord.shiftKey &&
    (key === "=" || key === "+")
  )
    throw new Error(
      "This shortcut is used by ZenX zoom. Choose another key or modifier.",
    );
  // Windows/Linux close-window and Windows Task Manager chords are OS actions.
  if (
    !isMac(platform) &&
    chord.altKey &&
    !meta &&
    !ctrl &&
    !chord.shiftKey &&
    key === "f4"
  )
    throw new Error("The system uses Alt+F4 to close windows.");
  if (
    /^win/i.test(platform) &&
    ctrl &&
    chord.shiftKey &&
    !meta &&
    !chord.altKey &&
    key === "escape"
  )
    throw new Error("The system uses Ctrl+Shift+Escape to open Task Manager.");
  if (count === 1) {
    if (chord.shiftKey)
      throw new Error(
        "Shift combinations are used for typing and text selection. Add another modifier.",
      );
    const primary = isMac(platform) ? meta : ctrl;
    if (primary && "acfnopqstvwxz".includes(key) && key.length === 1) {
      throw new Error(
        "This shortcut is a common editing or app command. Add another modifier.",
      );
    }
    if (ctrl && ["c", "d", "z"].includes(key))
      throw new Error("This shortcut controls running commands in terminals.");
    if (chord.altKey && key === "tab")
      throw new Error("The system uses Alt+Tab to switch apps.");
    if (meta && ["l", " "].includes(key))
      throw new Error("The system already uses this shortcut.");
  }
  return chord;
}

export function appShotKeyChordPreference(chord: AppShotKeyChord): string {
  return [
    chord.modKey && "mod",
    chord.metaKey && "meta",
    chord.ctrlKey && "ctrl",
    chord.altKey && "alt",
    chord.shiftKey && "shift",
    chord.key === " " ? "space" : chord.key === "+" ? "plus" : chord.key,
  ]
    .filter(Boolean)
    .join("+");
}

export function appShotKeyChordAccelerator(chord: AppShotKeyChord): string {
  const names: Readonly<Record<string, string>> = {
    " ": "Space",
    "+": "Plus",
    arrowup: "Up",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    escape: "Esc",
  };
  return [
    chord.modKey && "CommandOrControl",
    chord.metaKey && "Super",
    chord.ctrlKey && "Control",
    chord.altKey && "Alt",
    chord.shiftKey && "Shift",
    names[chord.key] ?? chord.key.toUpperCase(),
  ]
    .filter(Boolean)
    .join("+");
}

/** Portal triggers are Linux-only, so Mod always maps to CTRL. */
export function appShotPortalTrigger(chord: AppShotKeyChord): string {
  const key = normalizeKey(chord.key);
  if (key === null)
    throw new Error(
      "This key isn't supported as a Wayland capture shortcut. Choose another key.",
    );
  return [
    chord.ctrlKey || chord.modKey ? "CTRL" : null,
    chord.altKey && "ALT",
    chord.shiftKey && "SHIFT",
    chord.metaKey && "LOGO",
    PORTAL_KEY_NAMES[key] ?? key.toUpperCase(),
  ]
    .filter(Boolean)
    .join("+");
}

const EVENT_CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
};

/** T3 recorder policy: layout letters, physical digits/punctuation (including Alt). */
export function appShotKeyChordFromEvent(
  event: {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  platform: string,
): AppShotKeyChord | null {
  const layoutKey = event.key.toLowerCase();
  const recordedKey = /^[a-z]$/.test(layoutKey)
    ? layoutKey
    : (event.code && EVENT_CODE_KEYS[event.code]) || layoutKey;
  const key = normalizeKey(recordedKey);
  if (key === null) return null;
  return {
    key,
    modKey: isMac(platform) ? event.metaKey : event.ctrlKey,
    metaKey: !isMac(platform) && event.metaKey,
    ctrlKey: isMac(platform) && event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  };
}
