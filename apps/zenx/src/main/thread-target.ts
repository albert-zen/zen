import type { Thread } from "../protocol-client/index.js";
import type { ZenXProjectProjection } from "./project-projection.js";

export interface ThreadTargetPort {
  readonly projectProjection: Pick<ZenXProjectProjection, "canonicalKeys">;
  request(
    method: "thread/list",
    params: { archived: boolean; cursor?: string; limit?: number },
  ): Promise<{
    data: Array<Pick<Thread, "id" | "name" | "cwd" | "status">>;
    nextCursor: string | null;
  }>;
}

export interface ThreadCandidate {
  threadId: string;
  shortId: string;
  name: string | null;
  cwd: string;
  archived: boolean;
  status: Thread["status"]["type"];
}

export type ThreadTargetResolution =
  | { status: "resolved"; threadId: string; candidate: ThreadCandidate }
  | { status: "ambiguous" | "not_found"; candidates: ThreadCandidate[] };

/** Scans all pages: uniqueness must never be inferred from a truncated list. */
export async function listThreadCandidates(
  port: ThreadTargetPort,
  options: { workspace?: string } = {},
): Promise<ThreadCandidate[]> {
  let candidates: ThreadCandidate[] = [];
  for (const archived of [false, true]) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await port.request("thread/list", {
        archived,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      candidates.push(
        ...page.data.map((thread) => ({
          threadId: thread.id,
          shortId: thread.id,
          name: thread.name,
          cwd: thread.cwd,
          status: thread.status.type,
          archived,
        })),
      );
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined) {
        if (seen.has(cursor))
          throw new Error("Thread listing returned a repeated cursor");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
  }
  // A concurrent archive can move an entry between the two lists.
  candidates = [
    ...new Map(
      candidates.map((candidate) => [candidate.threadId, candidate]),
    ).values(),
  ];
  if (options.workspace !== undefined) {
    const keys = await port.projectProjection.canonicalKeys([
      options.workspace,
      ...candidates.map((candidate) => candidate.cwd),
    ]);
    candidates = candidates.filter(
      (candidate, index) =>
        candidate.cwd.length > 0 && keys[index + 1] === keys[0],
    );
  }
  return candidates.map((candidate) => {
    let length = Math.min(8, candidate.threadId.length);
    while (
      length < candidate.threadId.length &&
      candidates.some(
        (other) =>
          other.threadId !== candidate.threadId &&
          other.threadId.startsWith(candidate.threadId.slice(0, length)),
      )
    )
      length++;
    return { ...candidate, shortId: candidate.threadId.slice(0, length) };
  });
}

export async function resolveThreadTarget(
  port: ThreadTargetPort,
  options: { target: string; workspace?: string },
): Promise<ThreadTargetResolution> {
  if (typeof options.target !== "string" || options.target.trim().length === 0)
    throw new Error("target must be a non-empty string");
  const candidates = await listThreadCandidates(port, options);
  const exact = candidates.find(
    (candidate) => candidate.threadId === options.target,
  );
  const matches =
    exact === undefined
      ? candidates.filter(
          (candidate) =>
            candidate.threadId.startsWith(options.target) ||
            candidate.name === options.target,
        )
      : [exact];
  const candidate = matches[0];
  return matches.length === 1 && candidate !== undefined
    ? { status: "resolved", threadId: candidate.threadId, candidate }
    : {
        status: matches.length === 0 ? "not_found" : "ambiguous",
        candidates: matches,
      };
}
