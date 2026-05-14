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

## Resource Location Map

Use the `Resource Location Map` in `SKILL.md` as the canonical tree.

Boundary rules:
- Non-hook resources may be read as source evidence only when a hook depends on them.
- Hooks must never be translated into `.cline/skills/`, `.clinerules/agents/`, `.clinerules/workflows/`, or other non-hook targets.
- Do not reinterpret hook translation as a skill, workflow, agent, or rules migration task.

Compatibility rule:
- Callers should not need to pass the full orchestration prompt for compatibility behavior.
- If the current project already contains Claude hook configs and hook content, the skill should scan the local project directly.
- If the local project has no Claude hook content, the skill must require `run-migration.mjs --repo <source>`.
- If the user prompt explicitly names a repo source such as `obra/superpowers`, the skill should pass it through as `--repo <source>`.
- Any command invoking `run-migration.mjs` must use the script path under the current skill directory; do not assume the working directory is the skill root.

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
- write outputs outside `.clinerules/hooks/` for this skill

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

The entry script is responsible for reading Cline event input once, discovering all `<EventName>-*.mjs` handlers for that event, invoking them sequentially, collecting stdout as literal text, and emitting the final Cline JSON. There is no separate dispatcher layer.

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

## Semantic Preservation Gate

Before writing a handler, the agent must build a per-hook migration worksheet from source evidence only.

Minimum worksheet fields:
- trigger conditions and matcher behavior
- consumed inputs: stdin fields, environment variables, cwd, argv, repo-local files
- produced outputs and control signals: stdout text, stderr, exit codes, cancel/deny/pass-through behavior
- lookup precedence, fallback rules, and helper-call order
- unresolved external dependencies
- Claude-specific directory references and their Cline translations (use `agentContext.directoryMapping` and `agentContext.detectedDirectoryReferences`)

Hard rules:
- Only translate behavior that is provable from source evidence.
- Preserve matcher gates, branch conditions, side-effect order, and lookup precedence.
- Preserve injected context text exactly when it comes from static or repo-local source content.
- Treat handler stdout as arbitrary literal text; if it happens to look like JSON, do not rely on parsing it.
- Preserve exit-code semantics and block/fail/pass-through behavior when the source uses them.
- If the source logic references `CLAUDE_PLUGIN_ROOT`, treat it as source-side path evidence only: resolve it to concrete repo-local paths during analysis, and do not require `CLAUDE_PLUGIN_ROOT` at migrated-hook runtime. If equivalent repo-local path resolution cannot be preserved safely, fail explicitly.
- Do not widen trigger scope or invent fallback behavior that the source does not contain.
- If a wrapper is chosen, it must be behavior-preserving and minimal.
- Every Claude-specific directory path must be translated using `agentContext.directoryMapping`; never leave `CLAUDE_PLUGIN_ROOT`, `SCRIPT_DIR/../`, or Claude subdirectory references in the handler. Fail if any reference cannot be safely translated.

## Directory Path Translation

Claude Code uses a flat plugin layout (`PLUGIN_ROOT/skills/`, `agents/`, `hooks/`); Cline uses a nested layout (`.cline/skills/`, `.clinerules/agents/`, `.clinerules/hooks/`). The `agentContext` returned by `prepare` provides:

- `directoryMapping`: full mapping table
- `detectedDirectoryReferences`: every Claude directory reference found in source scripts, with `referenceKind` (`plugin-root-variable` / `script-dir-relative` / `bare-directory`) and `subsequentDirMapping` for `SCRIPT_DIR/../` patterns
- `directWriteGuidance.directoryTranslationRules`: concrete per-pattern instructions

Key points: translate `$CLAUDE_PLUGIN_ROOT/<dir>/` and `SCRIPT_DIR/../<dir>/` using the provided mapping; preserve lookup precedence; never hard-code Claude paths in the handler; fail if translation is ambiguous.

### Example: CLAUDE_PLUGIN_ROOT → Cline

Source: `$CLAUDE_PLUGIN_ROOT/skills/$NAME/SKILL.md` → Handler: `path.join(workspaceRoot, '.cline', 'skills', name, 'SKILL.md')`

Source: `$SCRIPT_DIR/../skills/$NAME/SKILL.md` → Handler: `path.join(workspaceRoot, '.cline', 'skills', name, 'SKILL.md')`

## Pre-Write Quality Gate

Before a `.mjs` handler is written, the agent must be able to answer yes to all of the following:
- every emitted Cline field is traceable to source behavior
- every consumed Cline event field is justified by the original hook input contract
- handler stdout will contain only the final user-visible text
- logs and diagnostics are isolated to stderr
- file reads, path lookups, helper invocations, and environment-variable dependencies are preserved or declared unresolved
- any rewrite is limited to behavior proved by the source

Fail the migration instead of guessing when:
- shell pipelines, command chaining, or dynamic eval are required for correctness
- correctness depends on external binaries, network services, or non-repo-local filesystem state
- exit-code mapping or decision branches cannot be explained
- required injected text or matcher/blocking behavior cannot be traced to source evidence
- translation would need invented prompt text, defaults, or fallback behavior

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
- source-side environment variable assumptions that may need to be resolved away during migration
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
