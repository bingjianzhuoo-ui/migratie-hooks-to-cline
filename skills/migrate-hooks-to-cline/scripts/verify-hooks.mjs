#!/usr/bin/env node
/* global process */
// @ts-check

import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import {
  isDirectRun,
  logError,
  logInfo,
  readStdin,
  resolveHooksOutputDir,
  resolveRepoRoot,
} from './utils.mjs';

async function pathStats(targetPath) {
  try {
    return await stat(targetPath);
  } catch {
    return null;
  }
}

async function isDirectory(targetPath) {
  const stats = await pathStats(targetPath);
  return stats?.isDirectory() ?? false;
}

async function isFile(targetPath) {
  const stats = await pathStats(targetPath);
  return stats?.isFile() ?? false;
}

function formatUnresolvedHook(unresolvedHook) {
  if (typeof unresolvedHook === 'string' && unresolvedHook.trim()) {
    return unresolvedHook.trim();
  }

  if (unresolvedHook && typeof unresolvedHook === 'object') {
    for (const key of ['hookId', 'event', 'sourceConfigPath', 'reason']) {
      const value = unresolvedHook[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }

  return JSON.stringify(unresolvedHook);
}

function normalizeExpectedFilePath(repoRoot, hooksDir, expectedFile) {
  if (typeof expectedFile !== 'string' || !expectedFile.trim()) {
    throw new Error('expectedFiles must contain only non-empty strings.');
  }

  const trimmedPath = expectedFile.trim();
  if (path.isAbsolute(trimmedPath)) {
    return path.normalize(trimmedPath);
  }

  if (
    trimmedPath === '.clinerules/hooks' ||
    trimmedPath.startsWith(`.clinerules${path.sep}hooks${path.sep}`) ||
    trimmedPath.startsWith('.clinerules/hooks/')
  ) {
    return path.join(repoRoot, trimmedPath);
  }

  return path.join(hooksDir, trimmedPath);
}

async function collectMjsFiles(hooksDir) {
  const entries = await readdir(hooksDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) {
      continue;
    }

    files.push(path.join(hooksDir, entry.name));
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

const execFileAsync = promisify(execFile);

async function runNodeCheck(filePath, repoRoot) {
  try {
    await execFileAsync('node', ['--check', filePath]);
  } catch (error) {
    throw new Error(
      `node --check failed for ${path.relative(repoRoot, filePath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runUnixScript(scriptPath, stdinInput) {
  const captureDir = await mkdtemp(path.join(os.tmpdir(), 'verify-hooks-capture-'));
  const stdoutPath = path.join(captureDir, 'stdout.txt');
  const stderrPath = path.join(captureDir, 'stderr.txt');

  try {
    await execFileAsync(
      'bash',
      [
        '-lc',
        `printf '%s' ${shellEscape(stdinInput)} | /bin/sh ${shellEscape(scriptPath)} > ${shellEscape(stdoutPath)} 2> ${shellEscape(stderrPath)}`,
      ],
      { cwd: path.dirname(scriptPath) },
    );

    return {
      stdout: await readFile(stdoutPath, 'utf8').catch(() => ''),
      stderr: await readFile(stderrPath, 'utf8').catch(() => ''),
      exitCode: 0,
    };
  } catch (error) {
    return {
      stdout: await readFile(stdoutPath, 'utf8').catch(() => ''),
      stderr: await readFile(stderrPath, 'utf8').catch(() => ''),
      exitCode:
        error != null
        && typeof error === 'object'
        && 'code' in error
        && typeof error.code === 'number'
          ? error.code
          : 1,
    };
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
}

async function runInlineNodeScript(scriptSource, stdinInput, cwd = process.cwd()) {
  const captureDir = await mkdtemp(path.join(os.tmpdir(), 'verify-hooks-node-'));
  const stdoutPath = path.join(captureDir, 'stdout.txt');
  const stderrPath = path.join(captureDir, 'stderr.txt');

  try {
    await execFileAsync(
      'bash',
      [
        '-lc',
        `printf '%s' ${shellEscape(stdinInput)} | node -e ${shellEscape(scriptSource)} > ${shellEscape(stdoutPath)} 2> ${shellEscape(stderrPath)}`,
      ],
      { cwd },
    );

    return {
      stdout: await readFile(stdoutPath, 'utf8').catch(() => ''),
      stderr: await readFile(stderrPath, 'utf8').catch(() => ''),
      exitCode: 0,
    };
  } catch (error) {
    return {
      stdout: await readFile(stdoutPath, 'utf8').catch(() => ''),
      stderr: await readFile(stderrPath, 'utf8').catch(() => ''),
      exitCode:
        error != null
        && typeof error === 'object'
        && 'code' in error
        && typeof error.code === 'number'
          ? error.code
          : 1,
    };
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
}

async function smokeTestUnixEntry(eventName, entryScriptContent, repoRoot) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'verify-hooks-'));
  const entryPath = path.join(tmpDir, eventName);
  const handler1 = path.join(tmpDir, `${eventName}-plugin1.mjs`);
  const handler2 = path.join(tmpDir, `${eventName}-plugin2.mjs`);

  try {
    await writeFile(
      handler1,
      `console.log(JSON.stringify({ cancel: false, contextModification: 'plugin1-context' }));\nprocess.exit(0);\n`,
      'utf8',
    );
    await writeFile(handler2, `process.exit(0);\n`, 'utf8');
    await writeFile(entryPath, entryScriptContent, 'utf8');
    await chmod(entryPath, 0o755);

    const { stdout, stderr, exitCode } = await runUnixScript(
      entryPath,
      JSON.stringify({ toolName: 'Read', toolInput: {} }),
    );

    if (exitCode !== 0) {
      throw new Error(
        `Entry script smoke test exited with code ${exitCode}: ${stderr || stdout}`,
      );
    }

    let output;
    try {
      output = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`Unexpected smoke test output: ${stdout}`);
    }

    if (
      output.cancel !== false ||
      output.contextModification !== 'plugin1-context'
    ) {
      throw new Error(
        `Unexpected smoke test output: ${stdout}`,
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function extractWindowsNormalizerScript(entryScriptContent) {
  const match = entryScriptContent.match(/\$normalizeHandlerOutput = @'\r?\n([\s\S]*?)\r?\n'@/);
  if (!match) {
    throw new Error('Windows entry script is missing the normalize handler block.');
  }

  return match[1];
}

async function verifyWindowsEntryScript(entryPath, repoRoot) {
  const entryScriptContent = await readFile(entryPath, 'utf8');
  const normalizeScript = extractWindowsNormalizerScript(entryScriptContent);
  const safeNodeBridge =
    'node -e \'eval(Buffer.from(process.argv[1], "base64").toString("utf8"))\' $normalizeHandlerOutputBase64';

  if (!normalizeScript.includes('require("node:fs")')) {
    throw new Error(
      `Windows entry script lost the quoted node:fs require: ${path.relative(repoRoot, entryPath)}`,
    );
  }
  if (!entryScriptContent.includes('$normalizeHandlerOutputBase64 = "')) {
    throw new Error(
      `Windows entry script is missing the base64 normalize payload: ${path.relative(repoRoot, entryPath)}`,
    );
  }
  if (!entryScriptContent.includes(safeNodeBridge)) {
    throw new Error(
      `Windows entry script is missing the safe node bridge: ${path.relative(repoRoot, entryPath)}`,
    );
  }

  const rawOutputResult = await runInlineNodeScript(normalizeScript, 'plain-text-output', path.dirname(entryPath));
  if (rawOutputResult.exitCode !== 0 || rawOutputResult.stdout.trim() !== 'plain-text-output') {
    throw new Error(
      `Windows normalize block raw-text check failed for ${path.relative(repoRoot, entryPath)}: ${rawOutputResult.stderr || rawOutputResult.stdout}`,
    );
  }

  const jsonOutputResult = await runInlineNodeScript(
    normalizeScript,
    JSON.stringify({ cancel: false, contextModification: 'plugin1-context' }),
    path.dirname(entryPath),
  );
  if (jsonOutputResult.exitCode !== 0 || jsonOutputResult.stdout.trim() !== 'plugin1-context') {
    throw new Error(
      `Windows normalize block JSON check failed for ${path.relative(repoRoot, entryPath)}: ${jsonOutputResult.stderr || jsonOutputResult.stdout}`,
    );
  }
}

async function parseCliInput() {
  const raw = await readStdin();
  if (!raw.trim()) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `verify-hooks stdin must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('verify-hooks stdin must be a JSON object.');
  }

  return parsed;
}

export async function verifyHooks({
  repoRoot = process.cwd(),
  expectedFiles = [],
  unresolvedHooks = [],
  smokeTestEntry = smokeTestUnixEntry,
} = {}) {
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const hooksDir = resolveHooksOutputDir(resolvedRepoRoot);

  if (!Array.isArray(expectedFiles)) {
    throw new Error('expectedFiles must be an array when provided.');
  }
  if (!Array.isArray(unresolvedHooks)) {
    throw new Error('unresolvedHooks must be an array when provided.');
  }
  if (typeof smokeTestEntry !== 'function') {
    throw new Error('smokeTestEntry must be a function when provided.');
  }

  if (unresolvedHooks.length > 0) {
    const formattedHooks = unresolvedHooks.map(formatUnresolvedHook).join(', ');
    throw new Error(`Unresolved hooks remain: ${formattedHooks}`);
  }

  if (!(await isDirectory(hooksDir))) {
    throw new Error(`Hooks output directory not found: ${hooksDir}`);
  }

  const hookEntries = await readdir(hooksDir, { withFileTypes: true });
  if (hookEntries.length === 0) {
    throw new Error(`Hooks output directory is empty: ${hooksDir}`);
  }

  for (const expectedFile of expectedFiles) {
    const absolutePath = normalizeExpectedFilePath(
      resolvedRepoRoot,
      hooksDir,
      expectedFile,
    );
    if (!(await isFile(absolutePath))) {
      throw new Error(
        `Expected generated hook file is missing: ${path.relative(resolvedRepoRoot, absolutePath)}`,
      );
    }
  }

  const mjsFiles = await collectMjsFiles(hooksDir);
  if (mjsFiles.length === 0) {
    throw new Error(`No generated .mjs files found under ${hooksDir}`);
  }

  for (const filePath of mjsFiles) {
    await runNodeCheck(filePath, resolvedRepoRoot);
  }

  // Find Unix entry scripts: files without an extension
  const unixEntries = [];
  for (const entry of hookEntries) {
    if (!entry.isFile() || entry.name.startsWith('.') || entry.name.includes('.')) {
      continue;
    }
    unixEntries.push(path.join(hooksDir, entry.name));
  }

  const smokeTests = [];
  if (unixEntries.length > 0) {
    const firstEntry = unixEntries[0];
    const entryContent = await readFile(firstEntry, 'utf8');
    const eventName = path.basename(firstEntry);
    await smokeTestEntry(eventName, entryContent, resolvedRepoRoot);
    smokeTests.push(path.relative(resolvedRepoRoot, firstEntry));
  }

  const windowsEntries = [];
  for (const entry of hookEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.ps1')) {
      continue;
    }
    const entryPath = path.join(hooksDir, entry.name);
    await verifyWindowsEntryScript(entryPath, resolvedRepoRoot);
    windowsEntries.push(path.relative(resolvedRepoRoot, entryPath));
  }

  return {
    status: 'verified',
    repoRoot: resolvedRepoRoot,
    hooksDir,
    checkedFiles: mjsFiles.map((filePath) => path.relative(resolvedRepoRoot, filePath)),
    smokeTests,
    windowsEntries,
  };
}

async function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const input = await parseCliInput();
  const result = await verifyHooks({
    repoRoot,
    expectedFiles: input.expectedFiles,
    unresolvedHooks: input.unresolvedHooks,
  });
  logInfo(`verify-hooks passed for output: ${resolveHooksOutputDir(repoRoot)}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    logError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
