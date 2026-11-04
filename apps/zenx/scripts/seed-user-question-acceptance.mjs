/** Synthetic real Host publication; no manually authored tool/result journal. */
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  pendingSteerMessages,
  recoverSteerRecall,
} from "../../../dist/src/steer-recall.js";
import { createHostedAppServer } from "../../../dist/apps/cli/src/host.js";

export async function seedUserQuestionAcceptance({
  data,
  workspace,
  scenario = "cards",
}) {
  const host = createHostedAppServer({
    cwd: workspace,
    dataDirectory: data,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  const fixture = {
    synthetic: true,
    scenario,
    publicationDefault: true,
    questions: [],
  };
  try {
    for (const [key, title, specifications] of [
      [
        "main",
        "Synthetic · Question card review",
        [
          {
            questions: [
              {
                id: "color",
                prompt: "Synthetic: which review color?",
                options: [
                  {
                    id: "blue",
                    label: "Blue",
                    description: "A calm review accent",
                  },
                  {
                    id: "green",
                    label: "Green",
                    description: "A natural review accent",
                  },
                ],
              },
            ],
          },
          {
            questions: [
              {
                id: "note",
                prompt: "Synthetic: add a review note, or cancel this request.",
              },
            ],
            answerTemplate: "Synthetic note: {{note}}",
          },
        ],
      ],
      [
        "other",
        "Synthetic · Unknown response review",
        [
          {
            questions: [
              {
                id: "scope",
                prompt: "Synthetic: which scope should be checked?",
                options: [
                  { id: "small", label: "Small slice" },
                  { id: "all", label: "Full suite later" },
                ],
              },
            ],
            answerTemplate: "Synthetic scope: {{scope}}",
          },
        ],
      ],
    ]) {
      const thread = await host.startThread();
      fixture[key] = thread.id;
      const selected =
        scenario === "origin" ? specifications.slice(0, 1) : specifications;
      for (const specification of selected) {
        await (
          await host.startTurn(
            thread.id,
            `!tool ask_user_question ${JSON.stringify(specification)}`,
          )
        ).done;
      }
      await host.setThreadName(
        thread.id,
        scenario === "origin" ? `Synthetic · Mixed origin ${key}` : title,
      );
      const snapshot = await host.readThread(thread.id);
      assert.equal(snapshot.userQuestions.length, selected.length);
      for (const question of snapshot.userQuestions) {
        assert.equal(question.state, "open");
        assert.equal(question.request.threadId, thread.id);
        fixture.questions.push(question);
      }
    }
    return fixture;
  } finally {
    await host.closeHostResources();
  }
}

/** One cold read per synthetic owner after normal Desktop exit, never UI polling. */
export async function verifyUserQuestionAcceptance({
  data,
  workspace,
  receipts,
  origin,
}) {
  const host = createHostedAppServer({
    cwd: workspace,
    dataDirectory: data,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  try {
    const snapshots = new Map();
    const evidence = [];
    if (origin) {
      for (const batch of origin.batches) {
        const snapshot = await host.readThread(batch.threadId);
        snapshots.set(batch.threadId, snapshot);
        const records = snapshot.items.filter(
          (item) => item.type === "user_message_steer_recalled",
        );
        assert.equal(
          records.length,
          1,
          "exactly one durable whole-batch recall",
        );
        assert.equal(pendingSteerMessages(snapshot.items).length, 0);
        const recovered = recoverSteerRecall(
          snapshot.items,
          batch.threadId,
          batch.recall.params.recallId,
        );
        assert.ok(recovered);
        assert.equal(recovered.messages.length, 2);
        const ordinary = recovered.messages.find(
          (item) => item.clientId === batch.ordinary.params.clientUserMessageId,
        );
        assert.deepEqual(ordinary.input, batch.ordinary.params.input);
        const answer = recovered.messages.find(
          (item) => item.clientId === batch.answer.params.clientUserMessageId,
        );
        assert.deepEqual(
          answer.questionReply.answers,
          batch.answer.params.answers,
        );
        const exact = await host.readUserQuestion(
          batch.threadId,
          batch.answer.params.questionCallItemId,
          batch.answer.params.clientUserMessageId,
        );
        assert.equal(exact.response.status, "withdrawn");
        const semantic = snapshot.itemList.filter(
          (item) =>
            item.role === "user" &&
            [ordinary.clientId, answer.clientId].includes(
              item.source.metadata?.clientId,
            ),
        );
        assert.equal(
          semantic.length,
          0,
          "withdrawn drafts were not resent or model-consumed",
        );
        evidence.push({
          threadId: batch.threadId,
          recallId: records[0].recallId,
          targets: records[0].targets,
          questionResponse: exact.response.status,
          modelVisibleRecalledInputs: semantic.length,
        });
      }
      return {
        synthetic: true,
        defaultOnColdHost: true,
        boundedThreadReads: snapshots.size,
        evidence,
      };
    }
    for (const { params } of receipts) {
      if (!snapshots.has(params.threadId))
        snapshots.set(params.threadId, await host.readThread(params.threadId));
      const matches = snapshots
        .get(params.threadId)
        .itemList.filter(
          (item) =>
            item.role === "user" &&
            item.source.metadata?.clientId === params.clientUserMessageId,
        );
      assert.equal(
        matches.length,
        1,
        "one ordinary model-visible human input per explicit intent",
      );
      assert.deepEqual(matches[0].source.metadata.questionReply, {
        version: 1,
        request: {
          threadId: params.threadId,
          callItemId: params.questionCallItemId,
        },
        ...(params.outcome === "cancel"
          ? { outcome: "cancel" }
          : { outcome: "answer", answers: params.answers }),
      });
      evidence.push({
        threadId: params.threadId,
        callItemId: params.questionCallItemId,
        clientId: params.clientUserMessageId,
        outcome: params.outcome,
        ordinaryHumanInputCount: matches.length,
      });
    }
    return {
      synthetic: true,
      defaultOnColdHost: true,
      boundedThreadReads: snapshots.size,
      evidence,
    };
  } finally {
    await host.closeHostResources();
  }
}

/** Real image preparation in an owned offline Host; no authored overlays. */
export async function seedImagePreparationAcceptance({ data, workspace }) {
  const { default: sharp } = await import("sharp");
  const { FileAttachmentStore } =
    await import("../../../dist/src/attachment.js");
  const attachments = new FileAttachmentStore(path.join(data, "attachments"));
  const goodBytes = await sharp({
    create: { width: 2048, height: 2048, channels: 3, background: "#87aacc" },
  })
    .png()
    .toBuffer();
  const badBytes = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  // Existing image-preparation.test.ts codec fixture: valid PNG admission/CRC,
  // genuinely undecodable pixels. Do not fake storage failure or codec output.
  for (let offset = 8; offset + 12 <= badBytes.length;) {
    const length = badBytes.readUInt32BE(offset);
    if (badBytes.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      badBytes.fill(0, offset + 8, offset + 8 + length);
      let crc = 0xffffffff;
      for (const byte of badBytes.subarray(offset + 4, offset + 8 + length)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      badBytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, offset + 8 + length);
    }
    offset += length + 12;
  }
  const good = await attachments.importBytes(goodBytes);
  const bad = await attachments.importBytes(badBytes);
  const fixture = {
    synthetic: true,
    scenario: "image",
    threads: [],
    originals: [good, bad],
  };
  const host = createHostedAppServer(imageHostOptions(data, workspace));
  try {
    for (const [key, originals] of [
      ["prepared", [good]],
      ["unavailable", [good, bad]],
    ]) {
      const thread = await host.startThread();
      // FakeModel recognizes this original command part before any model-only
      // image notice. Its second sample returns the real shell result, not Echo.
      await (
        await host.startTurn(thread.id, [
          {
            type: "text",
            text: "!shell printf 'Synthetic image review complete.\\n'",
          },
          ...originals.map((attachment) => ({ type: "image", attachment })),
        ])
      ).done;
      await host.setThreadName(thread.id, `Synthetic · Image ${key}`);
      fixture.threads.push({ key, threadId: thread.id, originals });
    }
  } finally {
    await host.closeHostResources();
  }
  fixture.seedVerification = await verifyImagePreparationAcceptance({
    data,
    workspace,
    fixture,
  });
  return fixture;
}

function imageHostOptions(data, workspace) {
  return {
    cwd: workspace,
    dataDirectory: data,
    provider: { type: "fake" },
    model: "fake",
    approvalPolicy: "never",
    toolPresentation: "direct",
    modelCatalog: [
      {
        id: "fake",
        inputModalities: ["text", "image"],
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        contextWindow: 1000000,
        source: "manual",
      },
    ],
  };
}

/** Bounded cold reads after the seed/Desktop Host has closed. */
export async function verifyImagePreparationAcceptance({
  data,
  workspace,
  fixture,
}) {
  const { FileAttachmentStore } =
    await import("../../../dist/src/attachment.js");
  const { FileTraceStore } = await import("../../../dist/src/trace.js");
  const { compileItemList } = await import("../../../dist/src/item-list.js");
  const attachments = new FileAttachmentStore(path.join(data, "attachments"));
  const trace = new FileTraceStore(path.join(data, "trace"));
  const host = createHostedAppServer(imageHostOptions(data, workspace));
  const threads = [];
  try {
    for (const entry of fixture.threads) {
      const snapshot = await host.readThread(entry.threadId);
      assert.ok(
        snapshot.items.some(
          (item) =>
            item.type === "turn_completed" && item.status === "completed",
        ),
      );
      assert.ok(
        snapshot.items.some(
          (item) =>
            item.type === "tool_result" &&
            item.exitCode === 0 &&
            item.output.includes("Synthetic image review complete."),
        ),
      );
      const agentText = snapshot.items
        .filter((item) => item.type === "agent_message")
        .map((item) => item.text)
        .join("\n");
      assert.match(agentText, /Synthetic image review complete\./);
      assert.doesNotMatch(
        agentText,
        /Echo:|Image input prepared with|Image input unavailable \(/,
      );
      const user = snapshot.items.find((item) => item.type === "user_message");
      assert.deepEqual(
        user.content
          .filter((part) => part.type === "image")
          .map((part) => part.attachment),
        entry.originals,
      );
      for (const original of entry.originals) {
        const bytes = await attachments.read(original);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          original.sha256,
        );
        assert.equal(bytes.byteLength, original.byteLength);
      }
      const overlays = snapshot.itemList.filter(
        (item) => item.source.kind === "image_preparation",
      );
      const prepared = overlays.filter(
        (item) => item.source.metadata.imagePreparation.outcome === "prepared",
      );
      const unavailable = overlays.filter(
        (item) =>
          item.source.metadata.imagePreparation.outcome === "unavailable",
      );
      assert.ok(prepared.length >= 2);
      assert.equal(
        unavailable.length,
        entry.key === "unavailable" ? prepared.length : 0,
      );
      for (const item of prepared) {
        const ref = item.content.parts.find(
          (part) => part.type === "image",
        ).attachment;
        assert.deepEqual([ref.width, ref.height], [1600, 1600]);
        assert.notEqual(ref.sha256, entry.originals[0].sha256);
        await attachments.read(ref);
        assert.match(
          item.content.text,
          /Image input prepared with codex-high-v1/,
        );
      }
      for (const item of unavailable) {
        assert.equal(
          item.source.metadata.imagePreparation.reason,
          "image_decode_failed",
        );
        assert.equal(item.content.parts.length, 1);
        assert.equal(item.content.parts[0].type, "text");
      }
      const sampleIds = new Set(
        overlays.map((item) => item.source.metadata.onlySampleId),
      );
      const observed = await trace.read(entry.threadId, {
        verifyArtifacts: true,
      });
      assert.equal(observed.completeness, "complete");
      assert.equal(observed.artifactVerification, "verified");
      const modelInputs = [];
      for (const record of observed.records.filter(
        (record) =>
          record.type === "model_input" && sampleIds.has(record.sampleId),
      )) {
        assert.equal(record.data.exactTransport, false);
        const artifact = record.artifacts.find(
          (artifact) => artifact.name === "model_input",
        );
        assert.ok(artifact);
        const input = JSON.parse(
          Buffer.from(await trace.readArtifact(artifact.ref)).toString("utf8"),
        );
        const replay = compileItemList(snapshot.itemList, {
          sampleId: record.sampleId,
          inputModalities: ["text", "image"],
        });
        for (const messages of [input.messages, replay.messages]) {
          const images = messages
            .flatMap((message) => message.content ?? message.modelContent ?? [])
            .filter((part) => part.type === "image");
          assert.equal(images.length, 1);
          assert.deepEqual(
            [images[0].attachment.width, images[0].attachment.height],
            [1600, 1600],
          );
          if (entry.key === "unavailable")
            assert.match(JSON.stringify(messages), /image_decode_failed/);
        }
        modelInputs.push({
          sampleId: record.sampleId,
          recordId: record.id,
          artifact: artifact.ref,
          captureLayer: record.data.captureLayer,
          exactTransport: false,
        });
      }
      assert.equal(modelInputs.length, sampleIds.size);
      threads.push({
        ...entry,
        originalBytesUnchanged: true,
        agentNoticeEcho: false,
        prepared: prepared.map((item) => ({
          itemId: item.id,
          sampleId: item.source.metadata.onlySampleId,
          preparation: item.source.metadata.imagePreparation,
          attachment: item.content.parts.find((part) => part.type === "image")
            .attachment,
        })),
        unavailable: unavailable.map((item) => ({
          itemId: item.id,
          sampleId: item.source.metadata.onlySampleId,
          preparation: item.source.metadata.imagePreparation,
        })),
        modelInputs,
      });
    }
    return {
      synthetic: true,
      scope: "synthetic-real-Host-model-adapter-input-not-HTTP",
      threads,
    };
  } finally {
    await host.closeHostResources();
    await trace.flush();
  }
}
