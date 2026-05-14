---
name: migrate-hooks-to-cline
description: Migrate Claude Code JSON-configured hooks into `.clinerules/hooks/` through an agent-led, script-backed workflow. The agent handles semantic migration and writes handler `.mjs`; thin scripts handle scanning, entry-script generation, verification, and cleanup. Do not handle skills, commands, agents, rules, or workflows.
---

# Hook Migration — Agent-Led Workflow

## Scope

Only migrate Claude Code JSON-configured hooks from:
- `hooks/hooks.json`
- `.claude/settings.json`
- `.claude/settings.local.json`

Do not scan or migrate skills, commands, agents, rules, or workflows.
Non-hook resources may be read only as source evidence when a hook depends on them.
Never emit install or migration steps that copy `skills/`, `.agents/skills/`, or `.claude/skills/` into `.cline/skills/`.

## Resource Location Map

Use this location map to keep resource boundaries explicit during migration:

```text
Source-side evidence

my-plugin/                          ← PLUGIN_ROOT（脚本中的变量指向这里）
│
├── .claude-plugin/
│   └── plugin.json                 ← 唯一必须在这里的文件（manifest）
│
├── skills/                         ← 技能（按需自动激活）
│   ├── using-skill/
│   │   ├── SKILL.md                ← 技能定义
│   │   ├── reference.md            ← 可选辅助文档
│   │   └── scripts/                ← 可选辅助脚本
│   │       └── helper.sh
│   └── code-reviewer/
│       └── SKILL.md
│
├── commands/                       ← 斜杠命令（旧方式，扁平 .md 文件）
│   ├── review.md                   → /plugin-name:review
│   └── deploy.md                   → /plugin-name:deploy
│
├── agents/                         ← 子代理角色
│   ├── code-reviewer.md
│   └── security-auditor.md
│
├── hooks/                          ← 事件钩子
│   ├── hooks.json                  ← 钩子配置入口
│   └── scripts/                    ← 钩子调用的脚本
│       ├── pre-edit.sh             ← 脚本中 SCRIPT_DIR/../ 即 PLUGIN_ROOT
│       └── validate.sh
│
├── .mcp.json                       ← MCP 外部服务集成
├── .lsp.json                       ← LSP 语言服务器配置
├── settings.json                   ← plugin 启用时的默认设置

Target-side Cline layout
.
├── .clinerules/
│   ├── hooks/                           # only writable target for this skill
│   ├── agents/                          # out of scope here
│   └── workflows/                       # out of scope here
└── .cline/
    └── skills/
        └── <skill-name>/                # out of scope here
```

Boundary rules:
- Treat non-hook resources as source evidence only when a hook reads them.
- Never translate a hook into `.cline/skills/`, `.clinerules/agents/`, `.clinerules/workflows/`, or another non-hook target.
- Preserve only the hook's runtime behavior when reading non-hook resources; do not turn that into skill, agent, workflow, or rules migration.

## Architecture

`agent-led + script-backed`:
- **Agent**: reads hook configs and scripts, decides migration strategy, writes handler `.mjs`.
- **Script**: prepares source, scans hooks, generates entry scripts, verifies output, cleans up.

Do not use `setup-plan.mjs`, action schemas, or runbook generation as the main path.

## Translation Contract

Treat the migrated handler contract as a hard contract, not a best-effort hint.

If the source hook injects startup instructions, context text, skill text, or any other user-visible prompt content via any of these shapes:
- top-level `message`
- top-level `additionalContext`
- top-level `additional_context`
- nested `hookSpecificOutput.additionalContext`
- plain stdout text intended for context injection

then the translated handler must write that final text to `stdout`.

Required handler output rule:
- handler `stdout` may be any user-visible text
- handler `stderr` is diagnostics only
- handler failure is expressed through non-zero exit code plus `stderr`
- Unix/Windows entry scripts treat collected `stdout` as literal text and convert it into final Cline `contextModification`
- if handler `stdout` happens to look like JSON, it is still treated as text rather than parsed

Implication:
- define handler behavior in terms of the final text it prints, not in terms of handler-level JSON fields

Failure rule for context hooks:
- If the source hook clearly injects context and the translated handler would emit empty `stdout` or otherwise omit the injected text, treat that hook as unresolved and fail explicitly.

Debugging rule:
- Never print logs or explanations to stdout.
- If debug output is needed, write it to stderr only.

## Source Traversal Rules

Do not stop at the top-level hook config or a single script file.

For each hook, the agent must inspect:
- the hook config entry
- the primary referenced script
- repo-local supporting scripts already surfaced in `agentContext.sourceFiles`
- any additional repo-local files that the primary script reads to construct hook output

If the hook builds context by reading files from multiple directories, inspect all repo-local directories referenced by that logic before translating.

Examples:
- a shell script that `cat`s one or more `SKILL.md` files
- a Node script that reads prompt fragments from several folders
- a wrapper script that dispatches into another repo-local helper

Directory traversal rule:
- When the source script checks multiple candidate directories in a precedence order, preserve that order in translation or explicitly fail if it cannot be preserved safely.
- Never collapse multi-directory lookup logic into a single hard-coded directory unless the source evidence proves only one directory is possible.

## Directory Path Translation Rules

Claude Code plugins use a flat layout (`PLUGIN_ROOT/skills/`, `PLUGIN_ROOT/agents/`, etc.) while Cline uses a nested layout (`.cline/skills/`, `.clinerules/agents/`). Source scripts reference these via `$CLAUDE_PLUGIN_ROOT/<dir>/` or `SCRIPT_DIR/../<dir>/`.

The `agentContext` returned by `prepare` provides:
- `directoryMapping`: the full mapping table
- `detectedDirectoryReferences`: every Claude directory reference found in source script content, with `referenceKind` distinguishing `plugin-root-variable`, `script-dir-relative`, and `bare-directory`
- `directWriteGuidance.directoryTranslationRules`: concrete per-pattern translation instructions

**Agent must**: translate every detected reference using the provided mapping; preserve lookup precedence; never hard-code `CLAUDE_PLUGIN_ROOT`, `SCRIPT_DIR/../`, or Claude directory paths in the handler; fail if any reference cannot be safely translated.

## Semantic Preservation Rules

Before writing any handler, build a per-hook migration worksheet from source evidence only.

The worksheet must cover:
- trigger conditions and matcher behavior
- consumed inputs: stdin fields, environment variables, cwd, argv, and repo-local files
- produced outputs and control signals: stdout text, stderr, exit codes, cancel/deny/pass-through behavior
- directory lookup precedence, fallback rules, and helper-call order
- repo-local dependencies versus unresolved external dependencies

Preservation rules:
- Only translate behavior that is provable from source evidence.
- Preserve branch conditions, side-effect order, and lookup precedence.
- Preserve injected context text exactly when it comes from static or repo-local source content.
- If injected text is assembled dynamically from repo-local files, preserve the same meaning, ordering, and file precedence without inventing extra guidance.
- Preserve exit-code semantics and decision behavior when the source hook uses them to block, fail, or pass through.
- If the source logic references `CLAUDE_PLUGIN_ROOT`, treat it as source-side path evidence only: resolve it to concrete repo-local paths during analysis, and do not require `CLAUDE_PLUGIN_ROOT` at migrated-hook runtime. If equivalent repo-local path resolution cannot be preserved safely, fail explicitly.
- Do not strengthen matchers, relax matchers, or widen the hook trigger scope without direct source evidence.
- Do not collapse conditional behavior into unconditional successful pass-through.
- If a wrapper is sufficient, keep it minimal and behavior-preserving; if it is not behavior-preserving, rewrite or fail.

## Pre-Write Quality Gate

Before writing `.clinerules/hooks/<EventName>-<plugin-slug>.mjs`, the agent must be able to answer yes to all of the following:
- Can every emitted Cline output field be traced back to specific source behavior?
- Can every consumed Cline event field be justified by the original hook input contract?
- Is handler `stdout` guaranteed to contain only the final user-visible text that should be injected?
- Are logs and diagnostics isolated to stderr?
- Are file reads, path lookups, helper invocations, and environment-variable dependencies either preserved or explicitly marked unresolved?
- If choosing rewrite over wrapper, is the rewrite limited to behavior proved by the source rather than a speculative reimplementation?
- Are all detected Claude directory references translated per `agentContext.directoryMapping`, with zero Claude-specific paths remaining?

Mandatory failure conditions:
- Source behavior depends on shell pipelines, dynamic eval, or command chaining that cannot be modeled safely.
- Hook correctness depends on external binaries, network services, or filesystem locations that are not repo-local and not safely reproducible.
- The translation cannot explain how source exit codes or decision branches map to final Cline output.
- Required injected text, matcher gates, or blocking behavior cannot be traced to source evidence.
- The translation would need to invent prompt text, default values, or fallback behavior not present in the source.
- A Claude-specific directory reference cannot be safely translated to a Cline equivalent.

## Entry Decision

On entering this skill:
1. Check if the current project has local Claude hook content.
2. If yes → scan locally.
3. If the user explicitly provided a repo source (e.g. `obra/superpowers`) → run with `--repo <source>`.
4. If no local hooks and no source given → fail explicitly and prompt for `--repo <source>`.

Do not push this logic to an upstream orchestration prompt.

## Output Layout

```text
.clinerules/hooks/
  <EventName>           # Unix entry script (generated by script)
  <EventName>.ps1       # Windows entry script (generated by script)
  <EventName>-<plugin-slug>.mjs  # JS handler (written by agent)
```

Success criteria:
1. `.clinerules/hooks/` contains the expected files.
2. All `.mjs` files pass `node --check`.
3. `verify-hooks.mjs` has actually executed the generated entry scripts against the real migrated handlers and received valid Cline JSON.
4. Unresolved hooks fail explicitly.

## Script Inventory

All scripts live under `scripts/`:

| File | Role |
|------|------|
| `run-migration.mjs` | Main entrypoint; exposes `prepare` and `finalize` subcommands |
| `scan-hooks.mjs` | Scans hook configs; returns hook facts only |
| `verify-hooks.mjs` | Checks file existence, runs `node --check`, executes real entry scripts, and surfaces runtime stderr/stdout on failure |
| `utils.mjs` | Shared helpers for paths, events, naming, logging |

## Script Location Rule

Treat `scripts/` as relative to the directory containing this `SKILL.md`, not relative to the current working directory.

- If this skill was installed by the CLI into a target project, the usual script path is:

  ```bash
  node .agents/skills/migrate-hooks-to-cline/scripts/run-migration.mjs prepare
  ```

Never copy `run-migration.mjs` into another directory and run it detached from its sibling files. `scan-hooks.mjs`, `verify-hooks.mjs`, and `utils.mjs` must remain in the same skill-local `scripts/` directory.

### `run-migration.mjs`

- **Subcommands**: `prepare`, `finalize`
- **Parameter**: `--repo <source>` (optional; falls back to local project)
- **Remote source**: clones into `<project>/.tmp/<repo-name>` before scanning
- `prepare` returns scan + source context; does not delete the workspace early.
- `finalize` generates entries, verifies, then cleans up `.tmp/<repo-name>`.

### `scan-hooks.mjs`

- Scans `hooks/hooks.json` and `.claude/settings*.json`
- Returns hook facts: source, event, matcher, command, referenced script path
- Does not claim a hook is already migrated

### `verify-hooks.mjs`

- Checks that expected output files exist
- Runs `node --check` on every `.mjs`
- Executes the generated shell / ps1 entry scripts against the real migrated handlers
- Feeds each event a minimal stdin fixture and requires valid Cline JSON on stdout
- On failure, prints the real `eventName`, `entryScript`, `exitCode`, `stdout`, and `stderr`
- Fails the entire migration if unresolved hooks remain

### `utils.mjs`

- Path helpers, event mapping, stable naming, minimal logging

## Agent Workflow

1. **Initialize** — Use `TodoWrite` to create a migration task list.
2. **Prepare** — Run the prepare command:

   ```bash
   node <current-skill-dir>/scripts/run-migration.mjs prepare
   ```

   If a repo source was provided:

   ```bash
   node <current-skill-dir>/scripts/run-migration.mjs prepare --repo <user>/<repo>
   ```

   `<current-skill-dir>` means the directory containing this `SKILL.md`, for example `.agents/skills/migrate-hooks-to-cline` or `.claude/skills/agents-hub-setup-guide-migration`.

   - **Script entry**: `run-migration.mjs`
   - **Subcommand**: `prepare`
   - **Function**: `runMigration()`
   - **What it does**:
     - Decide local vs remote source
     - `git clone` if needed
     - Scan Claude hooks
     - Collect source scripts and supporting scripts
     - Build `agentContext`
     - Return `awaiting-agent-migration`

3. **Load references first** — Before classifying any hook or writing any handler, the agent must open and read:
   - `references/cline-migration-rules.md`
   - `references/difference.md`

   If migration semantics, event mapping, or wrapper-vs-rewrite tradeoffs are still unclear, also open:
   - `references/2026-05-09-claude-code-cline-hooks-research.md`

   Reference-loading rules:
   - Do not treat a filename mention in this `SKILL.md` as sufficient; actually open the reference file.
   - Do not skip the two required references even if the current hook looks simple.
   - Do not start classification or code writing until the required references have been read.

4. **Study** — Read `agentContext`: hook facts, original scripts, supporting scripts.
   - If a source script reads additional repo-local files to produce output, open those files too before deciding on migration.
   - For context-injection hooks, identify exactly where the source text comes from and rewrite the handler so that exact final text becomes plain `stdout`.
   - Build the per-hook migration worksheet before choosing wrapper versus rewrite.
5. **Classify each hook**:
   - Safe JS rewrite
   - Wrapper is sufficient
   - Not safely migratable
   - Run the pre-write quality gate; if any item fails, mark the hook unresolved instead of guessing.
6. **Write handlers** — Only write:
   - `.clinerules/hooks/<EventName>-<plugin-slug>.mjs`
7. **Finalize** — Hand results back to the script layer:

   ```bash
   node <current-skill-dir>/scripts/run-migration.mjs finalize --project-root . --cleanup-path .tmp/<repo-name>
   ```

   `finalize` reads the agent result from **stdin** (e.g. `expectedFiles`, `unresolvedHooks`).

   - **Script entry**: `run-migration.mjs`
   - **Subcommand**: `finalize`
   - **Function**: `finalizeMigration()`
   - **What it does**:
     - Receive `expectedFiles` and `unresolvedHooks`
     - Call `generateEntryScriptsForHandlers()`
     - Call `verifyHooks()`
     - Call `cleanupMigrationSource()` **only after verify passes**
   - `verify` failure is not a soft warning. It means migration is still incomplete.
   - After a `verify` failure, read the real stderr/stdout from the script output and repair only the generated `.mjs` handler files.
   - Do not edit the fixed shell / ps1 entry templates to hide handler problems.
   - After each handler fix, rerun `finalize`.
   - Retry at most 3 times. If verification still fails, mark the hook set `unresolved` instead of claiming success.

8. **Completion** — Skill is only done after script finalize finishes.

Never skip `finalizeMigration()` and manually invoke `verify-hooks.mjs`.

## Agent Write Boundary

- **Allowed**: `.clinerules/hooks/<EventName>-<plugin-slug>.mjs`
- **Forbidden**: entry scripts, `.tmp` cleanup, treating unresolved hooks as successful, and patching fixed entry templates to mask handler failures

## Script Responsibilities

Script handles only deterministic work:
- Clone or prepare source workspace
- Scan hooks
- Collect supporting scripts
- Return agent-consumable context
- Generate fixed Unix/Windows entry scripts from handlers
- Verify final output
- Cleanup temporary clone directories **after verification succeeds**

## Path Boundaries

- `sourceRoot` — used only for scanning source code and reading original hooks.
- `targetRoot` — used only for writing `.clinerules/hooks`.
- `cleanupPath` — used only for remote clone temporary directories.
- Cleanup must happen **after** verification passes.
- If verification fails, keep the workspace; do not cleanup early.

## Done Condition

Skill is complete only when all of the following are true:
- Agent has written the handler `.mjs` files.
- Script-generated entry files exist, real entry execution verification has passed, and cleanup happened only after verification.
- Any source context injection has been preserved through handler `stdout` and final entry-script `contextModification`.
- No outstanding verify failure remains unresolved.

## Event Mapping

- Direct mappings stay mechanical.
- Semantic best-effort mappings require agent review.
- Hooks with no safe Cline equivalent must fail as `not-migrated`.

## Failure Rule

Default for unresolved or unsafe hooks is **failure**, not fake success.

Examples of failure:
- Unsupported event with no safe Cline equivalent
- Shell pipeline or chained command that cannot be represented safely
- Hook logic depending on opaque external behavior
- Script path not provable from repo contents

## References

- `references/cline-migration-rules.md` — script/agent boundary, handler classification, verification rules
- `references/difference.md` — Claude Code vs Cline hooks comparison
