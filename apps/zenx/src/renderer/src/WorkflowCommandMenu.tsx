import type { WorkflowCommandCandidate } from "./workflow-commands.js";

export function WorkflowCommandMenu({
  activeIndex,
  candidates,
  onChoose,
}: {
  activeIndex: number;
  candidates: readonly WorkflowCommandCandidate[];
  onChoose(command: WorkflowCommandCandidate): void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div
      className="workflow-command-menu"
      role="listbox"
      aria-label="Slash commands"
    >
      {candidates.map((command, index) => (
        <button
          aria-selected={index === activeIndex}
          className={index === activeIndex ? "is-active" : undefined}
          key={
            command.kind === "skill"
              ? command.id
              : `${command.kind}:${command.name}`
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(command)}
          role="option"
          type="button"
        >
          <strong>/{command.name}</strong>
          <span>{command.description}</span>
          <small>
            {command.kind === "skill"
              ? `Skill · ${command.source} · ${command.id.slice(0, 8)}`
              : command.kind === "built-in"
                ? "Built in"
                : "Custom"}
          </small>
        </button>
      ))}
    </div>
  );
}
