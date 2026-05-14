#!/usr/bin/env node
/* global process */
// @ts-check

import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const execFileAsync = promisify(execFile);
const DIRECT_EVENT_MAP = Object.freeze({
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  UserPromptSubmit: 'UserPromptSubmit',
  PreCompact: 'PreCompact',
});
const SEMANTIC_EVENT_MAP = Object.freeze({
  SessionStart: {
    candidateEvent: 'TaskStart',
    mappingReason:
      'Semantic mapping only: SessionStart fires per session, TaskStart fires per task.',
  },
  Stop: {
    candidateEvent: 'TaskComplete',
    mappingReason:
      'Semantic mapping only: Stop fires per round, TaskComplete fires on successful task completion.',
  },
  PostToolUseFailure: {
    candidateEvent: 'PostToolUse',
    mappingReason:
      'Semantic mapping only: failure-only behavior must be preserved by checking success:false.',
  },
  SessionEnd: {
    candidateEvent: 'TaskComplete',
    mappingReason:
      'Semantic mapping only: SessionEnd has no single Cline equivalent and may also need TaskCancel review.',
  },
  TaskCreated: {
    candidateEvent: 'TaskStart',
    mappingReason:
      'Semantic mapping only: TaskCreated fires on creation, TaskStart fires on execution start.',
  },
  TaskCompleted: {
    candidateEvent: 'TaskComplete',
    mappingReason:
      'Semantic mapping only: TaskCompleted is close to TaskComplete but cancellation semantics differ.',
  },
  Setup: {
    candidateEvent: 'TaskStart',
    mappingReason:
      'Semantic mapping only: Setup is narrower than TaskStart and needs agent review.',
  },
});
const UNSUPPORTED_EVENTS = new Set([
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'ConfigChange',
  'FileChanged',
  'CwdChanged',
  'InstructionsLoaded',
  'UserPromptExpansion',
  'PostCompact',
  'TeammateIdle',
  'Elicitation',
  'ElicitationResult',
  'StopFailure',
  'PermissionRequest',
  'WorktreeCreate',
  'WorktreeRemove',
]);
const KNOWN_CLINE_EVENTS = Object.freeze(
  Array.from(
    new Set([
      ...Object.values(DIRECT_EVENT_MAP),
      ...Object.values(SEMANTIC_EVENT_MAP).map((mapping) => mapping.candidateEvent),
      'TaskCancel',
    ]),
  ).sort((left, right) => right.length - left.length),
);

export function resolveSkillRoot() {
  return SKILL_ROOT;
}

export function resolveScriptsDir() {
  return SCRIPT_DIR;
}

export function resolveRepoRoot(repoRoot = process.cwd()) {
  return path.resolve(repoRoot);
}

export function resolveTmpRoot(projectRoot = process.cwd()) {
  return path.join(resolveRepoRoot(projectRoot), '.tmp');
}

export function resolveHooksOutputDir(repoRoot = process.cwd()) {
  return path.join(resolveRepoRoot(repoRoot), '.clinerules', 'hooks');
}

export function detectRepoSourceType(source) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return 'local';
  }

  const trimmed = source.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return 'github';
  }

  if (
    trimmed.startsWith('github:')
    || trimmed.startsWith('http://')
    || trimmed.startsWith('https://')
    || trimmed.startsWith('git@')
    || trimmed.startsWith('file://')
  ) {
    return 'remote';
  }

  return 'local';
}

function normalizeRepoName(repo) {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
}

function parseGithubSource(source) {
  const githubPrefixMatch = source.match(/^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (githubPrefixMatch) {
    return { owner: githubPrefixMatch[1], repo: normalizeRepoName(githubPrefixMatch[2]) };
  }

  const shorthandMatch = source.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthandMatch) {
    return { owner: shorthandMatch[1], repo: normalizeRepoName(shorthandMatch[2]) };
  }

  return null;
}

export function buildRepoCloneUrl(source) {
  const github = parseGithubSource(source);
  if (github) {
    return `https://github.com/${github.owner}/${github.repo}.git`;
  }

  return source;
}

export function buildRepoSlug(source) {
  const github = parseGithubSource(source);
  if (github) {
    return github.repo;
  }

  try {
    const parsed = new URL(source);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).at(-1);
    if (lastSegment) {
      return normalizeRepoName(lastSegment);
    }
  } catch {
    // Not a URL.
  }

  const normalized = source.replace(/\\/g, '/').replace(/\/+$/, '');
  const candidate = normalized.split('/').filter(Boolean).at(-1);
  return normalizeRepoName(candidate || 'repo');
}

export function buildRepoCloneDir(projectRoot, source) {
  return path.join(resolveTmpRoot(projectRoot), buildRepoSlug(source));
}

export async function prepareMigrationSource({
  projectRoot = process.cwd(),
  repo,
} = {}) {
  const resolvedProjectRoot = resolveRepoRoot(projectRoot);

  if (typeof repo !== 'string' || repo.trim().length === 0) {
    return {
      projectRoot: resolvedProjectRoot,
      sourceRoot: resolvedProjectRoot,
      cleanupPath: null,
      sourceType: 'local',
      source: null,
    };
  }

  const trimmedRepo = repo.trim();
  if (detectRepoSourceType(trimmedRepo) === 'local') {
    return {
      projectRoot: resolvedProjectRoot,
      sourceRoot: path.resolve(resolvedProjectRoot, trimmedRepo),
      cleanupPath: null,
      sourceType: 'local',
      source: trimmedRepo,
    };
  }

  const cloneUrl = buildRepoCloneUrl(trimmedRepo);
  const cloneDir = buildRepoCloneDir(resolvedProjectRoot, trimmedRepo);
  await mkdir(resolveTmpRoot(resolvedProjectRoot), { recursive: true });
  await rm(cloneDir, { recursive: true, force: true });

  try {
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', cloneUrl, cloneDir],
      {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
  } catch (error) {
    await rm(cloneDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clone ${cloneUrl}: ${message}`);
  }

  return {
    projectRoot: resolvedProjectRoot,
    sourceRoot: cloneDir,
    cleanupPath: cloneDir,
    sourceType: detectRepoSourceType(trimmedRepo),
    source: trimmedRepo,
  };
}

export async function cleanupMigrationSource(cleanupPath, projectRoot = process.cwd()) {
  if (typeof cleanupPath !== 'string' || cleanupPath.trim().length === 0) {
    return;
  }

  const resolvedProjectRoot = resolveRepoRoot(projectRoot);
  const resolvedTmpRoot = resolveTmpRoot(resolvedProjectRoot);
  const resolvedCleanupPath = path.resolve(cleanupPath);

  if (
    resolvedCleanupPath !== resolvedTmpRoot
    && !resolvedCleanupPath.startsWith(`${resolvedTmpRoot}${path.sep}`)
  ) {
    throw new Error(`Refusing to cleanup path outside project .tmp: ${resolvedCleanupPath}`);
  }

  await rm(resolvedCleanupPath, { recursive: true, force: true });
}

export function mapClaudeEvent(eventName) {
  if (DIRECT_EVENT_MAP[eventName]) {
    return {
      candidateEvent: DIRECT_EVENT_MAP[eventName],
      mappingKind: 'direct',
      mappingReason: null,
    };
  }

  if (SEMANTIC_EVENT_MAP[eventName]) {
    return {
      candidateEvent: SEMANTIC_EVENT_MAP[eventName].candidateEvent,
      mappingKind: 'semantic',
      mappingReason: SEMANTIC_EVENT_MAP[eventName].mappingReason,
    };
  }

  if (UNSUPPORTED_EVENTS.has(eventName)) {
    return {
      candidateEvent: null,
      mappingKind: 'unsupported',
      mappingReason: `No safe Cline equivalent for Claude Code event "${eventName}".`,
    };
  }

  return {
    candidateEvent: null,
    mappingKind: 'unknown',
    mappingReason: `Unknown Claude Code event "${eventName}".`,
  };
}

export function isDirectRun(moduleUrl, argv = process.argv) {
  return Boolean(argv[1]) && moduleUrl === pathToFileURL(argv[1]).href;
}

export function logInfo(message) {
  writeSync(1, `[setup-guide-migration] ${message}\n`);
}

export function logError(message) {
  writeSync(2, `[setup-guide-migration] ${message}\n`);
}

export async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }

  return chunks.join('');
}

export async function readJsonFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export function notImplemented(step) {
  const error = new Error(`${step} is not implemented yet.`);
  error.name = 'NotImplementedError';
  error.code = 'NOT_IMPLEMENTED';
  return error;
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

export async function writeJsonFile(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Flat naming helpers
// ---------------------------------------------------------------------------

/**
 * Build a flat handler filename: `<EventName>-<plugin-slug>.mjs`.
 * If the same plugin has multiple original hooks under the same event,
 * the agent must merge them into a single file during migration.
 */
export function buildHandlerFileName(eventName, pluginSlug) {
  return `${eventName}-${pluginSlug}.mjs`;
}

export function buildUnixEntryFileName(eventName) {
  return eventName;
}

export function buildWindowsEntryFileName(eventName) {
  return `${eventName}.ps1`;
}

/**
 * Parse a handler filename back into eventName and pluginSlug.
 * Returns `null` if the filename does not match the flat handler pattern.
 */
export function parseHandlerFileName(fileName) {
  if (!fileName.endsWith('.mjs')) {
    return null;
  }

  for (const eventName of KNOWN_CLINE_EVENTS) {
    const prefix = `${eventName}-`;
    if (!fileName.startsWith(prefix)) {
      continue;
    }

    const pluginSlug = fileName.slice(prefix.length, -'.mjs'.length);
    if (pluginSlug) {
      return { eventName, pluginSlug };
    }
  }

  return null;
}

export async function listHandlerFiles(hooksDir) {
  const entries = await readdir(hooksDir, { withFileTypes: true });
  const handlerFiles = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const parsed = parseHandlerFileName(entry.name);
    if (parsed == null) {
      continue;
    }

    handlerFiles.push({
      ...parsed,
      fileName: entry.name,
    });
  }

  handlerFiles.sort((left, right) => left.fileName.localeCompare(right.fileName));
  return handlerFiles;
}

// ---------------------------------------------------------------------------
// Minimal handler I/O contract constants
// ---------------------------------------------------------------------------

export const HANDLER_CONTRACT = Object.freeze({
  successExitCode: 0,
  failureExitCode: 1,
  stdoutPurpose: 'Plain context text only',
  stderrPurpose: 'Error reason or diagnostics',
  aggregationRule: 'Sequential execution; first non-zero exit stops the chain.',
});

export const ENTRY_OUTPUT_CONTRACT = Object.freeze({
  successNoOutput: { cancel: false },
  successWithOutput: (joinedText) => ({
    cancel: false,
    contextModification: joinedText,
  }),
  failure: (reason) => ({ cancel: true, errorMessage: reason }),
});

// ---------------------------------------------------------------------------
// Entry-script generators
// ---------------------------------------------------------------------------

const WINDOWS_RESULT_EMITTER_LINES = Object.freeze([
  'function Write-ClineResult {',
  '  param(',
  '    [bool]$Cancel,',
  '    [string]$ErrorMessage = "",',
  '    [string]$ContextModification = ""',
  '  )',
  '  $payload = [ordered]@{ cancel = $Cancel }',
  '  if ($ErrorMessage -ne "") {',
  '    $payload.errorMessage = $ErrorMessage',
  '  }',
  '  if ($ContextModification -ne "") {',
  '    $payload.contextModification = $ContextModification',
  '  }',
  '  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))',
  '}',
]);

/**
 * Generate a Unix shell entry script for the given event.
 * The script reads Cline event JSON from stdin, discovers all
 * `<eventName>-*.mjs` handlers in the same directory, runs them
 * sequentially, and emits the final Cline JSON.
 */
export function generateUnixEntryScript(eventName) {
  return [
    '#!/bin/sh',
    '# Auto-generated Cline hook entry for ' + eventName,
    '# Aggregates ' + eventName + '-<plugin>.mjs handlers in this directory.',
    '',
    'if [ -t 0 ]; then',
    '  input=\'{}\'',
    'else',
    '  input=$(cat)',
    'fi',
    'dir=$(dirname "$0")',
    'handlers=$(ls -1 "$dir"/' + eventName + '-*.mjs 2>/dev/null | sort)',
    '',
    'for handler in $handlers; do',
    '  output=$(printf \'%s\' "$input" | node "$handler")',
    '  rc=$?',
    '  if [ $rc -ne 0 ]; then',
    '    node -e \'console.log(JSON.stringify({cancel:true,errorMessage:process.argv[1]}))\' "Handler failed: $handler"',
    '    exit 1',
    '  fi',
    '  if [ -z "$output" ]; then',
    '    continue',
    '  fi',
    '  context="${context:-}${output}"',
    'done',
    '',
    'if [ -z "${context:-}" ]; then',
    '  echo \'{"cancel":false}\'',
    'else',
    '  node -e \'console.log(JSON.stringify({cancel:false,contextModification:process.argv[1]}))\' "$context"',
    'fi',
    '',
  ].join('\n');
}

/**
 * Generate a Windows PowerShell entry script for the given event.
 * Mirrors the Unix entry behaviour.
 */
export function generateWindowsEntryScript(eventName) {
  return [
    '# Auto-generated Cline hook entry for ' + eventName,
    '# Aggregates ' + eventName + '-<plugin>.mjs handlers in this directory.',
    '',
    ...WINDOWS_RESULT_EMITTER_LINES,
    '',
    'if ([Console]::IsInputRedirected) {',
    '  $inputJson = [Console]::In.ReadToEnd()',
    '} else {',
    '  $inputJson = "{}"',
    '}',
    '$dir = $PSScriptRoot',
    '$handlers = Get-ChildItem -Path $dir -Filter "' + eventName + '-*.mjs" | Sort-Object Name',
    '$contextParts = @()',
    '',
    'foreach ($handler in $handlers) {',
    '  $output = $inputJson | & node $handler.FullName',
    '  if ($LASTEXITCODE -ne 0) {',
    '    $errorMessage = "Handler failed: $($handler.Name)"',
    '    Write-ClineResult -Cancel $true -ErrorMessage $errorMessage',
    '    exit 1',
    '  }',
    '  if (-not $output) {',
    '    continue',
    '  }',
    '  $rawOutput = ($output -join "`n").Trim()',
    '  if (-not $rawOutput) {',
    '    continue',
    '  }',
    '  $contextParts += $rawOutput',
    '}',
    '',
    '$context = $contextParts -join ""',
    'if ($context -eq "") {',
    '  Write-ClineResult -Cancel $false',
    '} else {',
    '  Write-ClineResult -Cancel $false -ContextModification $context',
    '}',
    '',
  ].join('\n');
}

export async function generateEntryScriptsForHandlers(repoRoot = process.cwd()) {
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const hooksDir = await ensureDir(resolveHooksOutputDir(resolvedRepoRoot));
  const handlerFiles = await listHandlerFiles(hooksDir);
  const generatedFiles = [];
  const seenEvents = new Set();

  for (const handlerFile of handlerFiles) {
    if (seenEvents.has(handlerFile.eventName)) {
      continue;
    }
    seenEvents.add(handlerFile.eventName);

    const unixEntryFileName = buildUnixEntryFileName(handlerFile.eventName);
    const windowsEntryFileName = buildWindowsEntryFileName(handlerFile.eventName);
    const unixEntryPath = path.join(hooksDir, unixEntryFileName);
    const windowsEntryPath = path.join(hooksDir, windowsEntryFileName);

    await writeFile(unixEntryPath, generateUnixEntryScript(handlerFile.eventName), 'utf8');
    await chmod(unixEntryPath, 0o755);
    await writeFile(windowsEntryPath, generateWindowsEntryScript(handlerFile.eventName), 'utf8');

    generatedFiles.push(
      path.relative(resolvedRepoRoot, unixEntryPath).replaceAll(path.sep, '/'),
      path.relative(resolvedRepoRoot, windowsEntryPath).replaceAll(path.sep, '/'),
    );
  }

  return {
    repoRoot: resolvedRepoRoot,
    hooksDir,
    handlerCount: handlerFiles.length,
    eventCount: seenEvents.size,
    generatedFiles,
  };
}
