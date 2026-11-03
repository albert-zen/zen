import {
  validateNativeRoomQuestionRequest,
  type NativeRoomQuestionRequest,
  type NativeRoomQuestionResult,
  type NativeRoomQuestionResults,
} from "../native-room-questions.js";
import type { SidebarAdmission } from "../thread-sidebar-state.js";
import type { ZenXBundledAutomationPluginService } from "./automation-plugin-service.js";

type RoomPort = Pick<
  ZenXBundledAutomationPluginService,
  | "roomsAvailable"
  | "snapshot"
  | "roomQuestions"
  | "readRoomQuestion"
  | "respondRoomQuestion"
  | "readRoomQuestionResponse"
>;

/** Native human access to Room-owned resources, never a member Thread question. */
export class NativeRoomQuestionService {
  constructor(readonly getService: () => RoomPort | undefined) {}
  request<T extends NativeRoomQuestionRequest>(
    input: T,
    document: SidebarAdmission,
  ): Promise<NativeRoomQuestionResults[T["method"]]>;
  request(
    input: unknown,
    document: SidebarAdmission,
  ): Promise<NativeRoomQuestionResult>;
  async request(
    input: unknown,
    document: SidebarAdmission,
  ): Promise<NativeRoomQuestionResult> {
    const request = validateNativeRoomQuestionRequest(input);
    const service = this.getService();
    if (!service) throw Error("Room question service unavailable");
    const roomId =
      request.method === "respond" ? request.params.roomId : request.roomId;
    const admit = async () => {
      await document();
      if (this.getService() !== service)
        throw Error(
          "Room question service changed; publication or response may have committed; outcome is unknown, read the original Room identity",
        );
      if (
        !service.roomsAvailable() ||
        !service.snapshot().rooms.some((room) => room.id === roomId)
      )
        throw Error(
          "Room question workspace is unavailable; outcome may be unknown",
        );
    };
    await admit();
    let result: NativeRoomQuestionResult;
    if (request.method === "list")
      result = await service.roomQuestions(request.roomId, request.options);
    else if (request.method === "read")
      result = await service.readRoomQuestion(
        request.roomId,
        request.questionId,
      );
    else if (request.method === "read-response")
      result = await service.readRoomQuestionResponse(
        request.roomId,
        request.questionId,
        request.clientId,
      );
    else result = await service.respondRoomQuestion(request.params, admit);
    // This fence does not undo a committed resolution. A lost document/service
    // returns unknown and the same client identity is reconciled through readback.
    await admit();
    return result;
  }
}

/** Journal summaries invalidate Room readers without carrying question or Thread bodies. */
export function subscribeRoomQuestionInvalidations(
  service: Pick<
    ZenXBundledAutomationPluginService,
    "onChange" | "snapshot" | "roomQuestionSummary"
  >,
  notify: (roomId: string) => void,
): () => void {
  const revisions = new Map<string, number | undefined>();
  for (const room of service.snapshot().rooms) {
    try {
      revisions.set(room.id, service.roomQuestionSummary(room.id).revision);
    } catch {
      // Keep the owner ID even before startup enables readable summaries, so
      // deleting it as the first mutation still invalidates its open readers.
      revisions.set(room.id, undefined);
    }
  }
  return service.onChange((snapshot) => {
    const ids = new Set(snapshot.rooms.map((room) => room.id));
    for (const id of revisions.keys()) {
      if (!ids.has(id)) {
        revisions.delete(id);
        notify(id);
      }
    }
    for (const room of snapshot.rooms) {
      try {
        const revision = service.roomQuestionSummary(room.id).revision;
        if (revisions.get(room.id) !== revision) {
          revisions.set(room.id, revision);
          notify(room.id);
        }
      } catch {
        revisions.set(room.id, undefined);
        notify(room.id);
      }
    }
  });
}
