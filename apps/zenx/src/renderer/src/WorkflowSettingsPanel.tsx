import { DEFAULT_TITLE_PROMPT } from "../../main/workflow-configuration.js";
import type { WorkflowCommand } from "../../main/workflow-configuration.js";

export function WorkflowSettingsPanel({
  commands,
  titlePrompt,
  onChange,
}: {
  commands: readonly WorkflowCommand[];
  titlePrompt?: string;
  onChange(value: {
    workflowCommands?: WorkflowCommand[];
    titlePrompt?: string;
  }): void;
}) {
  const update = (index: number, change: Partial<WorkflowCommand>) => {
    const next = commands.map((command, commandIndex) =>
      commandIndex === index ? { ...command, ...change } : command,
    );
    onChange({
      ...(next.length === 0 ? {} : { workflowCommands: next }),
      ...(titlePrompt === undefined ? {} : { titlePrompt }),
    });
  };
  return (
    <>
      <header>
        <h2>Workflows</h2>
        <p>
          Create user-scoped Slash commands that expand into message drafts.
          Review or edit the expanded prompt before sending it.
        </p>
      </header>
      <section className="settings-card workflow-settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Slash commands</h3>
            <span>
              Names use lowercase letters, numbers, and hyphens. /compact is
              built in and cannot be replaced. Use {"{{args}}"} where typed
              arguments should appear.
            </span>
          </div>
          <button
            className="quiet-button"
            type="button"
            onClick={() => {
              const used = new Set(commands.map((command) => command.name));
              let suffix = 1;
              let name = "workflow";
              while (used.has(name)) name = `workflow-${String(++suffix)}`;
              onChange({
                workflowCommands: [
                  ...commands,
                  {
                    name,
                    description: "Describe what this workflow does",
                    prompt: "Describe the task here.\n\n{{args}}",
                    enabled: true,
                  },
                ],
                ...(titlePrompt === undefined ? {} : { titlePrompt }),
              });
            }}
          >
            Add command
          </button>
        </div>
        {commands.length === 0 ? (
          <p className="settings-empty">No custom Slash commands.</p>
        ) : (
          <div className="workflow-command-editors">
            {commands.map((command, index) => (
              <div className="workflow-command-editor" key={index}>
                <div className="workflow-command-editor-head">
                  <label>
                    <input
                      checked={command.enabled}
                      type="checkbox"
                      onChange={(event) =>
                        update(index, { enabled: event.target.checked })
                      }
                    />
                    Enabled
                  </label>
                  <button
                    className="quiet-button danger"
                    type="button"
                    onClick={() => {
                      const next = commands.filter(
                        (_, commandIndex) => commandIndex !== index,
                      );
                      onChange({
                        ...(next.length === 0
                          ? {}
                          : { workflowCommands: next }),
                        ...(titlePrompt === undefined ? {} : { titlePrompt }),
                      });
                    }}
                  >
                    Delete
                  </button>
                </div>
                <div className="form-grid">
                  <label className="field">
                    <span>Name</span>
                    <input
                      aria-label={`Command ${index + 1} name`}
                      value={command.name}
                      onChange={(event) =>
                        update(index, { name: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Description</span>
                    <input
                      aria-label={`Command ${index + 1} description`}
                      value={command.description}
                      onChange={(event) =>
                        update(index, { description: event.target.value })
                      }
                    />
                  </label>
                  <label className="field workflow-prompt-field">
                    <span>Prompt</span>
                    <textarea
                      aria-label={`Command ${index + 1} prompt`}
                      rows={5}
                      value={command.prompt}
                      onChange={(event) =>
                        update(index, { prompt: event.target.value })
                      }
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="settings-card workflow-settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Thread title prompt</h3>
            <span>
              Use {"{{request}}"} for the first request. This auxiliary prompt
              is not added to the Thread conversation.
            </span>
          </div>
          <button
            className="quiet-button"
            disabled={titlePrompt === undefined}
            type="button"
            onClick={() =>
              onChange({
                ...(commands.length === 0
                  ? {}
                  : { workflowCommands: [...commands] }),
              })
            }
          >
            Restore default
          </button>
        </div>
        <label className="field">
          <span>Prompt</span>
          <textarea
            rows={7}
            value={titlePrompt ?? DEFAULT_TITLE_PROMPT}
            onChange={(event) =>
              onChange({
                ...(commands.length === 0
                  ? {}
                  : { workflowCommands: [...commands] }),
                titlePrompt: event.target.value,
              })
            }
          />
          <small>
            {titlePrompt === undefined
              ? "Using the ZenX default"
              : "Custom prompt"}
          </small>
        </label>
      </section>
    </>
  );
}
