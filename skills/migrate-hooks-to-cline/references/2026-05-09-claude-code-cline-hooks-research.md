# Claude Code 与 Cline Hooks 机制调研说明

> 调研时间：2026-05-09
> 用途：为 `agents-hub-setup-guide-migration` skill 的后续优化提供机制层面的参考依据

---

## 一、Claude Code Hooks 机制

### 1.1 核心定位

Hooks 是 Claude Code 提供的生命周期拦截器（middleware），允许用户在特定执行节点插入自定义逻辑。它们运行在 agentic loop 之外，属于确定性脚本而非 AI 推理，用于实现：安全护栏、审计日志、自动化工作流、上下文注入、外部系统集成。

### 1.2 配置方式

Claude Code 采用 **JSON 配置驱动** 的 hooks 体系：

- **全局配置**：`~/.claude/settings.json`
- **项目级配置**：`<project>/.claude/settings.json`
- **托管/企业级**：`managed-hooks.json`（最高优先级，用户不可禁用）
- **Agent/Skill 级**：直接在 YAML frontmatter 中声明（Agent-scoped hooks，v2.1.0+）

配置结构三层嵌套：`hook event` → `matcher group` → `hook handler`。

### 1.3 Hook Event 类型（约 24 个）

按触发频率分类：

| 频率 | Event 示例 | 用途 |
|------|-----------|------|
| 每会话一次 | `SessionStart`, `SessionEnd`, `Setup` | 环境初始化、状态保存 |
| 每轮一次 | `UserPromptSubmit`, `Stop`, `StopFailure` | 提示词注入、结果校验 |
| 每次 tool call | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | 安全拦截、自动格式化 |
| 其他 | `SubagentStart`, `SubagentStop`, `Notification`, `PreCompact`, `ConfigChange`, `FileChanged` | 子agent追踪、上下文压缩前干预 |

### 1.4 Handler 类型（5 种）

| 类型 | 说明 | 输入方式 | 输出方式 |
|------|------|---------|---------|
| `command` | 执行 shell 命令 | stdin JSON | exit code + stdout/stderr JSON |
| `http` | POST 到指定 URL | request body JSON | response body JSON |
| `mcp_tool` | 调用已连接的 MCP server 工具 | — | — |
| `prompt` | 单轮 LLM 评估（Haiku） | prompt 模板 | yes/no JSON 决策 |
| `agent` | 多轮 subagent 验证（实验性） | 可读写文件、执行命令 | 最多 50 个 tool-use turns |

### 1.5 关键行为特性

- **并行执行**：所有匹配的 hooks 并行运行，相同 handler 自动去重。
- **决策合并**：多 hook 冲突时取最严格结果。`PreToolUse` 中 `deny` > `ask` > `allow`。
- **异步模式**：handler 可在首行 stdout 输出 `{"async": true}`，让操作不等待 hook 完成。
- **环境变量**：`$CLAUDE_CODE_REMOTE` 标记远程环境；`CLAUDE_PLUGIN_ROOT` 在 Claude Code 源运行时指向项目根目录，这一事实只应用于源码分析，不应直接延续为迁移后 handler 的运行时依赖。
- **特殊环境注入**：`SessionStart`, `Setup`, `CwdChanged`, `FileChanged` 接收 `CLAUDE_ENV_FILE`，Bash hook 可写入 `export VAR=value` 供后续 Bash tool 使用。
- **Exit code 语义**：
  - `0`：正常通过
  - `exit 2` + stderr：阻断操作（stderr 发给 model）
  - 其他非零：通用错误，可能阻断
  - `Stop`/`SubagentStop` 的 exit 2：表示 "继续执行，不要停止"

### 1.6 Matcher 机制

通过正则匹配过滤事件触发范围：

- `PreToolUse`/`PostToolUse`：匹配 `tool_name`（如 `"Bash"`, `"Edit|Write"`）
- `Notification`：匹配 `notification_type`
- `SubagentStart`/`SubagentStop`：匹配 `agent_type`
- `SessionStart`：匹配 `source`（`"startup"`, `"resume"`）
- 不支持 matcher 的事件：`UserPromptSubmit`, `Stop`, `TeammateIdle`, `TaskCompleted` 等

### 1.7 Agent-Scoped Hooks

v2.1.0 引入，在 agent YAML frontmatter 中定义，仅在该 agent 生命周期内生效，支持 6 个事件：`PreToolUse`, `PostToolUse`, `PermissionRequest`, `PostToolUseFailure`, `Stop`（运行时转为 `SubagentStop`）, `SubagentStop`。

**与 Global Hooks 的关系**：Agent-scoped hooks 在 agent 激活时覆盖全局 hooks。

---

## 二、Cline Hooks 机制

### 2.1 核心定位

Cline 的 hooks 同样是生命周期拦截器，但设计理念更简洁：**无 JSON 配置，纯可执行脚本驱动**。脚本在特定执行节点自动运行，通过 stdin 接收事件 JSON，通过 stdout 返回决策 JSON。

### 2.2 配置方式

Cline 采用 **文件系统约定驱动**：

- **全局 hooks**：`<global-config-dir>/hooks/<EventName>` 或 `<EventName>.ps1`
- **Workspace hooks**：`.clinerules/hooks/<EventName>` 或 `<EventName>.ps1`

无 JSON 配置文件，脚本文件名必须精确匹配 event 名称。

### 2.3 Hook Event 类型（8 个）

| Event | 触发时机 | 可取消 |
|-------|---------|--------|
| `TaskStart` | 新任务开始 | 是 |
| `TaskResume` | 中断任务恢复 | 是 |
| `TaskCancel` | 用户取消任务 | 否（仅观察） |
| `TaskComplete` | 任务成功完成 | 否 |
| `PreToolUse` | 工具执行前 | 是 |
| `PostToolUse` | 工具执行后 | 是（可停止任务，但无法撤销已执行的工具） |
| `UserPromptSubmit` | 用户提交消息 | 是 |
| `PreCompact` | 上下文压缩前 | 是 |

### 2.4 Handler 类型

Cline 仅支持 **可执行脚本**（等价于 Claude Code 的 `command` 类型），无 `http`/`mcp_tool`/`prompt`/`agent` 等高级 handler。

### 2.5 关键行为特性

以下内容描述的是 Cline hook 平台原生能力与研究观察，不等于本 skill 当前采用的迁移 contract。
本 skill 当前约定为：translated handler 只输出最终用户可见文本到 `stdout`，再由 event entry script 统一包装成最终 Cline JSON。

- **跨平台**：同时支持 Unix（无扩展名的 bash 脚本）和 Windows（`.ps1` PowerShell 脚本）。
- **执行顺序**：Global hooks 先执行，然后 Workspace hooks。任一返回 `cancel: true` 即停止操作。
- **超时**：30 秒超时，超时后终止 hook 进程并继续。
- **上下文注入**：hook 可返回 `contextModification` 字符串，注入到下一轮用户消息中。
- **状态跟踪**：`TaskState` 维护 `activeHookExecution`，支持取消和 UI 更新。

### 2.6 输入输出契约

Hook 接收的 JSON 字段按类型命名：

- `taskStart` / `taskResume` / `taskCancel` / `taskComplete`：`{ taskMetadata: { taskId, ulid, ... } }`
- `preToolUse`：`{ toolName: string, parameters: object }`
- `postToolUse`：`{ toolName, parameters, result: string, success: boolean, executionTimeMs: number }`
- `userPromptSubmit`：`{ prompt: string, attachments: string[] }`
- `preCompact`：`{ taskId, ulid, contextSize, compactionStrategy, tokensIn, tokensOut, ... }`

---

## 三、Claude Code vs Cline 对比

| 维度 | Claude Code | Cline | 迁移影响 |
|------|-------------|-------|---------|
| **配置方式** | JSON 配置（settings.json / hooks.json） | 文件系统约定（可执行脚本） | 必须将 JSON 配置转换为可执行脚本 |
| **Event 数量** | 约 24 个 | 8 个 | 大量事件无 Cline 等价物，只能标记 not-migrated |
| **Handler 类型** | 5 种（command, http, mcp_tool, prompt, agent） | 仅 command（可执行脚本） | http/mcp_tool/prompt/agent 均不可迁移 |
| **Matcher** | 支持正则匹配过滤 | 无 matcher 机制 | Cline 脚本需自行在内部实现过滤逻辑 |
| **环境变量** | `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_REMOTE` | 无内置 `CLAUDE_PLUGIN_ROOT` | 迁移时可将 `CLAUDE_PLUGIN_ROOT` 解析为 repo-local 路径证据，但迁移后的 handler 不应继续依赖该环境变量 |
| **Stdin 契约** | command 类型不强制消费 stdin | 脚本必须消费 stdin，否则 runtime 挂起 | wrapper 必须读取 stdin |
| **平台支持** | 宿主依赖（Unix bash / Windows cmd） | 原生跨平台（`.sh` + `.ps1`） | 每 hook 需生成两套 wrapper |
| **异步执行** | 支持 `{"async": true}` | 未明确支持 | 无法直接保留异步语义 |
| **Agent-Scoped** | 支持（frontmatter） | 未明确支持 | 无法直接迁移 agent 级 hooks |
| **决策控制** | `allow`/`deny`/`ask`/`defer` + `updatedInput` | 平台层可表达 `cancel: true` + `contextModification`，但本 skill 默认不要求 handler 直接输出该 JSON | 决策语义不兼容，只能做最小化桥接 |

### Event 映射关系（精确匹配）

| Claude Code Event | Cline Event | 可迁移性 |
|-------------------|-------------|---------|
| `UserPromptSubmit` | `UserPromptSubmit` | ⚠️ 仅 command 本地脚本可包装 |
| `PreToolUse` | `PreToolUse` | ⚠️ 仅 command 本地脚本可包装 |
| `PostToolUse` | `PostToolUse` | ⚠️ 仅 command 本地脚本可包装 |
| `PreCompact` | `PreCompact` | ⚠️ 仅 command 本地脚本可包装 |

### Event 语义相似映射（含差异分析）

以下事件在 Cline 中没有同名等价物，但从**语义和用途**角度可找到类似替代方案。迁移时需人工评估语义差异是否可接受。

| Claude Code Event | Cline 类似事件 | 相似度 | 语义对比 | 迁移建议 |
|-------------------|---------------|--------|---------|---------|
| `SessionStart` | `TaskStart` | ⭐⭐⭐ | 都是"开始"时触发，常用于环境初始化。差异：`SessionStart` 每会话一次（打开 Claude Code），`TaskStart` 每任务一次（用户发送请求）。Cline 的任务粒度更细，可能导致初始化逻辑被重复执行。 | 若原脚本是幂等初始化（如检查依赖、设置环境变量），可包装为 `TaskStart`；若依赖"仅执行一次"语义，则不适合迁移。 |
| `Setup` | `TaskStart` | ⭐⭐⭐ | `Setup` 专用于 `/setup` 命令的配置初始化，`TaskStart` 更通用。两者都用于准备环境。 | 可直接迁移到 `TaskStart`，但会改变触发范围（每次任务 vs 仅 `/setup` 时）。需人工确认。 |
| `SessionEnd` | `TaskComplete` + `TaskCancel` | ⭐⭐⭐ | 都是"结束"时触发，用于清理和保存状态。差异：Claude Code 是单一会话结束点，Cline 需分别在成功/取消两个事件中处理。 | 需将原脚本拆分为两个 wrapper：一个放在 `TaskComplete`，一个放在 `TaskCancel`。若脚本逻辑同时依赖两者，Cline 无单一对应事件。 |
| `Stop` | `TaskComplete` | ⭐⭐⭐ | 都标志一轮/任务结束，常用于结果校验或强制继续。差异：`Stop` 是每轮对话结束（Claude 完成响应），`TaskComplete` 是整个任务成功完成。`Stop` 更频繁。 | 若原 `Stop` hook 用于最终质量检查，可迁移到 `TaskComplete`；若用于每轮对话后的干预（如强制继续），Cline 无对应机制。 |
| `StopFailure` | `TaskCancel` | ⭐⭐ | 都是异常终止。差异：`StopFailure` 是 API 错误导致回合结束，`TaskCancel` 是用户主动取消。语义不同。 | 不建议直接迁移。若原脚本是错误日志记录，可尝试放在 `TaskCancel`，但会丢失 API 错误的上下文。 |
| `PostToolUseFailure` | `PostToolUse` | ⭐⭐⭐⭐ | Cline 的 `PostToolUse` 包含 `success: boolean` 字段，天然覆盖失败场景。Claude Code 将成功和失败拆分为两个事件。 | **推荐合并迁移**：将 `PostToolUseFailure` 的逻辑并入 `PostToolUse` wrapper，在脚本内部根据 `success` 字段分支处理。 |
| `PermissionRequest` | `PreToolUse` | ⭐⭐⭐ | 都是执行前拦截。差异：`PermissionRequest` 针对权限对话框（用户交互层面的审批），`PreToolUse` 针对所有工具调用。 | 若原 hook 是自动审批/拒绝某些操作，可迁移到 `PreToolUse` 并在脚本内过滤；若依赖权限对话框的特定上下文，则无法等效替换。 |
| `TaskCreated` | `TaskStart` | ⭐⭐⭐ | 都是任务生命周期起点。差异：`TaskCreated` 是在任务被创建时（通过 `TaskCreate` 工具），`TaskStart` 是任务开始执行。 | 可尝试迁移，但触发时机不同。若原脚本是任务追踪/通知，可能可接受。 |
| `TaskCompleted` | `TaskComplete` | ⭐⭐⭐⭐ | 都标志任务完成。差异：`TaskCompleted` 是被标记为完成时（可拦截完成动作），`TaskComplete` 是成功完成后触发。语义非常接近。 | 可直接包装为 `TaskComplete`。注意 Cline 的 `TaskComplete` 不可取消（`canCancel: false`），而 Claude Code 的 `TaskCompleted` 可以拦截。 |
| `SubagentStart` | `TaskStart` | ⭐⭐ | 都是子任务开始。差异：Claude Code 明确区分主 agent 和 subagent，Cline 的 `TaskStart` 不区分子任务层级（除非内部实现有区分）。 | 若原脚本是资源分配/日志记录，可尝试迁移；若严格依赖 subagent 的元数据（agent_type 等），则无法等效替换。 |
| `SubagentStop` | `TaskComplete` + `TaskCancel` | ⭐⭐ | 都是子任务结束。差异同上。 | 同 `SessionEnd`，需拆分为两个事件，且子 agent 上下文可能丢失。 |

### 无语义替代的事件

以下 Claude Code 事件在 Cline 中**完全找不到类似机制**，不应尝试生成 wrapper：

| Claude Code Event | 缺失原因 |
|-------------------|---------|
| `InstructionsLoaded` | Cline 使用 `.clinerules`，但无"规则加载完成"的事件 hook |
| `UserPromptExpansion` | Cline 无用户提示词扩展阶段的概念 |
| `Notification` | Cline 无通知系统的事件 hook |
| `TeammateIdle` | Cline 无多 agent team 概念 |
| `PostCompact` | Cline 仅有 `PreCompact`，无压缩后事件 |
| `ConfigChange` | Cline 无配置热更新的事件 hook |
| `WorktreeCreate` / `WorktreeRemove` | Cline 无 Git worktree 相关事件 |
| `FileChanged` | Cline 无文件监控变更事件 |
| `CwdChanged` | Cline 无工作目录变更事件（Claude Code 此事件支持 `CLAUDE_ENV_FILE` 动态环境注入，Cline 无此能力） |
| `Elicitation` / `ElicitationResult` | Cline 未明确支持 MCP server 输入请求的 hook 机制 |

---

## 四、对当前 Skill 优化的启示

### 4.1 当前 Skill 的设计合理性

当前 `agents-hub-setup-guide-migration` skill 的设计与调研结论高度一致：

1. **范围限定正确**：仅处理 JSON 配置中的 hooks，不碰 skills/rules/agents/workflows。
2. **决策树合理**：仅对 `command` 类型的本地脚本生成 wrapper，其余标记 `not-migrated`。
3. **Wrapper 设计必要**：stdin 消费、`CLAUDE_PLUGIN_ROOT` 的源码期路径解析、跨平台 wrapper 都是真实存在的技术鸿沟。

### 4.2 可优化方向

基于调研，建议后续在以下方面增强 skill：

#### （1）Event 映射分层策略

当前 skill 以 event key 直接作为 wrapper 文件名。需将映射分为三层：

- **直接等价层**（4 个）：`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact` —— 可直接生成同名 wrapper。
- **语义相似层**（多个）：`SessionStart`→`TaskStart`, `Stop`→`TaskComplete`, `SessionEnd`→`TaskComplete`+`TaskCancel`, `PostToolUseFailure`→`PostToolUse`（内部分支）—— 可生成 wrapper，但必须在 risk marker 中明确语义差异，并标记 `auto: false`（强制人工审核）。
- **无替代层**：`InstructionsLoaded`, `Notification`, `ConfigChange`, `FileChanged`, `CwdChanged`, `Elicitation` 等 —— 直接标记 `not-migrated`。

**建议**：在 skill 决策树中增加 event 映射分层判断，而非简单的"是否在 8 个事件内"。对于语义相似层，生成 wrapper 时 target event 使用 Cline 的事件名（如 `TaskStart`），并在 YAML frontmatter 的 `risk` 字段中说明原始事件与目标事件的语义差异。

#### （2）语义相似事件的迁移提示

对于 `SessionStart`→`TaskStart`、`Stop`→`TaskComplete` 等语义相似但非精确匹配的事件，当前 skill 直接标记 `not-migrated` 会遗漏可行的迁移路径。

**建议**：在 runbook 的 `not-migrated` prose 中，为语义相似事件增加"替代建议"段落：
- `SessionStart`："Cline 的 `TaskStart` 可在一定程度上替代，但触发频率更高（每次任务 vs 每次会话）。若原脚本是幂等初始化，可手动复制到 `.clinerules/hooks/TaskStart`；否则不建议迁移。"
- `PostToolUseFailure`："Cline 的 `PostToolUse` 包含 `success: false` 场景。建议将原脚本逻辑合并到 `PostToolUse` wrapper 中，通过检查 `success` 字段分支处理。"
- `SessionEnd` / `SubagentStop`："Cline 无单一会话结束事件。若原脚本是清理逻辑，需拆分为 `TaskComplete` 和 `TaskCancel` 两个 wrapper；若脚本依赖单一结束点，则无法等效迁移。"

#### （3）Matcher 逻辑损失的透明化

Claude Code 的 matcher（如 `"matcher": "Bash"`）在迁移中完全丢失，因为 Cline 无 matcher 机制。wrapper 脚本将对所有 tool call 触发。

**建议**：在 risk marker 中明确说明 "Original matcher `[matcher]` is not supported in Cline; this wrapper will run for all `[EventName]` events."

#### （4）Agent-Scoped Hooks 的边界

若 JSON 配置来自 agent frontmatter 而非全局 settings.json，当前 skill 可能无法区分。Agent-scoped hooks 仅在特定 agent 生命周期内生效，迁移为全局 Cline hook 会改变行为范围。

**建议**：增加证据检查——若 `evidence.json` 或 `repo-summary.json` 显示 hook 配置位于 agent frontmatter 中，标记更高风险或 not-migrated。

#### （5）异步 Hooks 的识别

Claude Code 支持 `{"async": true}`，Cline 未明确支持。若原始脚本或配置依赖异步语义，wrapper 可能引入阻塞。

**建议**：若 Claude Code 配置中存在 `async: true` 字段，在 risk marker 中提示 "Original hook was async; Cline wrapper runs synchronously."

#### （6）Exit Code 语义差异

Claude Code 的 `Stop` 事件 exit 2 表示 "继续"，而 `PreToolUse` 的 exit 2 表示 "阻断"。Cline 的 `cancel: true` 统一表示取消/阻断。

结合语义映射表，以下场景的 exit code 需要特别注意：

- **`Stop` → `TaskComplete`**：原脚本 exit 2 在 Claude Code 中意味着"强制继续对话"，但 Cline 的 `TaskComplete` 不可取消，exit 2 会被视为错误。若原 `Stop` hook 使用 exit 2 实现强制继续，迁移到 `TaskComplete` 会完全丢失此语义。
- **`SessionEnd` → `TaskComplete`/`TaskCancel`**：原脚本可能使用 exit 2 向 model 发送终止原因，Cline 中 exit 2 的行为取决于目标事件。

**建议**：在 wrapper 模板中，若检测到原始事件是 `Stop` 且目标事件是 `TaskComplete`，应在 risk marker 中提示 "Original `Stop` hook used exit 2 to force continuation; Cline `TaskComplete` does not support this semantics. Manual review required."

#### （7）合并/拆分迁移的技术实现

对于语义相似层中涉及"合并"或"拆分"的场景，skill 的输出模板需要调整：

**合并场景：`PostToolUse` + `PostToolUseFailure` → `PostToolUse`**

若一个 Claude Code 配置同时声明了 `PostToolUse` 和 `PostToolUseFailure`，当前 skill 会为两者分别生成 wrapper，导致 Cline 目录下出现两个同名脚本冲突。实际上应合并为一个 `PostToolUse` wrapper，内部根据 `success` 字段路由到原 `PostToolUse` 或 `PostToolUseFailure` 脚本。

**建议**：增加合并检测逻辑——若同一配置中 `PostToolUse` 和 `PostToolUseFailure` 同时存在，生成一个联合 wrapper：

```bash
# 伪代码示意
read -r CLINE_EVENT
success=$(echo "$CLINE_EVENT" | jq -r '.success')
if [ "$success" = "true" ]; then
    exec "$SCRIPT_DIR/original-post-tool-use"
else
    exec "$SCRIPT_DIR/original-post-tool-use-failure"
fi
```

**拆分场景：`SessionEnd` → `TaskComplete` + `TaskCancel`**

若原 `SessionEnd` 脚本是清理逻辑，需要生成两个 wrapper。但两个 wrapper 引用的是同一个原始脚本，用户可能希望只维护一份代码。

**建议**：对于拆分场景，生成一个共享的原始脚本副本，两个 wrapper 都调用它，但在 wrapper 中通过环境变量区分触发来源（如 `CLINE_EVENT_NAME=TaskComplete`），让原始脚本自行判断是否需要执行。

#### （8）Prompt/Agent Handler 的降级建议

当前对 `prompt` 和 `agent` 类型直接标记 not-migrated。调研发现 Claude Code 的 `prompt` handler 本质上是单轮 LLM 评估，`agent` handler 是多轮 subagent 验证。

**建议**：在 not-migrated 的 prose 中，可以给用户提供手动替代方案："Consider converting this prompt/agent hook to a local script that calls the Claude API or implements the same verification logic."

---

## 五、参考来源

1. [Claude Code Docs — Hooks Reference](https://code.claude.com/docs/en/hooks)
2. [Claude Code Docs — Agent SDK Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
3. [Claude Code Docs — Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
4. [Cline Docs — Hooks](https://docs.cline.bot/customization/hooks)
5. [Cline GitHub PR #6440 — Add Hooks based on Claude Code Specifications](https://github.com/cline/cline/pull/6440)
6. [DeepWiki — Cline Hooks System](https://deepwiki.com/cline/cline/7.3-hooks-system)
7. [ClaudeLog — Agent-Scoped Hooks FAQ](https://claudelog.com/faqs/what-are-agent-scoped-hooks-in-claude-code/)
8. [CAIO — How to Use Hooks in Claude Code (2026)](https://www.thecaio.ai/blog/claude-code-hooks)
9. [Code With Seb — Claude Code Hooks & Custom Agents](https://codewithseb.com/blog/claude-code-hooks-custom-agents-ai-pipelines-guide)
10. [Claude Wiki — Notification and Hooks Pipeline](https://claude-wiki.com/notification-and-hooks-pipeline.html)

---

*本文档为 `agents-hub-setup-guide-migration` skill 的内部参考资料，用于指导后续 skill 逻辑优化与边界扩展。*
