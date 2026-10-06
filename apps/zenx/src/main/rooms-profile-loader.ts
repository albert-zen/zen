import { AsyncLocalStorage } from "node:async_hooks";

import type { ZenXBundledAutomationPluginService } from "./automation-plugin-service.js";
import type { ZenXAutomationControlPort } from "./capabilities/automation-control-package.js";
import type { ZenXTrustedProfilePluginLoader } from "./plugin-profile.js";

export const ZENX_ROOMS_PACKAGE_NAME = "@zenx/rooms-plugin";
export const ZENX_ROOMS_TARBALL = "zenx-rooms-plugin-1.0.6.tgz";

export function createZenXRoomsProfileLoader(
  service: () => ZenXAutomationControlPort,
): ZenXTrustedProfilePluginLoader {
  return (module) => {
    const create = module["createZenXTrustedPlugin"];
    if (typeof create !== "function") {
      throw new Error(
        "Bundled Rooms runtime does not export createZenXTrustedPlugin",
      );
    }
    const domain = service() as ZenXBundledAutomationPluginService;
    if (
      typeof domain.prepareRoomMessage !== "function" ||
      typeof domain.postPreparedRoomMessage !== "function" ||
      typeof domain.cancelPreparedRoomOperation !== "function"
    ) {
      throw new Error("Trusted Rooms service is unavailable");
    }
    // A cached 1.0.x module can be held by an in-flight tool generation.
    // It never sees the Host's source marker, only this restricted port.
    const scope = new AsyncLocalStorage<{
      trustedUi: boolean;
      threadId: string | undefined;
      active: boolean;
    }>();
    const call = () => {
      const context = scope.getStore();
      if (!context?.active) throw new Error("Room invocation is not active");
      return context;
    };
    const requireUi = () => {
      if (!call().trustedUi) throw new Error("Trusted Room UI required");
    };
    const port = {
      startPlugin: (
        id: string,
        sdk: Parameters<typeof domain.startPlugin>[1],
      ) => domain.startPlugin(id, sdk),
      stopPlugin: (id: string, sdk?: Parameters<typeof domain.stopPlugin>[1]) =>
        domain.stopPlugin(id, sdk),
      snapshot: () => {
        const snapshot = domain.snapshot();
        if (call().trustedUi) return snapshot;
        return {
          ...snapshot,
          rooms: snapshot.rooms.map(
            ({ id, name, members, messages, createdAt }) => ({
              id,
              name,
              members,
              messages,
              createdAt,
            }),
          ),
        };
      },
      wakeupsEnabled: () => {
        call();
        return domain.wakeupsEnabled();
      },
      assistantWorkspace: (id: string) => {
        call();
        return domain.assistantWorkspace(id);
      },
      updateAssistantWorkspace: (
        input: Parameters<typeof domain.updateAssistantWorkspace>[0],
      ) => {
        call();
        return domain.updateAssistantWorkspace(input);
      },
      workspaces: () => {
        requireUi();
        return domain.workspaces();
      },
      previewTarget: (workspace: string) => {
        requireUi();
        return domain.previewTarget(workspace);
      },
      createAssistantRoom: (
        input: Parameters<typeof domain.createAssistantRoom>[0],
      ) => {
        requireUi();
        return domain.createAssistantRoom(input);
      },
      setAssistantReplies: (id: string, enabled: boolean) => {
        requireUi();
        return domain.setAssistantReplies(id, enabled);
      },
      createRoom: (input: Parameters<typeof domain.createRoom>[0]) => {
        call();
        return domain.createRoom(input);
      },
      renameRoom: (id: string, name: string) => {
        call();
        return domain.renameRoom(id, name);
      },
      deleteRoom: (id: string) => {
        call();
        return domain.deleteRoom(id);
      },
      addRoomMember: (
        id: string,
        member: Parameters<typeof domain.addRoomMember>[1],
      ) => {
        call();
        return domain.addRoomMember(id, member);
      },
      removeRoomMember: (id: string, threadId: string) => {
        call();
        return domain.removeRoomMember(id, threadId);
      },
      postAgentRoomMessage: (
        id: string,
        text: string,
        replyToMessageId?: string,
      ) => {
        if (call().trustedUi)
          throw new Error("Trusted Room UI cannot use the Agent post path");
        return domain.postAgentRoomMessage(
          id,
          text,
          replyToMessageId,
          call().threadId,
        );
      },
      reactRoomMessage: (
        id: string,
        messageId: string,
        emoji: string | null,
      ) => {
        const invocation = call();
        if (!invocation.trustedUi && !invocation.threadId)
          throw new Error("Agent reaction requires a calling Thread");
        return domain.setRoomReaction(
          id,
          messageId,
          invocation.trustedUi ? null : invocation.threadId!,
          emoji,
        );
      },
      prepareRoomMessage: (
        id: string,
        key: string,
        text: string,
        replyToMessageId?: string,
      ) => {
        requireUi();
        return domain.prepareRoomMessage(id, key, text, replyToMessageId);
      },
      postPreparedRoomMessage: (id: string, key: string, text: string) => {
        requireUi();
        return domain.postPreparedRoomMessage(id, key, text);
      },
      cancelPreparedRoomOperation: (id: string, key: string) => {
        requireUi();
        return domain.cancelPreparedRoomOperation(id, key);
      },
      acknowledgeRoomOperation: (id: string, key: string) => {
        requireUi();
        return domain.acknowledgeRoomOperation(id, key);
      },
      roomOperation: (id: string, key: string) => {
        requireUi();
        return domain.roomOperation(id, key);
      },
      roomDelivery: (id: string, messageId: string) => {
        requireUi();
        return domain.roomDelivery(id, messageId);
      },
    };
    const runtime = create(port) as unknown;
    if (
      typeof runtime !== "object" ||
      runtime === null ||
      typeof (runtime as { invoke?: unknown }).invoke !== "function"
    ) {
      throw new Error("Bundled Rooms runtime factory is invalid");
    }
    const selected = runtime as ReturnType<ZenXTrustedProfilePluginLoader>;
    return {
      ...selected,
      invoke: async (toolName, invocation) => {
        const context = {
          trustedUi: invocation.trustedPluginUi === true,
          threadId: invocation.threadId,
          active: true,
        };
        try {
          if (!context.trustedUi && "input" in invocation.arguments)
            throw new Error("Trusted Room UI required");
          return await scope.run(context, () =>
            selected.invoke(toolName, invocation),
          );
        } finally {
          context.active = false;
        }
      },
    };
  };
}
