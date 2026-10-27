import type { ClientSendObservation } from "../../../../../src/client-observation.js";
import {
  emptyComposerState,
  beginComposerSubmission,
  acceptComposerSubmission,
  failComposerSubmission,
  type ComposerState,
  type ComposerSubmission,
} from "./composer-state.js";

/** App-owned, renderer-local editing state; no Thread exists until first Send. */
export interface SideChatDraft<Boundary = unknown> {
  id: string;
  parentThreadId: string;
  roomId?: string;
  boundary: Boundary;
  inheritedModel?: string;
  inheritedEffort?: string | null;
  model?: string;
  effort?: string;
  composer: ComposerState;
  threadId?: string;
  sending: boolean;
  creationUnconfirmed?: boolean;
}

export class SideChatDrafts<Boundary = unknown> {
  #drafts = new Map<string, SideChatDraft<Boundary>>();
  constructor(
    private changed: () => void,
    private id: () => string = () => crypto.randomUUID(),
    private unconfirmedMessage = () =>
      "Unable to confirm side chat creation. Check the conversation list and reopen a side chat. Your input has been kept.",
  ) {}
  entries() {
    return [...this.#drafts.values()];
  }
  get(id: string) {
    return this.#drafts.get(id);
  }
  open(
    parentThreadId: string,
    boundary: Boundary,
    options: {
      roomId?: string;
      model?: string;
      effort?: string;
      inheritedModel?: string;
      inheritedEffort?: string | null;
    } = {},
  ) {
    const draft: SideChatDraft<Boundary> = {
      id: this.id(),
      parentThreadId,
      boundary,
      ...options,
      composer: emptyComposerState(),
      sending: false,
    };
    this.#drafts.set(draft.id, draft);
    this.changed();
    return draft;
  }
  close(id: string) {
    this.#drafts.delete(id);
    this.changed();
  }
  updateComposer(id: string, change: (state: ComposerState) => ComposerState) {
    const draft = this.get(id);
    if (!draft) return;
    draft.composer = change(draft.composer);
    this.changed();
  }
  configure(id: string, options: { model?: string; effort?: string }) {
    const draft = this.get(id);
    if (!draft || draft.sending || draft.threadId) return;
    Object.assign(draft, options);
    this.changed();
  }
  async submit(
    id: string,
    create: (draft: SideChatDraft<Boundary>) => Promise<string>,
    deliver: (
      threadId: string,
      submission: ComposerSubmission,
    ) => Promise<void>,
    observation?: ClientSendObservation,
  ) {
    const draft = this.get(id);
    if (!draft || draft.sending || draft.creationUnconfirmed) return;
    const started = beginComposerSubmission(
      draft.composer,
      "start",
      null,
      this.id,
      observation,
    );
    if (started === draft.composer) return;
    draft.composer = started;
    const submission = started.submission;
    if (!submission || submission.status !== "pending") return;
    draft.sending = true;
    this.changed();
    try {
      if (!draft.threadId) {
        try {
          draft.threadId = await create(draft);
        } catch (error) {
          const rejection = error as {
            code?: unknown;
            data?: { zenCode?: unknown };
          } | null;
          if (
            rejection?.code !== -32602 &&
            typeof rejection?.data?.zenCode !== "string"
          ) {
            draft.creationUnconfirmed = true;
            throw new Error(this.unconfirmedMessage());
          }
          throw error;
        }
      }
      await deliver(draft.threadId, submission);
      draft.composer = acceptComposerSubmission(
        draft.composer,
        submission.clientUserMessageId,
      );
    } catch (error) {
      draft.composer = failComposerSubmission(
        draft.composer,
        submission.clientUserMessageId,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      draft.sending = false;
      this.changed();
    }
  }
}
