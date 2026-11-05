import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileAttachmentStore } from "../../../src/attachment.js";
import { png1x1 } from "../../../test/fixtures.js";
import { ZenXDraftAttachments } from "../src/main/draft-attachments.js";
import {
  abandonClosedComposerImages,
  abandonUnusedComposerImage,
} from "../src/renderer/src/draft-image-lifecycle.js";
import { SideChatDrafts } from "../src/renderer/src/side-chat-drafts.js";
import {
  addComposerImages,
  editComposer,
  emptyComposerState,
  removeComposerImage,
  type ComposerState,
} from "../src/renderer/src/composer-state.js";

for (const phase of [
  "before admission",
  "during sidebar await",
  "after transfer",
  "discarded during sidebar await",
] as const) {
  test(`side-chat image import ${phase} follows its real storage owner across promotion`, async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zenx-side-image-transfer-"),
    );
    const previousWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    let now = 1;
    const staged = new ZenXDraftAttachments(
      path.join(root, "drafts"),
      new FileAttachmentStore(path.join(root, "attachments")),
      { now: () => now, graceMs: 10, autoCollect: false },
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        zenx: {
          imageAttachments: {
            abandon: (ids: string[]) => staged.abandon(1, ids),
          },
        },
      },
    });
    try {
      const drafts = new SideChatDrafts(
        () => {},
        randomUUID,
        () => "unknown",
        abandonClosedComposerImages,
      );
      const draft = drafts.open("parent", {});
      drafts.updateComposer(draft.id, (state) =>
        editComposer(state, "first message"),
      );
      const images = await staged.importImages(1, [
        { name: "late.png", mediaType: "image/png", bytes: png1x1() },
      ]);
      let finishImport!: () => void;
      const importGate = new Promise<void>((resolve) => {
        finishImport = resolve;
      });
      // A picker can begin before Send and finish while admission or sidebar writes await.
      const imported = drafts.importImages(draft.id, async () => {
        await importGate;
        return images;
      });
      let release!: () => void;
      const delivery = new Promise<void>((resolve) => {
        release = resolve;
      });
      const submitted = drafts.submit(
        draft.id,
        async () => "child",
        () => delivery,
      );
      assert.equal(
        drafts.transfer(draft.id, () => {
          assert.fail("Pending delivery must not transfer its input owner");
        }),
        false,
      );
      if (phase === "before admission") {
        finishImport();
        await imported;
      }
      release();
      await submitted;
      drafts.updateComposer(draft.id, (state) =>
        editComposer(state, "latest sidebar-await edit"),
      );
      if (phase === "during sidebar await") {
        finishImport();
        await imported;
      }
      const discarded = phase === "discarded during sidebar await";
      if (discarded) drafts.close(draft.id);
      let child = emptyComposerState();
      assert.equal(
        drafts.transfer(draft.id, (change) => {
          child = change(child);
        }),
        !discarded,
      );
      if (phase === "after transfer")
        child = editComposer(child, "child edit while sidebar awaits");
      if (!discarded) {
        assert.equal(
          drafts.get(draft.id),
          draft,
          "The temporary tab still presents the real child while sidebar writes await",
        );
        assert.equal(drafts.entries().length, 1);
        assert.equal(
          drafts.transfer(draft.id, () => {
            assert.fail("Repeated transfer must not replace later child edits");
          }),
          true,
        );
        const beforeUpdate = child;
        drafts.updateComposer(draft.id, (state) => ({ ...state }));
        assert.notEqual(
          child,
          beforeUpdate,
          "A late update through the transitional tab targets the unique child Composer",
        );
        await drafts.submit(
          draft.id,
          async () => {
            assert.fail("Transferred presentation cannot create another child");
          },
          async () => {
            assert.fail("Transferred presentation cannot resend input");
          },
        );
      }
      // Stale source-tab close after transfer must not discard the child's input.
      drafts.close(draft.id);
      finishImport();
      await imported;
      assert.equal(drafts.get(draft.id), undefined);
      assert.equal(child.submission, null);
      const inventory = await staged.inventory();
      if (discarded) {
        assert.equal(child.draft.images.length, 0);
        assert.equal(
          inventory.abandonedBytes,
          images[0]!.attachment.byteLength,
        );
        now = 20;
        assert.deepEqual(await staged.collectAbandoned(), [
          images[0]!.attachment.sha256,
        ]);
      } else {
        assert.equal(
          child.draft.text,
          phase === "after transfer"
            ? "child edit while sidebar awaits"
            : "latest sidebar-await edit",
        );
        assert.equal(child.draft.images[0]!.id, images[0]!.id);
        assert.equal(inventory.abandonedBytes, 0);
        assert.equal(inventory.retainedBytes, images[0]!.attachment.byteLength);
        now = 20;
        assert.deepEqual(await staged.collectAbandoned(), []);
        assert.deepEqual(
          await staged.read(child.draft.images[0]!.attachment),
          png1x1(),
        );
        // A later explicit removal from the receiving Composer can still collect it.
        child = removeComposerImage(child, images[0]!.id);
        abandonUnusedComposerImage(images[0]!.id, child);
        await staged.inventory();
        now = 40;
        assert.deepEqual(await staged.collectAbandoned(), [
          images[0]!.attachment.sha256,
        ]);
      }
    } finally {
      if (previousWindow)
        Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("explicit side draft close retires its unused images but closing during child creation never does", async () => {
  const discarded: ComposerState[] = [];
  let sequence = 0;
  const drafts = new SideChatDrafts(
    () => {},
    () => `draft-${++sequence}`,
    () => "unknown",
    (state) => discarded.push(state),
  );
  const image = {
    id: "image-lease",
    name: "synthetic.png",
    attachment: {
      type: "attachment" as const,
      sha256: "a".repeat(64),
      mediaType: "image/png" as const,
      width: 1,
      height: 1,
      byteLength: 68,
    },
  };
  const first = drafts.open("parent", {});
  drafts.updateComposer(first.id, (state) => addComposerImages(state, [image]));
  drafts.close(first.id);
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0]!.draft.images[0]!.id, image.id);
  const pending = drafts.open("parent", {});
  drafts.updateComposer(pending.id, (state) =>
    addComposerImages(state, [image]),
  );
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const submitted = drafts.submit(
    pending.id,
    async () => {
      await gate;
      return "child";
    },
    async () => {},
  );
  drafts.close(pending.id);
  assert.equal(discarded.length, 1);
  finish();
  await submitted;
  const unknown = drafts.open("parent", {});
  drafts.updateComposer(unknown.id, (state) =>
    addComposerImages(state, [image]),
  );
  await drafts.submit(
    unknown.id,
    async () => {
      throw new Error("Lost child creation reply");
    },
    async () => {},
  );
  drafts.close(unknown.id);
  assert.equal(discarded.length, 1);
});

test("opening/closing and empty Send never create a real child", async () => {
  let creates = 0;
  const drafts = new SideChatDrafts(
    () => {},
    () => "draft",
  );
  drafts.open("parent", { boundary: "fixed" });
  await drafts.submit(
    "draft",
    async () => {
      creates++;
      return "child";
    },
    async () => {},
  );
  drafts.close("draft");
  assert.equal(creates, 0);
  assert.equal(drafts.entries().length, 0);
});

test("first Send freezes ownership/boundary; duplicate Send is ignored; failed delivery retries same child and message ID", async () => {
  const drafts = new SideChatDrafts(
    () => {},
    () => "draft",
  );
  drafts.open("parent-A", { boundary: "open-time" });
  drafts.updateComposer("draft", (s) => editComposer(s, "hello"));
  let creates = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: string[] = [];
  const create = async (draft: {
    parentThreadId: string;
    boundary: unknown;
  }) => {
    creates++;
    assert.equal(draft.parentThreadId, "parent-A");
    assert.deepEqual(draft.boundary, { boundary: "open-time" });
    await gate;
    return "child-A";
  };
  const send = async (
    id: string,
    submission: { clientUserMessageId: string },
  ) => {
    assert.equal(id, "child-A");
    sent.push(submission.clientUserMessageId);
    if (sent.length === 1) throw new Error("offline");
  };
  const first = drafts.submit("draft", create, send);
  await drafts.submit("draft", create, send);
  release();
  await first;
  assert.equal(creates, 1);
  assert.equal(drafts.get("draft")?.composer.draft.text, "hello");
  assert.equal(drafts.get("draft")?.composer.submission?.error, "offline");
  await drafts.submit("draft", create, send);
  assert.equal(creates, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(drafts.get("draft")?.composer.draft.text, "");
});

test("unknown create outcome keeps input and blocks another create even after editing", async () => {
  const drafts = new SideChatDrafts(
    () => {},
    () => "draft",
  );
  drafts.open("parent", {});
  drafts.updateComposer("draft", (s) => editComposer(s, "keep me"));
  let creates = 0;
  const create = async () => {
    creates++;
    throw new Error("transport lost");
  };
  await drafts.submit("draft", create, async () => {});
  drafts.updateComposer("draft", (s) => editComposer(s, "edited input"));
  await drafts.submit("draft", create, async () => {});
  assert.equal(creates, 1);
  assert.equal(drafts.get("draft")?.composer.draft.text, "edited input");
  assert.equal(drafts.get("draft")?.creationUnconfirmed, true);
});

test("an explicit native rejection permits a safe same-draft creation retry", async () => {
  const drafts = new SideChatDrafts(
    () => {},
    () => "draft",
  );
  drafts.open("parent", {});
  drafts.updateComposer("draft", (s) => editComposer(s, "hello"));
  let creates = 0;
  const create = async () => {
    if (++creates === 1)
      throw Object.assign(new Error("invalid boundary"), {
        code: -32602,
        data: { zenCode: "fork_boundary_unavailable" },
      });
    return "child";
  };
  await drafts.submit("draft", create, async () => {});
  await drafts.submit("draft", create, async () => {});
  assert.equal(creates, 2);
  assert.equal(drafts.get("draft")?.composer.draft.text, "");
});

test("creation and admission publish distinct pending stages without losing later edits", async () => {
  const stages: string[] = [];
  let sequence = 0;
  const drafts = new SideChatDrafts(
    () => {
      const draft = drafts.get("id-1");
      if (draft?.sending) stages.push(draft.threadId ? "sending" : "creating");
    },
    () => `id-${++sequence}`,
  );
  const draft = drafts.open("parent", { itemId: "opening-item" });
  drafts.updateComposer(draft.id, (state) => editComposer(state, "send this"));
  let created!: (id: string) => void;
  let rejectAdmission!: (error: Error) => void;
  const creation = new Promise<string>((resolve) => {
    created = resolve;
  });
  const admission = new Promise<void>((_resolve, reject) => {
    rejectAdmission = reject;
  });
  const request = drafts.submit(
    draft.id,
    () => creation,
    () => admission,
  );
  assert.equal(stages.at(-1), "creating");
  drafts.updateComposer(draft.id, (state) => editComposer(state, "later edit"));
  created("confirmed-child");
  await Promise.resolve();
  assert.equal(stages.at(-1), "sending");
  rejectAdmission(new Error("offline"));
  await request;
  assert.equal(drafts.get(draft.id)?.composer.draft.text, "later edit");
  assert.equal(drafts.get(draft.id)?.threadId, "confirmed-child");
  assert.equal(drafts.get(draft.id)?.sending, false);
});
