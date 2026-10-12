// EXPLICIT DEVELOPMENT FIXTURE: no network, no real Host, no real sends or approvals.
const hosts = [
  {
    id: "fixture-desktop",
    name: "Demo desktop (fixture)",
    endpoint: "fixture://desktop",
  },
];
const threads = [
  { id: "demo-thread", title: "Welcome to ZenX", status: "completed" },
];
export const fixtureHosts = hosts;
export const fixtureTransport = {
  async snapshot(host) {
    if (host !== hosts[0].id)
      throw Error(
        "Unpaired address: no authenticated Host transport is configured.",
      );
    return {
      workspaces: [{ id: "fixture-workspace", name: "Demo workspace" }],
      threads,
    };
  },
  subscribe() {
    return () => {};
  },
  async read() {
    return [
      {
        id: "demo-item",
        role: "assistant",
        text: "This is sample data, not a Host conversation.",
        status: "completed",
      },
    ];
  },
  async command() {
    return {
      accepted: false,
      error:
        "Demo fixture cannot create, send or stop real turns. Pair with a Host when the remote contract is ready.",
    };
  },
};
