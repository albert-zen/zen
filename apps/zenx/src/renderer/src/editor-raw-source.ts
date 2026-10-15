import { invertedEffects } from "@codemirror/commands";
import {
  EditorState,
  StateEffect,
  StateField,
  type ChangeSet,
} from "@codemirror/state";

export const normalizedSource = (source: string) =>
  source.replace(/\r\n?|\n/gu, "\n");

function rawOffsetAt(source: string, normalizedOffset: number) {
  let raw = 0;
  let normalized = 0;
  while (raw < source.length && normalized < normalizedOffset) {
    raw += source[raw] === "\r" && source[raw + 1] === "\n" ? 2 : 1;
    normalized += 1;
  }
  return raw;
}

const nearbyLineEnding = (source: string, from: number, to: number) => {
  const removed = source.slice(from, to).match(/\r\n|\r|\n/u)?.[0];
  if (removed) return removed;
  const after = source.slice(to).match(/\r\n|\r|\n/u)?.[0];
  const before = [...source.slice(0, from).matchAll(/\r\n|\r|\n/gu)].at(
    -1,
  )?.[0];
  return after ?? before ?? "\n";
};

function applyChangesToRawSource(source: string, changes: ChangeSet) {
  let output = "";
  let cursor = 0;
  changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    const rawFrom = rawOffsetAt(source, from);
    const rawTo = rawOffsetAt(source, to);
    const lineEnding = nearbyLineEnding(source, rawFrom, rawTo);
    output += source.slice(cursor, rawFrom);
    output += inserted.toString().replaceAll("\n", lineEnding);
    cursor = rawTo;
  });
  return output + source.slice(cursor);
}

export const setRawSource = StateEffect.define<string>();
export const rawSource = StateField.define<string>({
  create: () => "",
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setRawSource)) value = effect.value;
    return value;
  },
});

export const preserveRawSource = [
  EditorState.transactionExtender.of((transaction) => {
    if (
      !transaction.docChanged ||
      transaction.effects.some((effect) => effect.is(setRawSource))
    )
      return null;
    return {
      effects: setRawSource.of(
        applyChangesToRawSource(
          transaction.startState.field(rawSource),
          transaction.changes,
        ),
      ),
    };
  }),
  invertedEffects.of((transaction) =>
    transaction.effects.some((effect) => effect.is(setRawSource))
      ? [setRawSource.of(transaction.startState.field(rawSource))]
      : [],
  ),
];

export const documentText = (state: EditorState) => state.field(rawSource);
