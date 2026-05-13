#!/usr/bin/env node
/* global process */
// @ts-check

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  isDirectRun,
  logError,
  mapClaudeEvent,
  resolveRepoRoot,
} from './utils.mjs';

const CONFIG_SUFFIXES = new Map([
  ['hooks/hooks.json', 'hooks-index'],
  ['.claude/settings.json', 'claude-settings'],
  ['.claude/settings.local.json', 'claude-settings-local'],
]);
const SKIP_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);
const INTERPRETER_HINTS = new Map([
  ['node', 'node'],
  ['nodejs', 'node'],
  ['python', 'python'],
  ['python3', 'python'],
  ['bash', 'shell'],
  ['sh', 'shell'],
  ['pwsh', 'powershell'],
  ['powershell', 'powershell'],
  ['powershell.exe', 'powershell'],
  ['cmd', 'cmd'],
  ['cmd.exe', 'cmd'],
]);

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function toRepoRelativePath(repoRoot, targetPath) {
  const relativePath = path.relative(repoRoot, targetPath) || '.';
  return toPosixPath(relativePath);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function hasPluginMarker(dirPath) {
  const pluginDir = path.join(dirPath, '.claude-plugin');
  if (!(await pathExists(pluginDir))) {
    return false;
  }

  return true;
}

async function findOwningPluginRoot(repoRoot, configPath) {
  let currentDir = path.dirname(configPath);

  while (currentDir.startsWith(repoRoot)) {
    if (await hasPluginMarker(currentDir)) {
      return currentDir;
    }

    if (currentDir === repoRoot) {
      break;
    }

    currentDir = path.dirname(currentDir);
  }

  return repoRoot;
}

async function discoverConfigFiles(repoRoot) {
  /** @type {string[]} */
  const results = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }
        await walk(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const parentName = path.basename(currentDir);
      if (entry.name === 'hooks.json' && parentName === 'hooks') {
        results.push(entryPath);
        continue;
      }

      if (
        parentName === '.claude' &&
        (entry.name === 'settings.json' || entry.name === 'settings.local.json')
      ) {
        results.push(entryPath);
      }
    }
  }

  await walk(repoRoot);
  return results.sort((left, right) => left.localeCompare(right));
}

async function readJsonFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return { data: JSON.parse(raw), error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sourceKindFromRelativePath(relativePath) {
  for (const [suffix, sourceKind] of CONFIG_SUFFIXES.entries()) {
    if (relativePath.endsWith(suffix)) {
      return sourceKind;
    }
  }

  return 'unknown';
}

function replaceKnownVariables(command, pluginRoot, repoRoot) {
  return command
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('$CLAUDE_PLUGIN_ROOT', pluginRoot)
    .replaceAll('%CLAUDE_PLUGIN_ROOT%', pluginRoot)
    .replaceAll('${CLAUDE_PROJECT_DIR}', pluginRoot)
    .replaceAll('$CLAUDE_PROJECT_DIR', pluginRoot)
    .replaceAll('%CLAUDE_PROJECT_DIR%', pluginRoot)
    .replaceAll('${CLAUDE_PROJECT_ROOT}', repoRoot)
    .replaceAll('$CLAUDE_PROJECT_ROOT', repoRoot)
    .replaceAll('%CLAUDE_PROJECT_ROOT%', repoRoot);
}

function hasShellOperators(command) {
  return (
    command.includes('$(') ||
    command.includes('&&') ||
    command.includes('||') ||
    /[|;<>`]/.test(command)
  );
}

function splitCommand(command) {
  /** @type {string[]} */
  const tokens = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (const character of command) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += character;
  }

  if (escaping || quote) {
    return null;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

async function resolveLocalScriptPath(scriptToken, pluginRoot, repoRoot) {
  const absolutePath = path.isAbsolute(scriptToken)
    ? path.resolve(scriptToken)
    : path.resolve(pluginRoot, scriptToken);

  if (!(await isFile(absolutePath))) {
    return null;
  }

  const relativeToRepo = path.relative(repoRoot, absolutePath);
  if (relativeToRepo.startsWith('..') || path.isAbsolute(relativeToRepo)) {
    return null;
  }

  return toPosixPath(relativeToRepo);
}

function runtimeHintFromScriptPath(scriptPath) {
  const extension = path.extname(scriptPath).toLowerCase();
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return 'node';
  }
  if (extension === '.py') {
    return 'python';
  }
  if (extension === '.sh' || extension === '.bash') {
    return 'shell';
  }
  if (extension === '.ps1') {
    return 'powershell';
  }
  if (extension === '.cmd' || extension === '.bat') {
    return 'cmd';
  }
  if (!extension) {
    return 'extensionless-script';
  }

  return 'unknown-script';
}

async function inspectCommand(command, pluginRoot, repoRoot, handlerType) {
  if (handlerType !== 'command') {
    return {
      commandPrefix: [],
      commandArgs: [],
      hasShellOperators: false,
      resolvedScriptPath: null,
      runtimeHint: 'non-command-handler',
    };
  }

  if (typeof command !== 'string' || !command.trim()) {
    return {
      commandPrefix: [],
      commandArgs: [],
      hasShellOperators: false,
      resolvedScriptPath: null,
      runtimeHint: 'empty-command',
    };
  }

  const hydratedCommand = replaceKnownVariables(command, pluginRoot, repoRoot);
  const shellExpression = hasShellOperators(hydratedCommand);
  const tokens = splitCommand(hydratedCommand);

  if (!tokens || tokens.length === 0) {
    return {
      commandPrefix: [],
      commandArgs: [],
      hasShellOperators: shellExpression,
      resolvedScriptPath: null,
      runtimeHint: shellExpression ? 'shell-expression' : 'unparsed-command',
    };
  }

  const firstTokenName = path.basename(tokens[0]).toLowerCase();
  let scriptIndex = 0;

  if (INTERPRETER_HINTS.has(firstTokenName)) {
    if (tokens.length < 2 || tokens[1].startsWith('-')) {
      return {
        commandPrefix: [tokens[0]],
        commandArgs: tokens.slice(1),
        hasShellOperators: shellExpression,
        resolvedScriptPath: null,
        runtimeHint: INTERPRETER_HINTS.get(firstTokenName) ?? 'interpreter-command',
      };
    }
    scriptIndex = 1;
  }

  const resolvedScriptPath = shellExpression
    ? null
    : await resolveLocalScriptPath(tokens[scriptIndex], pluginRoot, repoRoot);
  const runtimeHint =
    INTERPRETER_HINTS.get(firstTokenName) ??
    (resolvedScriptPath
      ? runtimeHintFromScriptPath(resolvedScriptPath)
      : shellExpression
        ? 'shell-expression'
        : 'inline-command');

  return {
    commandPrefix: tokens.slice(0, scriptIndex),
    commandArgs: tokens.slice(scriptIndex + 1),
    hasShellOperators: shellExpression,
    resolvedScriptPath,
    runtimeHint,
  };
}

async function extractHookFacts({
  repoRoot,
  pluginRoot,
  configPath,
  configData,
}) {
  /** @type {Array<Record<string, unknown>>} */
  const facts = [];
  const hooksSection =
    configData && typeof configData === 'object' ? configData.hooks : null;

  if (!hooksSection || typeof hooksSection !== 'object' || Array.isArray(hooksSection)) {
    return facts;
  }

  const sourceConfigPath = toRepoRelativePath(repoRoot, configPath);
  const pluginRootPath = toRepoRelativePath(repoRoot, pluginRoot);
  const sourceKind = sourceKindFromRelativePath(sourceConfigPath);

  for (const [eventName, matcherGroups] of Object.entries(hooksSection)) {
    if (!Array.isArray(matcherGroups)) {
      continue;
    }

    for (const [groupIndex, group] of matcherGroups.entries()) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        continue;
      }

      const matcher = typeof group.matcher === 'string' ? group.matcher : null;
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];

      for (const [handlerIndex, handler] of handlers.entries()) {
        if (!handler || typeof handler !== 'object' || Array.isArray(handler)) {
          continue;
        }

        const handlerType =
          typeof handler.type === 'string' && handler.type
            ? handler.type
            : 'command';
        const command = typeof handler.command === 'string' ? handler.command : null;
        const inspection = await inspectCommand(
          command ?? '',
          pluginRoot,
          repoRoot,
          handlerType,
        );
        const mappedEvent = mapClaudeEvent(eventName);

        facts.push({
          hookId: `${sourceConfigPath}#${eventName}:${groupIndex}:${handlerIndex}`,
          source: sourceKind,
          sourceConfigPath,
          pluginRoot: pluginRootPath,
          originalEvent: eventName,
          candidateClineEvent: mappedEvent.candidateEvent,
          eventMappingKind: mappedEvent.mappingKind,
          eventMappingReason: mappedEvent.mappingReason,
          matcher,
          handlerType,
          async: handler.async === true,
          command,
          commandPrefix: inspection.commandPrefix,
          commandArgs: inspection.commandArgs,
          hasShellOperators: inspection.hasShellOperators,
          runtimeHint: inspection.runtimeHint,
          resolvedScriptPath: inspection.resolvedScriptPath,
        });
      }
    }
  }

  return facts;
}

export async function scanHooks({ repoRoot = process.cwd() } = {}) {
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const configPaths = await discoverConfigFiles(resolvedRepoRoot);
  /** @type {Array<Record<string, unknown>>} */
  const hooks = [];
  /** @type {Array<Record<string, unknown>>} */
  const configs = [];
  /** @type {Array<Record<string, unknown>>} */
  const warnings = [];

  for (const configPath of configPaths) {
    const pluginRoot = await findOwningPluginRoot(resolvedRepoRoot, configPath);
    const sourceConfigPath = toRepoRelativePath(resolvedRepoRoot, configPath);
    const sourceKind = sourceKindFromRelativePath(sourceConfigPath);
    const { data, error } = await readJsonFile(configPath);

    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
      configs.push({
        path: sourceConfigPath,
        source: sourceKind,
        pluginRoot: toRepoRelativePath(resolvedRepoRoot, pluginRoot),
        status: 'invalid-json',
      });
      warnings.push({
        type: 'invalid-json',
        path: sourceConfigPath,
        error,
      });
      continue;
    }

    const facts = await extractHookFacts({
      repoRoot: resolvedRepoRoot,
      pluginRoot,
      configPath,
      configData: data,
    });

    configs.push({
      path: sourceConfigPath,
      source: sourceKind,
      pluginRoot: toRepoRelativePath(resolvedRepoRoot, pluginRoot),
      status: 'parsed',
      hookCount: facts.length,
    });
    hooks.push(...facts);
  }

  return {
    repoRoot: resolvedRepoRoot,
    configCount: configs.length,
    hookCount: hooks.length,
    configs,
    hooks,
    warnings,
  };
}

async function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const result = await scanHooks({ repoRoot });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    logError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
