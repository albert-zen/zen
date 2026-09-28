// Extracted from App handlers so the real UI actions can be exercised without
// pretending a Node socket test is an Android device run.
export function createAppActions(session, pairTransport, fields) {
  let pairIdentity = 0;
  return {
    selectHost(id) {
      ++pairIdentity;
      fields.setPairState(null);
      fields.setPairCode("");
      fields.setDraft("");
      session.selectHost(id);
    },
    selectWorkspace(id) {
      fields.setDraft("");
      session.selectWorkspace(id);
    },
    openThread(id) {
      fields.setDraft(""); // no cross-Thread draft projection
      session.openThread(id);
    },
    async pair() {
      const selected = session.get().host;
      if (!selected) return;
      const code = fields.getPairCode();
      const identity = ++pairIdentity;
      try {
        await pairTransport.pair(selected, code);
        if (identity !== pairIdentity || session.get().host !== selected)
          return;
        if (fields.getPairCode() === code) fields.setPairCode("");
        fields.setPairState("Paired. Select Host again to connect.");
        session.selectHost(selected);
      } catch (e) {
        if (identity === pairIdentity && session.get().host === selected)
          fields.setPairState(String(e));
      }
    },
    async send() {
      const { host, workspace, thread } = session.get();
      if (!host || !workspace || !thread) return;
      const text = fields.getDraft();
      const result = await session.command("send", { threadId: thread, text });
      if (
        result?.accepted &&
        session.get().host === host &&
        session.get().workspace === workspace &&
        session.get().thread === thread &&
        fields.getDraft() === text
      )
        fields.setDraft("");
    },
    stop() {
      const thread = session.get().thread;
      if (thread) return session.command("stop", { threadId: thread });
    },
  };
}
