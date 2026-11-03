import type {
  RoomUserQuestionPublicationInput,
  RoomUserQuestionPublicationReceipt,
} from "../../../../src/user-question-tool.js";
import type { AppServerManager } from "./app-server-manager.js";

interface RoomQuestionPublishingPort {
  publishRoomQuestion(
    roomId: string,
    origin: RoomUserQuestionPublicationInput["origin"],
    specification: unknown,
    admit: () => Promise<void>,
  ): Promise<{ roomId: string; id: string; revision: number }>;
}

/** Current Room service owns mutation and membership; origin remains provenance. */
export function createRoomQuestionPublisher(
  manager: Pick<AppServerManager, "listThreadSummaries">,
  getService: () => RoomQuestionPublishingPort | undefined,
) {
  return async (
    input: RoomUserQuestionPublicationInput,
    admitHost: () => Promise<void>,
  ): Promise<RoomUserQuestionPublicationReceipt> => {
    const service = getService();
    if (!service) throw new Error("Room question service unavailable");
    const admit = async () => {
      await admitHost();
      if (getService() !== service)
        throw new Error("Room question service changed before publication");
      // Read bounded current metadata, not question history or another Thread's
      // question state. The service revalidates membership at its append fence.
      const source = (await manager.listThreadSummaries()).find(
        (entry) => entry.threadId === input.origin.threadId,
      );
      if (!source || source.archived || source.status === "systemError")
        throw new Error("Room question origin Thread is unavailable");
      await admitHost();
      if (getService() !== service)
        throw new Error("Room question service changed before publication");
    };
    const question = await service.publishRoomQuestion(
      input.roomId,
      input.origin,
      input.specification,
      admit,
    );
    if (getService() !== service)
      throw new Error(
        "Room question service changed after dispatch; publication may have committed; read the original Room resource and do not replay",
      );
    return {
      roomId: question.roomId,
      questionId: question.id,
      revision: question.revision,
    };
  };
}
