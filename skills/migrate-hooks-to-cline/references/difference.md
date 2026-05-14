# Claude Code and Cline Differences — Hooks

This reference covers hook migration only. Other resource types are handled by `agents-hub install`.

## Hook systems compared

| Aspect | Claude Code | Cline | Migration implication |
|--------|-------------|-------|----------------------|
| Configuration | JSON config in `.claude/settings.json` or `hooks/hooks.json` | No JSON config; executable scripts in `.clinerules/hooks/` | Must generate wrapper scripts that replace JSON config |
| Invocation | Config specifies matcher + handler type + command | Script filename must match event name; Cline passes event JSON via stdin | Wrapper script name = event key; wrapper reads stdin and calls original command |
| Handler types | `command`, `http`, `mcp_tool`, `prompt`, `agent` | Executable scripts only (`command` equivalent) | Only `command` handlers with local scripts can be wrapped; all others are not migrated |
| Environment | `CLAUDE_PLUGIN_ROOT` set by Claude Code runtime | Not set automatically | Resolve `CLAUDE_PLUGIN_ROOT` to repo-local paths during migration; migrated handlers must not depend on it at runtime |
| Stdin/stdout | Command receives Claude-style JSON and may signal decisions through Claude-style output / exit status | Script receives Cline event JSON on stdin; event entry emits final Cline response JSON | Handler should print final user-visible text to stdout, while the event entry script treats that stdout as literal text and wraps it into final Cline JSON |
| Platform support | Host-dependent (bash on Unix, cmd on Windows) | Cross-platform via `.sh` (Unix) + `.ps1` (Windows) | Generate both `.sh` and `.ps1` wrappers for every migrated hook |

## Cline hook paths

- Unix hooks: `.clinerules/hooks/<EventName>` (executable, no extension)
- Windows hooks: `.clinerules/hooks/<EventName>.ps1`

## Rules

- Generate wrappers only for `command` handlers that point to repo-local executable scripts.
- Do not generate wrappers for `http`, `mcp_tool`, `prompt`, or `agent` handlers.
- Do not generate wrappers for commands that reference external URLs or global paths.
- Always preserve the original JSON config as reference material.
- Do not require `CLAUDE_PLUGIN_ROOT` at migrated-hook runtime. If the source command uses it, resolve it during migration and preserve the equivalent repo-local path behavior explicitly, or mark the hook unresolved.
- Always read Cline stdin JSON and pass normalized Claude-style JSON to the original script.
- Preserve basic matcher behavior inside the wrapper; skip non-matching tool calls with a successful empty result.
- Preserve user-visible text as handler stdout; the event entry script wraps aggregated text into final Cline JSON.
- If handler stdout happens to look like JSON, treat it as text rather than parsing it.
- Generated compatibility wrappers run on Node.js at Cline hook runtime.
- If multiple Claude handlers map to the same Cline event, the event entry script (`shell` / `ps1`) calls each translated `.mjs` handler sequentially and preserves handler order.
- Mark every hook wrapper with `auto: false` and a non-null risk.

## Official Cline field shape used by wrappers

Wrappers prefer hook-specific objects before top-level fallbacks:

| Cline event JSON | Claude-style JSON |
|------------------|-------------------|
| `preToolUse.toolName`, fallback `toolName` | `tool_name` |
| `preToolUse.parameters`, fallback `toolInput` / `tool_input` | `tool_input` |
| `postToolUse.toolName`, fallback `toolName` | `tool_name` |
| `postToolUse.parameters`, fallback `toolInput` / `tool_input` | `tool_input` |
| `userPromptSubmit.prompt`, fallback `prompt` | `prompt` |
| `taskId` | `session_id` fallback |
| `workspaceRoots[0]`, fallback `cwd` | `cwd` fallback |
