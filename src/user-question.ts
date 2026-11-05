export const ASK_USER_QUESTION_NAME = "ask_user_question";

export const USER_QUESTION_PUBLICATION_KIND = "zen.user-question.published";

export interface QuestionIdentity {
  threadId: string;
  callItemId: string;
}

export interface UserQuestion {
  id: string;
  prompt: string;
  options?: { id: string; label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface UserQuestionSpecification {
  questions: UserQuestion[];
  answerTemplate: string;
}

export type UserQuestionReply = {
  version: 1;
  request: QuestionIdentity;
} & (
  { outcome: "answer"; answers: UserQuestionAnswer[] } | { outcome: "cancel" }
);

/** Shape validation is not authority; native admission must resolve the request. */
export function parseUserQuestionReply(value: unknown): UserQuestionReply {
  const raw = record(
    value,
    ["version", "request", "outcome", "answers"],
    "questionReply",
  );
  if (raw.version !== 1) throw new Error("Unsupported questionReply version");
  const request = record(
    raw.request,
    ["threadId", "callItemId"],
    "questionReply.request",
  );
  const identity = {
    threadId: text(request.threadId, 512, "threadId"),
    callItemId: text(request.callItemId, 512, "callItemId"),
  };
  if (raw.outcome === "cancel") {
    if (raw.answers !== undefined)
      throw new Error("Cancelled question must not contain answers");
    return { version: 1, request: identity, outcome: "cancel" };
  }
  if (
    raw.outcome !== "answer" ||
    !Array.isArray(raw.answers) ||
    raw.answers.length < 1 ||
    raw.answers.length > 8
  )
    throw new Error("Question reply requires 1..8 answers or cancellation");
  const ids = new Set<string>();
  const answers = raw.answers.map((value) => {
    const answer = record(value, ["questionId", "optionIds", "text"], "answer");
    const questionId = key(answer.questionId, "answer.questionId");
    if (ids.has(questionId)) throw new Error("Duplicate answered question");
    ids.add(questionId);
    if (!Array.isArray(answer.optionIds) || answer.optionIds.length > 12)
      throw new Error("Invalid answer optionIds");
    const optionIds = answer.optionIds.map((value) =>
      key(value, "answer.optionId"),
    );
    if (new Set(optionIds).size !== optionIds.length)
      throw new Error("Duplicate answered option");
    return {
      questionId,
      optionIds,
      ...(answer.text === undefined
        ? {}
        : { text: text(answer.text, 8192, "answer.text") }),
    };
  });
  const reply: UserQuestionReply = {
    version: 1,
    request: identity,
    outcome: "answer",
    answers,
  };
  if (new TextEncoder().encode(JSON.stringify(reply)).length > 32768)
    throw new Error("Question reply exceeds 32 KiB");
  return reply;
}

export function normalizeUserQuestionReply(
  specification: UserQuestionSpecification,
  value: unknown,
): UserQuestionReply {
  const reply = parseUserQuestionReply(value);
  if (reply.outcome === "cancel") return reply;
  renderUserQuestionAnswer(specification, reply.answers);
  return {
    ...reply,
    answers: specification.questions.map((question) => {
      const answer = reply.answers.find(
        (answer) => answer.questionId === question.id,
      )!;
      return {
        ...answer,
        optionIds: (question.options ?? [])
          .filter((option) => answer.optionIds.includes(option.id))
          .map((option) => option.id),
      };
    }),
  };
}

export function renderUserQuestionReply(
  specification: UserQuestionSpecification,
  value: UserQuestionReply,
): string {
  const reply = normalizeUserQuestionReply(specification, value);
  // The opaque call Item ID stays in structured metadata; model-visible text
  // uses the short, model-authored question keys the answer template already
  // names, so a reply costs a handful of tokens instead of a transport ID.
  const questions = specification.questions.map((question) => question.id);
  const subject =
    questions.length === 1
      ? `question ${questions[0]}`
      : `questions ${questions.join(", ")}`;
  return reply.outcome === "cancel"
    ? `I chose not to answer ${subject}.`
    : `Reply to ${subject}:\n${renderUserQuestionAnswer(specification, reply.answers)}`;
}

/** Exact legacy publication provenance; display numbering never replaces this identity. */
export function parseUserQuestionPublication(
  body: string,
  request: QuestionIdentity,
  sourceSequence: number,
): { requestRef?: string } | undefined {
  try {
    return validateUserQuestionPublication(
      JSON.parse(body),
      request,
      sourceSequence,
    );
  } catch {
    return;
  }
}

/** Validate an already parsed machine frame without a second JSON parse. */
export function validateUserQuestionPublication(
  value: unknown,
  request: QuestionIdentity,
  sourceSequence: number,
): { requestRef?: string } | undefined {
  try {
    const envelope = record(
      value,
      ["kind", "version", "request", "requestRef"],
      "question publication",
    );
    const identity = record(
      envelope.request,
      ["threadId", "callItemId"],
      "question publication request",
    );
    if (
      envelope.kind !== USER_QUESTION_PUBLICATION_KIND ||
      identity.threadId !== request.threadId ||
      identity.callItemId !== request.callItemId
    )
      return;
    if (envelope.version === 1 && Object.keys(envelope).length === 3) return {};
    if (
      envelope.version === 2 &&
      Object.keys(envelope).length === 4 &&
      envelope.requestRef === `q${sourceSequence}`
    )
      return { requestRef: envelope.requestRef as string };
  } catch {
    /* A lookalike string is not a publication. */
  }
  return;
}

/** Exact read compatibility only, never a body-prefix or UUID-text match. */
export function matchesUserQuestionReplyBody(
  specification: UserQuestionSpecification,
  value: UserQuestionReply,
  body: string,
  requestRef?: string,
): boolean {
  const reply = normalizeUserQuestionReply(specification, value);
  const keys = specification.questions.map((question) => question.id);
  const subject =
    keys.length === 1 ? `question ${keys[0]}` : `questions ${keys.join(", ")}`;
  const render = (subject: string) =>
    reply.outcome === "cancel"
      ? `I chose not to answer ${subject}.`
      : `Reply to ${subject}:\n${renderUserQuestionAnswer(specification, reply.answers)}`;
  return (
    body === renderUserQuestionReply(specification, reply) ||
    body === render(subject) ||
    (requestRef !== undefined && body === render(`${subject} (${requestRef})`))
  );
}

/** Omitted bindings are local and collision-free; they are not display numbers. */
function bindingKeys(
  entries: Record<string, unknown>[],
  prefix: string,
): string[] {
  const explicit = entries.map((entry) =>
    entry.id === undefined ? undefined : key(entry.id, `${prefix}.id`),
  );
  const reserved = new Set(
    explicit.filter((id): id is string => id !== undefined),
  );
  if (reserved.size !== explicit.filter((id) => id !== undefined).length)
    throw new Error(`duplicate ${prefix} id`);
  let next = 1;
  return explicit.map((id) => {
    if (id !== undefined) return id;
    while (reserved.has(`${prefix}_${next}`)) next++;
    const generated = `${prefix}_${next++}`;
    reserved.add(generated);
    return generated;
  });
}

function record(
  value: unknown,
  fields: string[],
  name: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${name} must be an object`);
  }
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new Error(`${name} has unknown fields`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(`${name} must contain 1..${limit} characters`);
  }
  return value;
}

function key(value: unknown, name: string): string {
  const result = text(value, 64, name);
  if (!/^[a-zA-Z0-9_-]+$/.test(result))
    throw new Error(`${name} is not a valid key`);
  return result;
}

/** Bounded model-authored content; no HTML, script or evaluated template language. */
export function parseUserQuestionSpecification(
  value: unknown,
): UserQuestionSpecification {
  const raw = record(value, ["questions", "answerTemplate"], "specification");
  if (
    !Array.isArray(raw.questions) ||
    raw.questions.length < 1 ||
    raw.questions.length > 8
  ) {
    throw new Error("questions must contain 1..8 entries");
  }
  const rawQuestions = raw.questions.map((value) =>
    record(value, ["id", "prompt", "options", "multiSelect"], "question"),
  );
  const ids = bindingKeys(rawQuestions, "question");
  const seen = new Set(ids);
  const questions = rawQuestions.map((q, index): UserQuestion => {
    const id = ids[index]!;
    const result: UserQuestion = {
      id,
      prompt: text(q.prompt, 4096, "question.prompt"),
    };
    if (q.multiSelect !== undefined) {
      if (typeof q.multiSelect !== "boolean")
        throw new Error("multiSelect must be boolean");
      result.multiSelect = q.multiSelect;
    }
    if (q.options !== undefined) {
      if (!Array.isArray(q.options) || q.options.length > 12)
        throw new Error("options must contain 0..12 entries");
      const rawOptions = q.options.map((value) =>
        record(value, ["id", "label", "description"], "option"),
      );
      const optionIds = bindingKeys(rawOptions, "option");
      result.options = rawOptions.map((o, index) => {
        const optionId = optionIds[index]!;
        return {
          id: optionId,
          label: text(o.label, 256, "option.label"),
          ...(o.description === undefined
            ? {}
            : { description: text(o.description, 1024, "option.description") }),
        };
      });
    }
    return result;
  });
  // Keep the projected/native shape compatible with existing clients. Only
  // validated IDs enter the fallback template; question text is never code.
  const answerTemplate =
    raw.answerTemplate === undefined
      ? questions.map(({ id }) => `${id}: {{${id}}}`).join("\n\n")
      : text(raw.answerTemplate, 4096, "answerTemplate");
  const used = new Set<string>();
  const remainder = answerTemplate.replace(
    /\{\{([a-zA-Z0-9_-]+)\}\}/g,
    (_, id: string) => {
      if (!seen.has(id) || used.has(id))
        throw new Error("template contains unknown or repeated question key");
      used.add(id);
      return "";
    },
  );
  if (
    remainder.includes("{{") ||
    remainder.includes("}}") ||
    used.size !== seen.size
  ) {
    throw new Error("template must reference each question exactly once");
  }
  const result = { questions, answerTemplate };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 32768) {
    throw new Error("question specification exceeds 32 KiB");
  }
  return result;
}

export interface UserQuestionAnswer {
  questionId: string;
  optionIds: string[];
  text?: string;
}

/** Pure preview only. The native admission boundary must validate again. */
export function renderUserQuestionAnswer(
  specification: UserQuestionSpecification,
  value: unknown,
): string {
  const spec = parseUserQuestionSpecification(specification);
  if (!Array.isArray(value) || value.length !== spec.questions.length) {
    throw new Error("answer must cover every question");
  }
  const answers = new Map<string, string>();
  for (const entry of value) {
    const raw = record(entry, ["questionId", "optionIds", "text"], "answer");
    const id = key(raw.questionId, "answer.questionId");
    const q = spec.questions.find((question) => question.id === id);
    if (!q || answers.has(id))
      throw new Error("unknown or duplicate answered question");
    if (
      !Array.isArray(raw.optionIds) ||
      raw.optionIds.some((id) => typeof id !== "string")
    ) {
      throw new Error("optionIds must be a string array");
    }
    const selected = new Set<string>(raw.optionIds);
    if (
      selected.size !== raw.optionIds.length ||
      (!q.multiSelect && selected.size > 1)
    ) {
      throw new Error("duplicate or excess selections");
    }
    const options = q.options ?? [];
    if (
      [...selected].some((id) => !options.some((option) => option.id === id))
    ) {
      throw new Error("unknown selected option");
    }
    const freeText =
      raw.text === undefined ? undefined : text(raw.text, 8192, "answer.text");
    if (selected.size === 0 && freeText === undefined)
      throw new Error("answer is empty");
    const parts = options
      .filter((option) => selected.has(option.id))
      .map((option) => option.label);
    if (freeText !== undefined) parts.push(freeText);
    answers.set(id, parts.join("\n"));
  }
  // A single replacement pass: user text containing {{key}} remains literal.
  const rendered = spec.answerTemplate.replace(
    /\{\{([a-zA-Z0-9_-]+)\}\}/g,
    (_, id: string) => answers.get(id)!,
  );
  if (new TextEncoder().encode(rendered).length > 32768)
    throw new Error("answer exceeds 32 KiB");
  return rendered;
}
