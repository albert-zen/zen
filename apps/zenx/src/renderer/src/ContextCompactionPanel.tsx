import {
  CONTEXT_COMPACTION_SUMMARY_INSTRUCTION,
  type ContextCompactionConfig,
} from "../../../../../src/context-compaction.js";

export function ContextCompactionPanel({
  config,
  onChange,
}: {
  config: ContextCompactionConfig | undefined;
  onChange(config: ContextCompactionConfig | undefined): void;
}) {
  const mode = config?.retention?.mode ?? "budget";
  const finals = config?.retention?.finalMessages ?? "none";
  const retention = (
    update: NonNullable<ContextCompactionConfig["retention"]>,
  ) => onChange({ ...config, retention: { ...config?.retention, ...update } });
  const numeric = (value: number) => (Number.isFinite(value) ? value : "");
  return (
    <>
      <header className="settings-section-header">
        <h2>Context compaction</h2>
        <p>
          Control when history is summarized and which original items the model
          keeps.
        </p>
      </header>
      <section
        className="settings-card compaction-settings"
        aria-label="Compaction budget"
      >
        <h3>Trigger and budget</h3>
        <div className="compaction-field-grid">
          <label className="field">
            <span>Compaction trigger (%)</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={numeric(config?.triggerPercent ?? 80)}
              onChange={(event) =>
                onChange({
                  ...config,
                  triggerPercent:
                    event.target.value === ""
                      ? NaN
                      : Number(event.target.value),
                })
              }
            />
          </label>
          <label className="field">
            <span>Post-compaction budget (%)</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={numeric(config?.targetPercent ?? 80)}
              onChange={(event) =>
                onChange({
                  ...config,
                  targetPercent:
                    event.target.value === ""
                      ? NaN
                      : Number(event.target.value),
                })
              }
            />
          </label>
        </div>
        <p className="settings-note">
          Percentages use the selected model’s context window. The
          post-compaction budget covers both the summary and retained original
          items and cannot exceed the trigger. Token and image costs are
          estimates.
        </p>
        <p className="settings-note">
          Automatic compaction runs at completed-turn boundaries or before the
          next turn, not during an unfinished turn. Complete history stays
          available in the conversation.
        </p>
      </section>
      <section
        className="settings-card compaction-settings"
        aria-label="Retention rules"
      >
        <h3>Original items to retain</h3>
        <label className="field">
          <span>Retention mode</span>
          <select
            value={mode}
            onChange={(event) =>
              retention({
                mode: event.target.value as
                  "budget" | "recent-items" | "selected-items",
              })
            }
          >
            <option value="budget">
              Fill the token budget with recent items
            </option>
            <option value="recent-items">Keep the most recent N items</option>
            <option value="selected-items">
              Keep only the types selected below
            </option>
          </select>
        </label>
        {mode === "recent-items" ? (
          <div className="compaction-count-control">
            <label className="field">
              <span>Number of recent items</span>
              <input
                type="number"
                min="1"
                step="1"
                value={numeric(config?.retention?.recentItemCount ?? 20)}
                onChange={(event) =>
                  retention({
                    recentItemCount:
                      event.target.value === ""
                        ? NaN
                        : Number(event.target.value),
                  })
                }
              />
            </label>
            <div className="compaction-presets">
              <button
                type="button"
                className="quiet-button"
                onClick={() => retention({ recentItemCount: 10 })}
              >
                Last 10 items
              </button>
              <button
                type="button"
                className="quiet-button"
                onClick={() => retention({ recentItemCount: 20 })}
              >
                Last 20 items
              </button>
            </div>
          </div>
        ) : null}
        <p className="settings-note">
          Items include user and agent messages, reasoning, tool calls, and tool
          results. Execution markers do not count. Related tool items are kept
          together, so the actual count can be higher. Budget mode fills from
          the latest completed turn; the count and type rules consider the full
          history.
        </p>
        <label className="compaction-checkbox">
          <input
            type="checkbox"
            aria-label="Preserve all user messages"
            checked={config?.retention?.preserveUserMessages ?? false}
            onChange={(event) =>
              retention({ preserveUserMessages: event.target.checked })
            }
          />
          <span>Preserve all user messages</span>
        </label>
        <label className="field">
          <span>Agent final messages</span>
          <select
            value={finals}
            onChange={(event) =>
              retention({
                finalMessages: event.target.value as "none" | "all" | "recent",
              })
            }
          >
            <option value="none">No additional final messages</option>
            <option value="all">Preserve all final messages</option>
            <option value="recent">
              Preserve the most recent N final messages
            </option>
          </select>
        </label>
        {finals === "recent" ? (
          <label className="field">
            <span>Number of final messages</span>
            <input
              type="number"
              min="1"
              step="1"
              value={numeric(config?.retention?.finalMessageCount ?? 10)}
              onChange={(event) =>
                retention({
                  finalMessageCount:
                    event.target.value === ""
                      ? NaN
                      : Number(event.target.value),
                })
              }
            />
          </label>
        ) : null}
        <p className="settings-note">
          A final message is the final agent reply of a successfully completed
          turn. Intermediate tool commentary and partial replies from failed
          turns do not count.
        </p>
        <p className="settings-note">
          These rules combine: selecting user messages or final replies adds
          them to the retained items. Explicitly retained items will not be
          silently dropped to fit the budget; if they cannot fit, compaction
          reports a failure. Selecting no types in the last mode keeps only the
          summary.
        </p>
      </section>
      <section
        className="settings-card compaction-settings"
        aria-label="Compaction instruction"
      >
        <h3>Summary instruction</h3>
        <label className="field">
          <span>Compaction prompt</span>
          <textarea
            rows={9}
            maxLength={32768}
            value={
              config?.summaryInstruction ??
              CONTEXT_COMPACTION_SUMMARY_INSTRUCTION
            }
            onChange={(event) =>
              onChange({ ...config, summaryInstruction: event.target.value })
            }
          />
        </label>
        <p className="settings-note">
          Replaces the default instruction. Preserve goals, decisions,
          constraints, unfinished work, identifiers, and important tool
          outcomes. Ask for a summary without tool calls.
        </p>
        <button
          type="button"
          className="quiet-button"
          onClick={() => {
            const { summaryInstruction: _, ...rest } = config ?? {};
            onChange(rest);
          }}
        >
          Restore default prompt
        </button>
      </section>
      <button
        type="button"
        className="quiet-button"
        onClick={() => onChange(undefined)}
      >
        Reset all compaction settings
      </button>
    </>
  );
}
