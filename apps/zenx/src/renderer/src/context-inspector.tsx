import type { ModelUsageProjection } from "../../../../../src/model-usage.js";
import type { ContextPreview } from "../../../../../src/context-inspection.js";

function Preview({ value }: { value: ContextPreview }) {
  return (
    <>
      <pre>{value.text}</pre>
      {value.truncated ? (
        <p>
          Preview truncated at 2,000 characters. Full source remains in the
          journal.
        </p>
      ) : null}
    </>
  );
}

export function ContextInspector({
  usage,
  stale = false,
  onRefresh,
}: {
  usage: ModelUsageProjection;
  stale?: boolean;
  onRefresh?(): void;
}) {
  const data = usage.inspection;
  if (!data) return null;
  if (stale)
    return (
      <section className="context-inspector" aria-label="Context inspector">
        <p role="status">
          Context snapshot is out of date. Previous content is hidden until a
          fresh read succeeds.
        </p>
        <button
          type="button"
          aria-label="Refresh context snapshot"
          onClick={onRefresh}
        >
          Refresh context
        </button>
      </section>
    );
  return (
    <section className="context-inspector" aria-label="Context inspector">
      <header>
        <span className="context-inspector-eyebrow">
          READ ONLY · EXPERIMENT
        </span>
        <h2>What is in context?</h2>
        <p>
          Local message projection from the saved conversation. This is not a
          capture of an in-flight request or provider-private context.
        </p>
      </header>
      <section>
        <h3>Occupancy</h3>
        <dl>
          <dt>Projected messages · estimate</dt>
          <dd>{data.estimatedMessageTokens.toLocaleString()} tokens</dd>
          <dt>Model window</dt>
          <dd>{usage.context.contextWindow?.toLocaleString() ?? "Unknown"}</dd>
          <dt>
            {usage.context.inputTokenSource === "provider"
              ? "Last reported provider input"
              : "Indicator estimate"}
          </dt>
          <dd>{usage.context.inputTokens?.toLocaleString() ?? "Unknown"}</dd>
        </dl>
        <p>
          Message estimate excludes tool schemas and provider-added
          instructions. Provider input describes the last compatible response,
          before subsequent local changes. Neither number is cumulative billing
          usage.
        </p>
      </section>
      <section>
        <h3>Summary & retained originals</h3>
        {data.compaction ? (
          <>
            <p>
              Earlier context is represented by this summary and explicitly
              retained items. Newer messages continue below.
            </p>
            <details>
              <summary>Saved summary</summary>
              <Preview value={data.compaction.summary} />
              <p>
                Source: <code>{data.compaction.source}</code>
              </p>
              <p>
                Covered through: <code>{data.compaction.boundary}</code>
              </p>
            </details>
            <details>
              <summary>
                {data.compaction.retainedItemIds.length +
                  data.compaction.retainedOmitted}{" "}
                retained source items
              </summary>
              <pre>{data.compaction.retainedItemIds.join("\n") || "None"}</pre>
              {data.compaction.retainedOmitted ? (
                <p>{data.compaction.retainedOmitted} more IDs omitted.</p>
              ) : null}
            </details>
          </>
        ) : (
          <p>
            No saved compaction. Eligible conversation messages are projected
            directly.
          </p>
        )}
      </section>
      <section>
        <h3>Repository rules</h3>
        <p>Saved rule snapshots, not a fresh read of files on disk.</p>
        {data.rules.length ? (
          data.rules.map((rule, index) => (
            <details key={index}>
              <summary>{rule.source}</summary>
              <Preview value={rule.preview} />
            </details>
          ))
        ) : (
          <p>No repository rule snapshot recorded.</p>
        )}
        {data.rulesOmitted ? (
          <p>{data.rulesOmitted} additional rule files omitted.</p>
        ) : null}
      </section>
      <section>
        <h3>Capabilities & attachments</h3>
        <p>
          Loaded Skills and the complete current tool directory: unknown in this
          slice. Installed or enabled does not prove loaded into context.
        </p>
        <p>
          Tool calls present in this projection (up to 80 names):{" "}
          {data.toolNames.join(", ") || "None"}.
        </p>
        <p>
          Attachment markers appear in message previews; binary content is
          omitted. Opaque reasoning is never displayed.
        </p>
      </section>
      <section>
        <h3>Projected messages · {data.messageCount}</h3>
        <p>
          Ordered as compiled for the current model selection; previews include
          rules, summary, permissions and eligible conversation content. Latest{" "}
          {data.messages.length} shown.
        </p>
        {data.messages.map((message, index) => (
          <details key={index}>
            <summary>
              {data.messageCount - data.messages.length + index + 1}.{" "}
              {message.role}
            </summary>
            <Preview value={message.preview} />
          </details>
        ))}
      </section>
      <footer>
        Snapshot through{" "}
        <code>{data.throughItemId ?? "empty conversation"}</code>. Refreshes
        with usage updates; streaming deltas and queued input are excluded.
      </footer>
    </section>
  );
}
