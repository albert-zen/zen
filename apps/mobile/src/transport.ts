import { fixtureHosts, fixtureTransport } from "./fixture.mjs";
import { RemoteHostTransport, nativeDependencies } from "./remote";
export const transport = new RemoteHostTransport(
  () => hosts,
  nativeDependencies,
);
export let hosts = [...fixtureHosts];
export function setHostList(value: typeof hosts) {
  hosts = value;
}
export const combinedTransport = {
  snapshot: (id: string, workspace: string | null) =>
    id === fixtureHosts[0].id
      ? fixtureTransport.snapshot(id, workspace)
      : transport.snapshot(id, workspace),
  subscribe: (id: string, workspace: string | null, callback: any) =>
    id === fixtureHosts[0].id
      ? fixtureTransport.subscribe(id, workspace, callback)
      : transport.subscribe(id, workspace, callback),
  read: (id: string, workspace: string, thread: string) =>
    id === fixtureHosts[0].id
      ? fixtureTransport.read(id, workspace, thread)
      : transport.read(id, workspace, thread),
  command: (id: string, workspace: string, kind: string, payload: object) =>
    id === fixtureHosts[0].id
      ? fixtureTransport.command(id, workspace, kind, payload)
      : transport.command(id, workspace, kind, payload),
  disconnect: () => transport.disconnect(),
  clearThread: () => transport.clearThread(),
  readRoom: (id: string, workspace: string, room: string) =>
    transport.readRoom(id, workspace, room),
  postRoom: (id: string, workspace: string, room: string, text: string) =>
    transport.postRoom(id, workspace, room, text),
};
