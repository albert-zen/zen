import { useEffect, useState } from "react";
import type { SkillsSnapshot, SkillMode } from "../../../../cli/src/skills.js";
import { DirectoryPicker } from "./DirectoryPicker.js";

export function SkillsSettingsPanel() {
  const [snapshot, setSnapshot] = useState<SkillsSnapshot | null>(null);
  const [directory, setDirectory] = useState("");
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const refresh = async () => setSnapshot(await window.zenx.skills.list());
  useEffect(() => {
    let active = true;
    void window.zenx.skills
      .list()
      .then((value) => active && setSnapshot(value))
      .catch((reason: unknown) => active && setError(String(reason)));
    return () => {
      active = false;
    };
  }, []);
  const perform = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
      await refresh();
      setStatus(message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <header>
        <h2>Skills</h2>
        <p>
          Import instructions and their resources. Manual Skills stay out of
          model context until you choose them from the slash menu.
        </p>
      </header>
      <section className="settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Import a Skill</h3>
            <span>
              Choose a directory containing SKILL.md. Zen keeps a complete local
              copy; the original is never modified.
            </span>
          </div>
        </div>
        <label className="field settings-field">
          <span>Skill directory</span>
          <input
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="Absolute directory path"
          />
        </label>
        <div className="settings-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={() => setPicker(true)}
            disabled={busy}
          >
            Browse…
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || directory.trim().length === 0}
            onClick={() =>
              void perform(async () => {
                await window.zenx.skills.importDirectory(directory.trim());
                setDirectory("");
              }, "Skill imported. Check its effective mode below.")
            }
          >
            {busy ? "Saving…" : "Import Skill"}
          </button>
        </div>
      </section>
      {error !== null && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {status !== null && <p role="status">{status}</p>}
      {snapshot === null ? (
        <p role="status">Loading Skills…</p>
      ) : (
        <>
          <label className="field settings-field">
            <span>Find a Skill · {snapshot.skills.length} imported</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, description or source"
            />
          </label>
          <p>
            Automatic mode shares only name, description and location (up to{" "}
            {snapshot.catalogBudgetBytes / 1024} KiB total). Instructions load
            when used. Disabled Skills cannot be selected or loaded.
          </p>
          {snapshot.errors.map((message) => (
            <p key={message} className="settings-error" role="alert">
              {message}
            </p>
          ))}
          {snapshot.skills.length === 0 && (
            <section className="settings-card">
              <h3>No Skills imported</h3>
              <p>
                Your model receives no Skills metadata. Import a directory to
                make it available in the slash menu.
              </p>
            </section>
          )}
          {snapshot.skills
            .filter((skill) =>
              `${skill.name} ${skill.description} ${skill.source}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((skill) => (
              <section className="settings-card" key={skill.id}>
                <div className="settings-card-head">
                  <div>
                    <h3>{skill.name}</h3>
                    <span>{skill.description}</span>
                  </div>
                </div>
                <label className="field settings-field">
                  <span>
                    Effective mode ·{" "}
                    {skill.configurationSource === "user"
                      ? "Your override"
                      : skill.configurationSource === "package"
                        ? "Package policy"
                        : "Default"}
                  </span>
                  <select
                    aria-label={`Mode for ${skill.name} (${skill.id})`}
                    disabled={busy}
                    value={skill.mode}
                    onChange={(event) =>
                      void perform(
                        () =>
                          window.zenx.skills.setMode(
                            skill.id,
                            event.target.value as SkillMode,
                          ),
                        `${skill.name} mode saved.`,
                      )
                    }
                  >
                    <option value="manual">Manual use</option>
                    <option value="auto">Automatically visible</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </label>
                <details>
                  <summary>Source and configuration</summary>
                  <p className="skills-source">Imported from: {skill.source}</p>
                  <p className="skills-source">Local copy: {skill.directory}</p>
                  <p>
                    Your override takes precedence over agents/zen.yaml, then
                    the manual default. Changes apply to future sends;
                    previously loaded history stays intact.
                  </p>
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={busy || skill.configurationSource !== "user"}
                    onClick={() =>
                      void perform(
                        () => window.zenx.skills.setMode(skill.id, null),
                        "User override removed.",
                      )
                    }
                  >
                    Use package default
                  </button>
                </details>
              </section>
            ))}
        </>
      )}
      {picker && (
        <DirectoryPicker
          onCancel={() => setPicker(false)}
          onSelect={(value) => {
            setDirectory(value);
            setPicker(false);
          }}
        />
      )}
    </>
  );
}
