#!/usr/bin/env node
/* global process */
// @ts-check

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { scanHooks } from './scan-hooks.mjs';
import { verifyHooks } from './verify-hooks.mjs';
import {
  cleanupMigrationSource,
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

export async function buildAgentContext({
  projectRoot,
  sourceRoot,
  source,
  sourceType,
  scanResult,
}) {
  const { hooks, sourceFiles } = await collectHookSources(sourceRoot, scanResult);

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
    directWriteGuidance: {
      targetDirectory: '.clinerules/hooks',
      agentOwnedOutputs: [
        '<EventName>-<plugin-slug>.mjs',
      ],
      scriptOwnedOutputs: [
        '<EventName>',
        '<EventName>.ps1',
      ],
      writeRule:
        'Only write migrated handler .mjs files. Do not write Unix/Windows entry scripts; the script layer generates those after handler translation.',
      failureRule:
        'If any hook cannot be safely migrated, fail explicitly instead of writing placeholder files.',
      prepareCommandExample: 'node scripts/run-migration.mjs prepare --repo obra/superpowers',
      finalizeCommandExample:
        'node scripts/run-migration.mjs finalize --project-root . --cleanup-path .tmp/superpowers',
    },
  };
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
