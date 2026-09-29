// Extracted from App handlers so the real UI actions can be exercised without
// pretending a Node socket test is an Android device run.
export function createAppActions(session, pairTransport, fields) {
  let pairIdentity = 0;
  let viewIdentity = 0;
  let draftRevision = 0;
  // All App edits and programmatic clears pass through this one handler.
  // Equal text after X→Y→X is a different draft from the submitted X.
  const editDraft = (value) => {
    ++draftRevision;
    fields.setDraft(value);
  };
  return {
    editDraft,
    selectHost(id) {
      ++pairIdentity;
      ++viewIdentity;
      fields.setPairState(null);
      fields.setPairCode("");
      editDraft("");
      session.selectHost(id);
    },
    selectWorkspace(id) {
      ++viewIdentity;
      editDraft("");
      session.selectWorkspace(id);
    },
    openThread(id) {
      ++viewIdentity;
      editDraft(""); // no cross-Thread draft projection
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
        ++viewIdentity;
        editDraft("");
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
      const submittedRevision = draftRevision;
      const submittedView = viewIdentity;
      const result = await session.command("send", { threadId: thread, text });
      if (
        result?.accepted &&
        draftRevision === submittedRevision &&
        viewIdentity === submittedView &&
        session.get().host === host &&
        session.get().workspace === workspace &&
        session.get().thread === thread &&
        fields.getDraft() === text
      )
        editDraft("");
    },
    stop() {
      const thread = session.get().thread;
      if (thread) return session.command("stop", { threadId: thread });
    },
  };
}
