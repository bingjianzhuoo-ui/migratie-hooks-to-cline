# Cline Migration Rules — Agent-Led, Script-Backed

This reference defines the migration boundary for Claude Code hooks only.
All other resource types are outside this skill and should continue to be handled by `agents-hub install`.

## Scope

This skill only processes hooks declared in:
- `hooks/hooks.json`
- `.claude/settings.json`
- `.claude/settings.local.json`

This skill does not process:
- skills
- commands
- agents
- rules
- workflows
- native Cline hooks already living under `hooks/cline/`

Compatibility rule:
- Callers should not need to pass the full orchestration prompt for compatibility behavior.
- If the current project already contains Claude hook configs and hook content, the skill should scan the local project directly.
- If the local project has no Claude hook content, the skill must require `run-migration.mjs --repo <source>`.
- If the user prompt explicitly names a repo source such as `obra/superpowers`, the skill should pass it through as `--repo <source>`.

## Core Boundary

The migration model is:

```text
repo
  -> run-migration.mjs prepare --repo <source>
  -> clone into .tmp/<repo-name> when needed
  -> scan-hooks.mjs
  -> agent reads hook scripts and supporting files
  -> agent decides migration result
  -> agent writes .clinerules/hooks/<EventName>-<plugin>.mjs
  -> run-migration.mjs finalize
  -> script generates .clinerules/hooks/<EventName> and <EventName>.ps1
  -> verify-hooks.mjs
  -> cleanup .tmp/<repo-name>
  -> success / fail
```

The agent owns semantic migration and handler `.mjs` output.
Scripts own only deterministic work.

### Scripts may do

- discover hook config files
- clone a repo source into the current project `.tmp/` directory
- parse hook config into normalized facts
- resolve referenced local script paths
- map raw events into candidate Cline events
- generate fixed event entry scripts from migrated handlers
- run minimal verification
- cleanup the temporary clone directory after verification succeeds

### Scripts must not do

- pretend to understand hook semantics
- claim a hook is migrated purely from file extension
- auto-approve risky event mappings
- silently downgrade unresolved hooks to success
- generate the final result around `setup-plan.mjs`, runbooks, or action schemas

## Minimal Script Set

Keep the implementation limited to:

- `run-migration.mjs`
- `scan-hooks.mjs`
- `verify-hooks.mjs`
- `utils.mjs`

Do not re-expand into layered generator/validator/orchestration subsystems.

## Output Contract

All generated artifacts live in `.clinerules/hooks/`:

```text
.clinerules/hooks/
  <EventName>
  <EventName>.ps1
  <EventName>-<plugin-slug>.mjs
```

### Naming Convention

- Unix entry: `<cline-event>`
- Windows entry: `<cline-event>.ps1`
- JS handler: `<cline-event>-<plugin-slug>.mjs`

The entry script is responsible for reading Cline event input once, discovering all `<EventName>-*.mjs` handlers for that event, invoking them sequentially, collecting stdout, and emitting the final Cline JSON. There is no separate dispatcher layer.

Ownership:
- agent writes `<EventName>-<plugin-slug>.mjs`
- script layer writes `<EventName>` and `<EventName>.ps1`

## Scan Output Contract

`scan-hooks.mjs` should output hook facts only.

Required fields:
- hook source
- original event
- candidate Cline event
- matcher
- command
- runtime hint
- resolved script path when provable

Optional fields:
- plugin root
- supporting script candidates
- source config path

Forbidden fields:
- `alreadyMigrated`
- `autoApproved`
- any field that claims semantic correctness without agent review

## Handler Classification

Classification is a triage input for the agent, not the migration result by itself.

| Input shape | Initial classification | Meaning |
|-------------|------------------------|---------|
| local `.js/.mjs/.cjs` script | `candidate-js` | likely can be wrapped or lightly rewritten, still requires agent review |
| local `.sh/.bash/.py/.ps1/.cmd/.bat` script | `rewrite-required` | likely needs JS rewrite before safe Cline use |
| local extensionless script | `rewrite-required` | runtime is ambiguous; safe migration requires inspection |
| inline command, shell operators, pipeline, redirect | `not-migrated` | cannot be safely auto-migrated |
| non-`command` handler types | `not-migrated` | out of supported boundary |

The agent must still inspect the original hook logic before producing a final handler.

## Event Mapping

### Direct mappings

| Claude Code | Cline |
|-------------|-------|
| PreToolUse | PreToolUse |
| PostToolUse | PostToolUse |
| UserPromptSubmit | UserPromptSubmit |
| PreCompact | PreCompact |

### Semantic best-effort mappings

| Claude Code | Cline | Review requirement |
|-------------|-------|--------------------|
| SessionStart | TaskStart | agent must confirm idempotency and lifecycle differences |
| Stop | TaskComplete | agent must account for cancelability and timing differences |
| PostToolUseFailure | PostToolUse | agent must preserve failure-only behavior |
| SessionEnd | TaskComplete | agent must verify cleanup semantics |
| TaskCreated | TaskStart | agent must verify creation vs start timing |
| TaskCompleted | TaskComplete | agent must verify output behavior |
| Setup | TaskStart | agent must verify whether repeated execution is safe |

### No safe equivalent

Mark these as `not-migrated` unless a later design explicitly supports them:

`SubagentStart`, `SubagentStop`, `Notification`, `ConfigChange`, `FileChanged`, `CwdChanged`, `InstructionsLoaded`, `UserPromptExpansion`, `PostCompact`, `TeammateIdle`, `Elicitation`, `ElicitationResult`, `StopFailure`, `PermissionRequest`, `WorktreeCreate`, `WorktreeRemove`

## Agent Review Rules

For each hook, the agent must explicitly decide one of:

1. safe JS rewrite
2. wrapper is sufficient
3. not safely migratable

The decision must be based on reading:
- the hook config entry
- the referenced script
- supporting local scripts when the primary script dispatches elsewhere

Do not stop at runtime classification when the repo still contains enough information to understand the hook behavior.

## Verification Rules

`verify-hooks.mjs` should stay minimal but real.

Required checks:
- expected files exist
- generated `.mjs` files pass `node --check`
- entry script (`shell` or `ps1`) accepts minimal stdin and returns valid JSON
- at least one required hook path can be executed end-to-end when applicable

Failure rules:
- unresolved required hook -> fail
- syntax error -> fail
- entry-script smoke test failure -> fail
- missing generated file -> fail

Do not replace runtime verification with schema-only validation.

## Risk Rules

Every migrated hook should still account for:
- stdin/stdout contract differences between Claude Code and Cline
- matcher compatibility limits
- environment variable assumptions
- Node runtime dependency
- lifecycle differences for semantic event mappings
- platform-specific behavior in original scripts

## Not-Migrated Boundary

Emit `not-migrated` when:
- the handler is not a `command`
- the command depends on shell operators or multi-step pipelines
- the command references external paths or tools that cannot be proven from the repo
- the event has no safe Cline equivalent
- the hook behavior cannot be understood safely from local evidence

## Success Standard

Migration is successful only when:
1. `.clinerules/hooks/*` has been written
2. script-generated event entry files exist
3. generated JS passes minimal verification
4. agent review considers the migrated hooks semantically acceptable

Anything less is an incomplete migration, not a soft success.
