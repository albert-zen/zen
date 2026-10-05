import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("settings");
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
        <h2>{t("workflowSettingsPanel.workflows")}</h2>
        <p>
          {t(
            "workflowSettingsPanel.createUserScopedSlashCommandsThatExpandIntoMessage",
          )}
        </p>
      </header>
      <section className="settings-card workflow-settings-card">
        <div className="settings-card-head">
          <div>
            <h3>{t("workflowSettingsPanel.slashCommands")}</h3>
            <span>
              {t("workflowSettingsPanel.commandNameHelp", {
                placeholder: "{{args}}",
              })}
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
                    description: t(
                      "workflowSettingsPanel.describeWhatThisWorkflowDoes",
                    ),
                    prompt: "Describe the task here.\n\n{{args}}",
                    enabled: true,
                  },
                ],
                ...(titlePrompt === undefined ? {} : { titlePrompt }),
              });
            }}
          >
            {t("workflowSettingsPanel.addCommand")}
          </button>
        </div>
        {commands.length === 0 ? (
          <p className="settings-empty">
            {t("workflowSettingsPanel.noCustomSlashCommands")}
          </p>
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
                    {t("workflowSettingsPanel.enabled")}
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
                    {t("workflowSettingsPanel.delete")}
                  </button>
                </div>
                <div className="form-grid">
                  <label className="field">
                    <span>{t("workflowSettingsPanel.name")}</span>
                    <input
                      aria-label={t("workflowSettingsPanel.commandNumberName", {
                        number: index + 1,
                      })}
                      value={command.name}
                      onChange={(event) =>
                        update(index, { name: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("workflowSettingsPanel.description")}</span>
                    <input
                      aria-label={t(
                        "workflowSettingsPanel.commandNumberDescription",
                        { number: index + 1 },
                      )}
                      value={command.description}
                      onChange={(event) =>
                        update(index, { description: event.target.value })
                      }
                    />
                  </label>
                  <label className="field workflow-prompt-field">
                    <span>{t("workflowSettingsPanel.prompt")}</span>
                    <textarea
                      aria-label={t(
                        "workflowSettingsPanel.commandNumberPrompt",
                        { number: index + 1 },
                      )}
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
            <h3>{t("workflowSettingsPanel.threadTitlePrompt")}</h3>
            <span>
              {t("workflowSettingsPanel.titlePromptHelp", {
                placeholder: "{{request}}",
              })}
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
            {t("workflowSettingsPanel.restoreDefault")}
          </button>
        </div>
        <label className="field">
          <span>{t("workflowSettingsPanel.prompt2")}</span>
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
              ? t("workflowSettingsPanel.usingTheZenxDefault")
              : t("workflowSettingsPanel.customPrompt")}
          </small>
        </label>
      </section>
    </>
  );
}
