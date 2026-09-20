# Skills

Settings → Skills imports a standard directory containing `SKILL.md` and its
associated scripts, references and assets. Zen copies the complete directory
into `<ZENX_DATA_DIR>/skills/<id>` (the default data directory is `~/.zen`). The
source stays untouched and can be moved or removed after import. Importing again
creates a separate copy and identity, including when the name is the same.

`SKILL.md` starts with YAML frontmatter containing `name` and `description`,
followed by Markdown instructions. Quoted and multiline YAML values are supported.
Names contain 1–64 letters, digits, hyphens or underscores; descriptions contain
1–4096 characters. `agents/openai.yaml` and other associated files are preserved;
they do not implicitly opt a Skill into Zen model visibility.

## Modes and precedence

- **Manual use** is the default. Neither the name, description, path nor body is
  automatically sent to the model. The Skill remains in the user's slash menu.
- **Automatically visible** adds only name, description and the local `SKILL.md`
  path to each newly admitted message. The model can read the body and resources
  through its existing file tools when appropriate; those results follow ordinary
  canonical tool history.
- **Disabled** removes the Skill from slash candidates and rejects new explicit
  loads. It does not erase previously captured history or restrict general file
  access granted by the Thread's file permission policy.

The optional package file `agents/zen.yaml` can declare:

```yaml
policy:
  model_visible: false
  enabled: true
```

An explicit user override takes precedence over this package policy, then the
manual default. Settings shows the effective mode, configuration source, original
source and local copy. Mode changes save immediately. **Use package default**
removes the user override without editing the package. User settings live in
`skills/config.json`, separately from package files and conversation history.

## Explicit use and replay

Type `/` and select a Skill. The candidate shows its source and a short identity
to distinguish names. Selection creates a removable reference in the draft; it
does not read instructions or send a model request. Sending loads the selected
body and includes its original source, local resource directory and SHA-256.

ZAS owns this loading at the shared start, queue, steer and replacement admission
boundary. All callers of the same Host receive the same automatic directory
policy. Native clients can submit explicit references using `zen/turn/send`:

```json
{
  "threadId": "thread-id",
  "mode": "start",
  "clientUserMessageId": "stable-message-id",
  "input": [
    { "type": "text", "text": "Review this change" },
    { "type": "skill", "id": "imported-skill-id" }
  ]
}
```

Modes are `start`, `queue`, `steer` and `replace`; the latter two require the
current `expectedTurnId`. Native image/audio parts use canonical attachment
references. Approval handling uses the same connection approval channel as
ordinary sends. CAS's fixed mapped surface is unchanged.
The connection must first complete `initialize` → `initialized` or explicitly
call `zen/initialize`. A native resume/read alone does not authorize sending;
all four send modes reject an uninitialized connection before any append.

A `start` retry with the same client message ID and original input returns the
already delivered Turn ID without appending or executing again. This applies
while that Turn runs and after completion or Host restart, even when the Skill
has since changed or been disabled. Reusing the ID with different input returns
`idempotency_conflict`. Ordinary starts without a client ID remain independent.
Queued and replacement intents are not proof of delivery: their internal
launches still execute the captured input once.
Pending intents also reserve their original input for that client ID. A public
start with different input fails without consuming or modifying the intent;
matching queued input can be delivered across modes using its saved snapshot.

Loaded text and `skillSource` provenance are stored in existing canonical input
parts. Queue draining, replacement launch and identical message retries reuse
that snapshot. Editing, disabling or removing a package does not rewrite old
messages. Resume replays recorded content; compaction uses ordinary canonical
compaction semantics and never reloads installed Skills. Earlier directory
metadata remains part of historical inputs, even when visibility later changes.

## Budgets and errors

- Automatic directory: **16 KiB UTF-8**, including its explanatory header.
- Explicit bodies: **128 KiB UTF-8 total per message**; `SKILL.md` also has a
  128 KiB individual read limit. Source receipts are additional small text.
- One imported directory: **64 MiB**, **4096 entries**, **32 directory levels**.
- At most **1000 imported directories**; package policy is limited to **8 KiB**.

Overflow, unreadable or malformed packages and disabled explicit references fail
clearly before canonical input is appended; no silent truncation or automatic
fallback is used. Imports reject symbolic links and special files: put a regular
copy of those resources inside the source directory first. Package scripts are
preserved but never executed by import or selection.

Standard package conventions follow the
[official Skills documentation](https://learn.chatgpt.com/docs/build-skills).
Zen deliberately differs in its default: manual Skills disclose no metadata.
