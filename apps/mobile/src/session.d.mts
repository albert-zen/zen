export type Host = { id: string; name: string; endpoint: string };
export type Workspace = { id: string; name: string };
export type Thread = { id: string; title: string; status: string };
export type Item = { id: string; role: string; text: string; status: string };
import type {
  RemoteRoomSummary,
  RemoteRoomView,
  RemoteRoomPostResult,
  RemoteModelView,
} from "../../../src/protocol/native/remote-wire";
export type CommandResult = {
  accepted: boolean;
  error?: string;
  turnId?: string;
  threadId?: string;
  queued?: boolean;
};
export type State = {
  hosts: Host[];
  host: string | null;
  workspace: string | null;
  workspaces: Workspace[];
  threads: Thread[];
  items: Item[];
  turns: { id: string; status: string }[];
  lastRequest: {
    kind: string;
    turnId: string | null;
    messageId?: string;
    queued?: boolean;
  } | null;
  thread: string | null;
  status: string;
  error: string | null;
  command: string | null;
  rooms: RemoteRoomSummary[];
  supportsRooms: boolean;
  roomsError: string | null;
  room: string | null;
  roomMessages: RemoteRoomView["messages"];
  roomLoading: boolean;
  roomReady: boolean;
  models: RemoteModelView[];
  modelsError: string | null;
};
export function createSession(
  transport: {
    snapshot(
      host: string,
      workspace: string | null,
    ): Promise<{
      workspaces: Workspace[];
      threads: Thread[];
      rooms?: RemoteRoomSummary[];
      supportsRooms?: boolean;
      roomsError?: string | null;
      models?: RemoteModelView[];
      modelsError?: string | null;
    }>;
    subscribe(
      host: string,
      workspace: string | null,
      callback: (event: {
        type: string;
        threads?: Thread[];
        items?: Record<string, Item[]>;
        turns?: Record<string, { id: string; status: string }[]>;
        revoked?: boolean;
        roomId?: string;
      }) => void,
    ): () => void;
    read(host: string, workspace: string, id: string): Promise<Item[]>;
    command(
      host: string,
      workspace: string,
      kind: string,
      payload: object,
    ): Promise<CommandResult>;
    disconnect?(): void;
    clearThread?(): void;
    readRoom?(
      host: string,
      workspace: string,
      room: string,
    ): Promise<RemoteRoomView>;
    postRoom?(
      host: string,
      workspace: string,
      room: string,
      text: string,
    ): Promise<RemoteRoomPostResult>;
  },
  publish: (s: State) => void,
): {
  get(): State;
  setHosts(h: Host[]): void;
  selectHost(h: string | null): void;
  reconnect(): Promise<void>;
  preparePair(): void;
  pairFailed(error: unknown): void;
  selectWorkspace(w: string | null): void;
  openThread(id: string): void;
  openRoom(id: string): void;
  refreshRoom(): Promise<void>;
  postRoom(
    text: string,
  ): Promise<({ accepted: true } & RemoteRoomPostResult) | void>;
  command(
    kind: string,
    payload: {
      threadId?: string;
      text?: string;
      model?: string;
      effort?: string;
    },
  ): Promise<CommandResult | void>;
  dispose(): void;
};
