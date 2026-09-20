import {
  normalizeUserInput,
  sameUserInput,
  type UserInput,
  type UserInputPart,
} from "./item.js";

export interface SkillReference {
  type: "skill";
  id: string;
}
export type RequestedUserInput =
  string | readonly (UserInputPart | SkillReference)[];
export interface SkillInputLoader {
  prepare(
    input: readonly (UserInputPart | SkillReference)[],
  ): Promise<UserInput>;
}

/** Recover the original request from canonical loaded text, never from disk. */
export function requestedSkillInput(
  input: UserInput,
): readonly (UserInputPart | SkillReference)[] {
  return input.flatMap((part): (UserInputPart | SkillReference)[] => {
    if (part.type !== "text" || part.skillSource === undefined) return [part];
    return part.skillSource.kind === "catalog"
      ? []
      : [{ type: "skill", id: part.skillSource.id! }];
  });
}

export async function prepareSkillInput(
  loader: SkillInputLoader | undefined,
  requested: RequestedUserInput,
  prior?: UserInput,
): Promise<UserInput> {
  const input =
    typeof requested === "string"
      ? [{ type: "text" as const, text: requested }]
      : requested;
  // Only the Host can create provenance. Wire readers must never accept it.
  if (
    prior !== undefined &&
    sameRequestedInput(requestedSkillInput(prior), input)
  )
    return structuredClone(prior);
  if (loader !== undefined) return await loader.prepare(input);
  if (input.some((part) => part.type === "skill"))
    throw new Error("Skills are not configured on this Host");
  return normalizeUserInput(input as UserInput);
}

function sameRequestedInput(
  left: readonly (UserInputPart | SkillReference)[],
  right: readonly (UserInputPart | SkillReference)[],
): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => {
      const other = right[index]!;
      if (part.type === "skill" || other.type === "skill")
        return (
          part.type === "skill" &&
          other.type === "skill" &&
          part.id === other.id
        );
      return sameUserInput([part], [other]);
    })
  );
}
