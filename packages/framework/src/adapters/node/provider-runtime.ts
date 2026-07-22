import {
  toThreadSnapshot,
  type ThreadJournal,
  type ThreadPersistenceFailure,
  type ThreadRecord,
} from '../../product/index.js';

export async function replayThreadJournal(threadJournal: ThreadJournal): Promise<{
  readonly initialThreads: readonly ThreadRecord[];
  readonly persistenceFailures: readonly ThreadPersistenceFailure[];
}> {
  const replay = await threadJournal.replay();
  return {
    initialThreads: replay
      .filter(
        (result): result is Extract<typeof result, { type: 'success' }> => result.type === 'success'
      )
      .map((result) => ({
        ...toThreadSnapshot({ threadId: result.threadId, items: result.items }),
        items: result.items,
      })),
    persistenceFailures: replay.flatMap((result): readonly ThreadPersistenceFailure[] =>
      result.type === 'failure'
        ? [
            {
              code: 'THREAD_JOURNAL_CORRUPTION',
              message: result.error.message,
              path: result.path,
              recordNumber: result.error.recordNumber,
              threadId: result.threadId,
            },
          ]
        : []
    ),
  };
}
