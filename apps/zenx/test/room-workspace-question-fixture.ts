import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationTransactionStore } from "../src/main/automation-transaction-store.js";
import {
  readAutomationProjection,
  automationTransactionForSnapshot,
} from "../src/main/automation-transaction-adapter.js";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { NativeInformationService } from "../src/main/native-information-service.js";
import { ThreadSidebarStore } from "../src/main/thread-sidebar-store.js";
import { NativeRoomQuestionService } from "../src/main/native-room-question-service.js";
import type {
  NativeRoomQuestionApi,
  NativeRoomQuestionRequest,
  NativeRoomQuestionResults,
} from "../src/native-room-questions.js";
export async function roomWorkspaceQuestionFixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "room-workspace-question-ui-"),
  );
  await mkdir(join(directory, "journal"));
  const journal = await AutomationTransactionStore.create(
    { directory: join(directory, "journal"), assertWriterLease: () => {} },
    { triggers: [], history: [], rooms: [] },
  );
  const service = new ZenXTriggerService(
    {
      onNotification: () => () => {},
      request: async () => {
        throw Error("No Thread delivery claimed by this UI fixture");
      },
    } as never,
    {
      roomHistory: journal,
      read: () => readAutomationProjection(journal),
      write: async (snapshot, events = []) => {
        await journal.append(
          automationTransactionForSnapshot(journal, snapshot, events),
        );
      },
    },
  );
  await service.start();
  const room = await service.createRoom({
    name: "Synthetic Room workspace",
    members: [
      { threadId: "member-a", name: "A" },
      { threadId: "member-b", name: "B" },
    ],
  });
  const other = await service.createRoom({
    name: "Other Room workspace",
    members: [{ threadId: "member-a", name: "A" }],
  });
  const paw = await service.createAssistantRoom({
    name: "Synthetic PAW workspace",
    members: [{ threadId: "member-a", name: "A" }],
  });
  const sidebar = new ThreadSidebarStore(join(directory, "sidebar"));
  const information = new NativeInformationService({
    sidebar,
    rooms: () => service.snapshot().rooms,
    assertThreadExists: async () => {},
  });
  let sequence = 0;
  const listeners = new Set<(roomId: string) => void>();
  const notify = (id = room.id) => {
    for (const listener of listeners) listener(id);
  };
  const port = {
    roomsAvailable: () => true,
    snapshot: () => service.snapshot(),
    roomQuestions: service.roomQuestions.bind(service),
    readRoomQuestion: service.readRoomQuestion.bind(service),
    respondRoomQuestion: service.respondRoomQuestion.bind(service),
    readRoomQuestionResponse: service.readRoomQuestionResponse.bind(service),
  };
  const native = new NativeRoomQuestionService(() => port);
  const api: NativeRoomQuestionApi = {
    request: async <T extends NativeRoomQuestionRequest>(
      input: T,
    ): Promise<NativeRoomQuestionResults[T["method"]]> => {
      const result = await native.request(input, async () => {});
      if (input.method === "respond") notify(input.params.roomId);
      return result as NativeRoomQuestionResults[T["method"]];
    },
    onChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    directory,
    service,
    journal,
    room,
    other,
    paw,
    sidebar,
    information,
    api,
    notify,
    async publish(member = "member-a", owner = room.id) {
      const q = await service.publishRoomQuestion(
        owner,
        { threadId: member, callItemId: "publication-" + ++sequence },
        {
          questions: [
            {
              id: "scope",
              prompt: "Synthetic workspace question " + sequence,
              options: [{ id: "yes", label: "Yes" }],
            },
          ],
        },
        async () => {},
      );
      notify(owner);
      return q;
    },
    listRooms() {
      return service.snapshot().rooms.map((room) => ({
        ...room,
        questionSummary: service.roomQuestionSummary(room.id),
      }));
    },
    async close() {
      await sidebar.close();
      await service.close();
      await journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
