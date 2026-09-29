export type Host = { id: string; name: string; endpoint: string };
export type Workspace = { id: string; name: string };
export type Thread = { id: string; title: string; status: string };
export type Item = { id: string; role: string; text: string; status: string };
export type State = {
  hosts: Host[];
  host: string | null;
  workspace: string | null;
  workspaces: Workspace[];
  threads: Thread[];
  items: Item[];
  thread: string | null;
  status: string;
  error: string | null;
  command: string | null;
};
export function createSession(
  transport: {
    snapshot(
      host: string,
      workspace: string | null,
    ): Promise<{ workspaces: Workspace[]; threads: Thread[] }>;
    subscribe(
      host: string,
      workspace: string | null,
      callback: (event: {
        type: string;
        threads: Thread[];
        items: Record<string, Item[]>;
      }) => void,
    ): () => void;
    read(host: string, workspace: string, id: string): Promise<Item[]>;
    command(
      host: string,
      workspace: string,
      kind: string,
      payload: object,
    ): Promise<{ accepted: boolean; error?: string }>;
  },
  publish: (s: State) => void,
): {
  get(): State;
  setHosts(h: Host[]): void;
  selectHost(h: string | null): void;
  selectWorkspace(w: string | null): void;
  openThread(id: string): void;
  command(kind: string, payload: object): Promise<void>;
  dispose(): void;
};
