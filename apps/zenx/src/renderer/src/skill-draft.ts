import type { SkillEntry } from "../../../../cli/src/skills.js";
import type { Reference } from "./composer-selector.js";
import { parseReferenceDraft, withReferenceDraft } from "./reference-draft.js";

// References are encoded only in the ephemeral draft, then sent as native IDs.
const REFERENCE = /\[skill:([a-f0-9-]{36}):([a-zA-Z0-9_-]+)\]\n?/gu;
export function parseSkillDraft(draft: string) {
  const skills = [...draft.matchAll(REFERENCE)].map((match) => ({
    id: match[1]!,
    name: match[2]!,
  }));
  return { skills, ...parseReferenceDraft(draft.replace(REFERENCE, "")) };
}
export function withSkillDraft(
  text: string,
  skills: readonly Pick<SkillEntry, "id" | "name">[],
  references: readonly Reference[] = [],
): string {
  return (
    skills.map((skill) => `[skill:${skill.id}:${skill.name}]\n`).join("") +
    withReferenceDraft(text, references)
  );
}
