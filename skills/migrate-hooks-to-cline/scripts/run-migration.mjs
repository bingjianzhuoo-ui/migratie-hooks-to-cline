#!/usr/bin/env node
/* global process */
// @ts-check

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanHooks } from './scan-hooks.mjs';
import { verifyHooks } from './verify-hooks.mjs';
import {
  cleanupMigrationSource,
  CLAUDE_TO_CLINE_DIRECTORY_MAP,
  detectClaudeDirectoryReferences,
  generateEntryScriptsForHandlers,
  isDirectRun,
  logError,
  prepareMigrationSource,
  readStdin,
  resolveHooksOutputDir,
  resolveRepoRoot,
} from './utils.mjs';

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function collectSupportingScriptPaths(repoRoot, primaryScriptPath, commandArgs) {
  if (typeof primaryScriptPath !== 'string' || !primaryScriptPath || !Array.isArray(commandArgs)) {
    return [];
  }

  const primaryDir = path.dirname(path.join(repoRoot, primaryScriptPath));
  /** @type {string[]} */
  const supportingPaths = [];
  const seen = new Set();

  for (const arg of commandArgs) {
    if (typeof arg !== 'string' || !arg || arg.startsWith('-')) {
      continue;
    }

    if (arg.includes('/') || arg.includes('\\')) {
      continue;
    }

    const candidates = [
      path.join(primaryDir, arg),
      path.join(repoRoot, arg),
    ];

    for (const candidate of candidates) {
      if (!(await isFile(candidate))) {
        continue;
      }

      const relativePath = path.relative(repoRoot, candidate).replaceAll(path.sep, '/');
      if (relativePath.startsWith('../') || seen.has(relativePath)) {
        continue;
      }

      seen.add(relativePath);
      supportingPaths.push(relativePath);
      break;
    }
  }

  return supportingPaths;
}

async function loadSourceFile(repoRoot, filePath, role, hookId) {
  const absolutePath = path.join(repoRoot, filePath);
  const content = await readFile(absolutePath, 'utf8');
  return {
    hookId,
    role,
    path: filePath,
    content,
  };
}

export async function collectHookSources(repoRoot, scanResult) {
  /** @type {Array<Record<string, unknown>>} */
  const hooks = [];
  /** @type {Array<Record<string, unknown>>} */
  const sourceFiles = [];
  const seenSourcePaths = new Set();

  for (const hook of scanResult.hooks ?? []) {
    const supportingScriptPaths = await collectSupportingScriptPaths(
      repoRoot,
      typeof hook.resolvedScriptPath === 'string' ? hook.resolvedScriptPath : '',
      Array.isArray(hook.commandArgs) ? hook.commandArgs : [],
    );

    hooks.push({
      ...hook,
      supportingScriptPaths,
    });

    if (typeof hook.resolvedScriptPath === 'string' && hook.resolvedScriptPath) {
      if (!seenSourcePaths.has(hook.resolvedScriptPath)) {
        seenSourcePaths.add(hook.resolvedScriptPath);
        sourceFiles.push(
          await loadSourceFile(
            repoRoot,
            hook.resolvedScriptPath,
            'primary-script',
            String(hook.hookId ?? ''),
          ),
        );
      }
    }

    for (const supportingPath of supportingScriptPaths) {
      if (seenSourcePaths.has(supportingPath)) {
        continue;
      }
      seenSourcePaths.add(supportingPath);
      sourceFiles.push(
        await loadSourceFile(
          repoRoot,
          supportingPath,
          'supporting-script',
          String(hook.hookId ?? ''),
        ),
      );
    }
  }

  return { hooks, sourceFiles };
}

function collectDirectoryReferencesFromSources(sourceFiles) {
  const allReferences = [];
  const seen = new Set();

  for (const sourceFile of sourceFiles ?? []) {
    const content = typeof sourceFile.content === 'string' ? sourceFile.content : '';
    const references = detectClaudeDirectoryReferences(content);

    for (const reference of references) {
      const key = `${sourceFile.path}:${reference.claudePattern}:${reference.index}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      allReferences.push({
        sourceFile: sourceFile.path,
        ...reference,
      });
    }
  }

  return allReferences;
}

export async function buildAgentContext({
  projectRoot,
  sourceRoot,
  source,
  sourceType,
  scanResult,
}) {
  const { hooks, sourceFiles } = await collectHookSources(sourceRoot, scanResult);
  const directoryReferences = collectDirectoryReferencesFromSources(sourceFiles);
  const prepareCommandExample = buildRunMigrationCommand(projectRoot, [
    'prepare',
    '--repo',
    'obra/superpowers',
  ]);
  const finalizeCommandExample = buildRunMigrationCommand(projectRoot, [
    'finalize',
    '--project-root',
    '.',
    '--cleanup-path',
    '.tmp/superpowers',
  ]);

  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    targetRoot: projectRoot,
    targetHooksDirectory: resolveHooksOutputDir(projectRoot),
    sourceRoot,
    source,
    sourceType,
    hooks,
    sourceFiles,
    directoryMapping: CLAUDE_TO_CLINE_DIRECTORY_MAP,
    detectedDirectoryReferences: directoryReferences,
    directWriteGuidance: {
      targetDirectory: '.clinerules/hooks',
      agentOwnedOutputs: [
        '<EventName>-<plugin-slug>.mjs',
      ],
      scriptOwnedOutputs: [
        '<EventName>',
        '<EventName>.ps1',
      ],
      resourceLocationMap: [
        'Canonical tree lives in SKILL.md Resource Location Map.',
        '.clinerules/hooks/ is the only writable target for this skill; .cline/skills/, .clinerules/agents/, and .clinerules/workflows/ are out of scope.',
      ],
      resourceBoundaryRules: [
        'Non-hook resources may be read as source evidence only when a hook depends on them.',
        'Never translate a hook into .cline/skills/, .clinerules/agents/, .clinerules/workflows/, or another non-hook target.',
        'Never reinterpret hook translation as skill, workflow, agent, or rules migration.',
      ],
      writeRule:
        'Only write migrated handler .mjs files. Do not write Unix/Windows entry scripts; the script layer generates those after handler translation.',
      failureRule:
        'If any hook cannot be safely migrated, fail explicitly instead of writing placeholder files.',
      translationContract: [
        'Treat migrated handler stdout as arbitrary user-visible text.',
        'Any handler stdout is treated as literal text and passed through even if it looks like JSON.',
        'If the source hook injects text through message, additionalContext, additional_context, hookSpecificOutput.additionalContext, or plain stdout, rewrite the handler so stdout contains that final injected text.',
        'Write debug logs to stderr only. Handler stdout must contain only the final user-visible text.',
        'Use non-zero exit codes plus stderr for failures instead of cancel/errorMessage JSON from handlers.',
      ],
      sourceTraversalRules: [
        'Read the hook config entry, primary script, and every repo-local supporting file already surfaced in sourceFiles before deciding on migration.',
        'If the primary script reads additional repo-local files to build output, inspect those files too.',
        'If the source logic checks multiple candidate directories, preserve the same precedence order or fail explicitly.',
        'Do not collapse multi-directory lookup behavior into a single hard-coded directory without direct source evidence.',
      ],
      directoryTranslationRules: [
        'When a source script references files in Claude Code plugin directories, the translated handler MUST map those paths to their Cline equivalents using the directoryMapping table.',
        'Claude Code plugin layout: PLUGIN_ROOT/skills/ → Cline .cline/skills/',
        'Claude Code plugin layout: PLUGIN_ROOT/agents/ → Cline .clinerules/agents/',
        'Claude Code plugin layout: PLUGIN_ROOT/hooks/ → Cline .clinerules/hooks/',
        'Claude Code plugin layout: PLUGIN_ROOT/commands/ → Cline .clinerules/workflows/',
        'When a hook script uses $CLAUDE_PLUGIN_ROOT/skills/ or SCRIPT_DIR/../skills/, the translated handler must use workspaceRoot + .cline/skills/ instead.',
        'When a hook script uses $CLAUDE_PLUGIN_ROOT/agents/ or SCRIPT_DIR/../agents/, the translated handler must use workspaceRoot + .clinerules/agents/ instead.',
        'SCRIPT_DIR/../ in a hook script (hooks/scripts/) resolves to PLUGIN_ROOT. In Cline, the equivalent is the workspace root. Translate accordingly.',
        'If a source script reads multiple candidate directories in precedence order, preserve that order but map each candidate to its Cline equivalent.',
        'Do NOT hard-code Claude-specific paths (CLAUDE_PLUGIN_ROOT, SCRIPT_DIR, .claude-plugin/) in the translated handler. All path references must use the Cline directory layout.',
        'If a source script constructs paths using CLAUDE_PLUGIN_ROOT plus a plugin subdirectory, resolve CLAUDE_PLUGIN_ROOT at migration time AND translate the subdirectory to the Cline equivalent.',
        'If detectedDirectoryReferences is non-empty, every referenced Claude directory pattern in those source files must be accounted for in the translated handler.',
        'If a path cannot be safely translated (e.g. the Cline target directory does not exist or the mapping is ambiguous), fail explicitly rather than silently using the wrong path.',
      ],
      semanticPreservationRules: [
        'Build a per-hook migration worksheet from source evidence only before choosing wrapper versus rewrite.',
        'Capture trigger conditions, matcher behavior, consumed inputs, produced outputs, exit codes, and lookup precedence.',
        'Only translate behavior that is provable from source evidence.',
        'Preserve matcher gates, branch conditions, side-effect order, and lookup precedence.',
        'Preserve injected context text exactly when it comes from static or repo-local source content.',
        'If the source relies on CLAUDE_PLUGIN_ROOT, resolve it to concrete repo-local paths during analysis and do not require that environment variable at migrated-hook runtime. If equivalent repo-local path resolution cannot be preserved safely, fail explicitly.',
        'Do not widen trigger scope or invent fallback behavior that the source does not contain.',
        'If a wrapper is chosen, it must stay minimal and behavior-preserving.',
      ],
      preWriteQualityGate: [
        'Every emitted Cline output field must be traceable to specific source behavior.',
        'Every consumed Cline event field must be justified by the original hook input contract.',
        'Handler stdout must contain only the final user-visible text that should be injected.',
        'Logs and diagnostics must go to stderr only.',
        'File reads, path lookups, helper invocations, and environment-variable dependencies must be preserved or marked unresolved.',
        'Any rewrite must be limited to behavior proved by the source rather than a speculative reimplementation.',
      ],
      mandatoryFailureConditions: [
        'Fail instead of guessing when correctness depends on shell pipelines, dynamic eval, or command chaining that cannot be modeled safely.',
        'Fail instead of guessing when correctness depends on external binaries, network services, or non-repo-local filesystem state.',
        'Fail instead of guessing when exit-code mapping or decision branches cannot be explained.',
        'Fail instead of guessing when required injected text, matcher gates, or blocking behavior cannot be traced to source evidence.',
        'Fail instead of guessing when the translation would need invented prompt text, default values, or fallback behavior.',
      ],
      prepareCommandExample,
      finalizeCommandExample,
    },
  };
}

export function buildRunMigrationCommand(projectRoot, args = []) {
  const relativeScriptPath = path
    .relative(resolveRepoRoot(projectRoot), fileURLToPath(import.meta.url))
    .replaceAll(path.sep, '/');

  return ['node', relativeScriptPath, ...args].join(' ');
}

export function resolveExecutionContext({
  repoRoot = process.cwd(),
} = {}) {
  const projectRoot = resolveRepoRoot(repoRoot);

  return {
    projectRoot,
    targetRoot: projectRoot,
    targetHooksDirectory: resolveHooksOutputDir(projectRoot),
  };
}

export async function prepareSourceWorkspace({
  projectRoot = process.cwd(),
  repo,
} = {}) {
  return prepareMigrationSource({
    projectRoot,
    repo,
  });
}

export async function scanHookFacts({
  sourceRoot,
}) {
  return scanHooks({ repoRoot: sourceRoot });
}

export function parseRunMigrationArgs(argv = process.argv.slice(2)) {
  /** @type {{ subcommand: 'prepare' | 'finalize'; repoRoot?: string; repo?: string; cleanupPath?: string }} */
  const parsed = {};
  let subcommandSet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!subcommandSet && (arg === 'prepare' || arg === 'finalize')) {
      parsed.subcommand = arg;
      subcommandSet = true;
      continue;
    }

    if (arg === '--repo') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Expected a repository source after --repo');
      }
      parsed.repo = value;
      index += 1;
      continue;
    }

    if (arg === '--project-root' || arg === '--cwd') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Expected a path after ${arg}`);
      }
      parsed.repoRoot = value;
      index += 1;
      continue;
    }

    if (arg === '--cleanup-path') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Expected a path after --cleanup-path');
      }
      parsed.cleanupPath = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (parsed.repoRoot == null) {
      parsed.repoRoot = arg;
      continue;
    }

    throw new Error(`Unexpected positional argument: ${arg}`);
  }

  return {
    subcommand: parsed.subcommand ?? 'prepare',
    repoRoot: parsed.repoRoot,
    repo: parsed.repo,
    cleanupPath: parsed.cleanupPath,
  };
}

async function parseFinalizeInput() {
  const raw = await readStdin();
  if (!raw.trim()) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `finalize stdin must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('finalize stdin must be a JSON object.');
  }

  return parsed;
}

export async function runMigration({
  repoRoot = process.cwd(),
  repo,
} = {}) {
  const executionContext = resolveExecutionContext({ repoRoot });
  const preparedSource = await prepareSourceWorkspace({
    projectRoot: executionContext.projectRoot,
    repo,
  });
  const scanResult = await scanHookFacts({ sourceRoot: preparedSource.sourceRoot });

  if (scanResult.hookCount === 0) {
    if (typeof repo === 'string' && repo.trim().length > 0) {
      throw new Error(
        `No Claude hook content found in repo source: ${repo}`,
      );
    }

    throw new Error(
      'No Claude hook content found in the current project. Re-run with `--repo <source>` or specify the repo in the prompt.',
    );
  }

  const agentContext = await buildAgentContext({
    projectRoot: executionContext.projectRoot,
    sourceRoot: preparedSource.sourceRoot,
    source: preparedSource.source,
    sourceType: preparedSource.sourceType,
    scanResult,
  });

  return {
    status: 'awaiting-agent-migration',
    projectRoot: executionContext.projectRoot,
    targetRoot: executionContext.targetRoot,
    targetHooksDirectory: executionContext.targetHooksDirectory,
    sourceRoot: preparedSource.sourceRoot,
    cleanupPath: preparedSource.cleanupPath,
    scanResult,
    agentContext: {
      ...agentContext,
    },
  };
}

export async function finalizeMigration({
  projectRoot = process.cwd(),
  cleanupPath = null,
  expectedFiles = [],
  unresolvedHooks = [],
} = {}) {
  const resolvedProjectRoot = resolveRepoRoot(projectRoot);
  const entryScriptResult = await generateEntryScriptsForHandlers(resolvedProjectRoot);
  const verificationResult = await verifyHooks({
    repoRoot: resolvedProjectRoot,
    expectedFiles,
    unresolvedHooks,
  });
  await cleanupMigrationSource(cleanupPath, resolvedProjectRoot);

  return {
    status: 'verified-and-cleaned',
    projectRoot: resolvedProjectRoot,
    targetHooksDirectory: resolveHooksOutputDir(resolvedProjectRoot),
    generatedEntryFiles: entryScriptResult.generatedFiles,
    verificationResult,
  };
}

async function main() {
  const {
    subcommand,
    repoRoot,
    repo,
    cleanupPath,
  } = parseRunMigrationArgs();
  const resolvedRepoRoot = repoRoot ?? process.cwd();
  let result;

  if (subcommand === 'finalize') {
    const input = await parseFinalizeInput();
    result = await finalizeMigration({
      projectRoot: resolvedRepoRoot,
      cleanupPath:
        cleanupPath
        ?? (typeof input.cleanupPath === 'string' ? input.cleanupPath : null),
      expectedFiles: Array.isArray(input.expectedFiles) ? input.expectedFiles : [],
      unresolvedHooks: Array.isArray(input.unresolvedHooks) ? input.unresolvedHooks : [],
    });
  } else {
    result = await runMigration({ repoRoot: resolvedRepoRoot, repo });
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    logError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
