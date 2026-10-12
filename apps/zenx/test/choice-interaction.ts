import assert from "node:assert/strict";
import { act } from "react";

export async function chooseValue(trigger: HTMLButtonElement, value: string) {
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((entry) => entry.dataset.value === value);
  assert.ok(option, `Missing choice ${value}`);
  await act(async () => {
    option.focus();
    option.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}
