/** Fixed producer API used by the single IMZenX diagnostic test file. */
export interface ImzenxCaseWriter {
  record(
    caseId: number | undefined,
    phase: "case-start" | "case-complete",
  ): void;
  close(): void;
}
/** Optional IO injection in the JS implementation is internal to its JS tests. */
export declare function createImzenxCaseWriter(): ImzenxCaseWriter;
