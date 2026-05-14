#!/usr/bin/env node
/* global process */
// @ts-check

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  isDirectRun,
  logError,
  logInfo,
  readStdin,
  resolveHooksOutputDir,
  resolveRepoRoot,
} from './utils.mjs';

const DEFAULT_ENTRY_EXECUTION_TIMEOUT_MS = 15_000;

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

async function runBashCommand(command, cwd, timeoutMs) {
  try {
    await execFileAsync('bash', ['-lc', command], {
      cwd,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    });
    return {
      exitCode: 0,
      timedOut: false,
    };
  } catch (error) {
    return {
      exitCode:
        error != null
        && typeof error === 'object'
        && 'code' in error
        && typeof error.code === 'number'
          ? error.code
          : 1,
      timedOut:
        Boolean(
          error != null
          && typeof error === 'object'
          && 'killed' in error
          && error.killed,
        ),
    };
  }
}

async function readCapturedExecution(captureDir, { exitCode, timedOut, timeoutMs }) {
  const stdoutPath = path.join(captureDir, 'stdout.txt');
  const stderrPath = path.join(captureDir, 'stderr.txt');
  const timeoutMessage = `[verify-hooks] execution timed out after ${timeoutMs}ms`;
  const capturedStderr = await readFile(stderrPath, 'utf8').catch(() => '');

  return {
    stdout: await readFile(stdoutPath, 'utf8').catch(() => ''),
    stderr:
      timedOut
        ? capturedStderr.trim().length > 0
          ? `${capturedStderr}\n${timeoutMessage}`
          : timeoutMessage
        : capturedStderr,
    exitCode,
  };
}

async function runCommandWithClosedStdin(command, args, stdinInput, cwd, timeoutMs) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        stdout,
        stderr: stderr || (error instanceof Error ? error.message : String(error)),
        exitCode: 1,
        timedOut,
      });
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : 1,
        timedOut,
      });
    });

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdin.end(stdinInput);
  });
}

async function runUnixScript(scriptPath, stdinInput, timeoutMs) {
  const captureDir = await mkdtemp(path.join(os.tmpdir(), 'verify-hooks-shell-'));
  const stdinPath = path.join(captureDir, 'stdin.json');
  const stdoutPath = path.join(captureDir, 'stdout.txt');
  const stderrPath = path.join(captureDir, 'stderr.txt');

  await writeFile(stdinPath, stdinInput, 'utf8');

  try {
    const result = await runBashCommand(
      `cat ${shellEscape(stdinPath)} | /bin/sh ${shellEscape(scriptPath)} > ${shellEscape(stdoutPath)} 2> ${shellEscape(stderrPath)}`,
      path.dirname(scriptPath),
      timeoutMs,
    );
    return await readCapturedExecution(captureDir, {
      ...result,
      timeoutMs,
    });
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
}

async function detectPowerShellCommand() {
  const candidates = process.platform === 'win32'
    ? ['pwsh', 'powershell']
    : ['pwsh'];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
      return candidate;
    } catch {
      // Try the next runtime.
    }
  }

  return null;
}

async function runWindowsScript(scriptPath, stdinInput, command, timeoutMs) {
  if (process.platform !== 'win32') {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), 'verify-hooks-ps1-'));
    const stdinPath = path.join(captureDir, 'stdin.json');
    const stdoutPath = path.join(captureDir, 'stdout.txt');
    const stderrPath = path.join(captureDir, 'stderr.txt');

    await writeFile(stdinPath, stdinInput, 'utf8');

    try {
      const result = await runBashCommand(
        `cat ${shellEscape(stdinPath)} | ${shellEscape(command)} -NoProfile -File ${shellEscape(scriptPath)} > ${shellEscape(stdoutPath)} 2> ${shellEscape(stderrPath)}`,
        path.dirname(scriptPath),
        timeoutMs,
      );
      return await readCapturedExecution(captureDir, {
        ...result,
        timeoutMs,
      });
    } finally {
      await rm(captureDir, { recursive: true, force: true });
    }
  }

  return await runCommandWithClosedStdin(
    command,
    ['-NoProfile', '-File', scriptPath],
    stdinInput,
    path.dirname(scriptPath),
    timeoutMs,
  );
}

function buildEntryFixture(eventName, repoRoot) {
  const baseFixture = {
    eventName,
    workspaceRoot: repoRoot,
    cwd: repoRoot,
    task: 'verify migrated hook execution',
    message: 'verify migrated hook execution',
    userPrompt: 'verify migrated hook execution',
    toolName: 'Read',
    tool_name: 'Read',
    toolInput: {
      filePath: 'README.md',
      path: 'README.md',
    },
    parameters: {
      filePath: 'README.md',
      path: 'README.md',
    },
    result: 'ok',
    success: true,
    executionTimeMs: 1,
    transcriptPath: 'transcript.md',
  };

  const fixtureByEvent = {
    PreToolUse: {
      ...baseFixture,
      preToolUse: {
        toolName: 'Read',
        parameters: baseFixture.parameters,
      },
    },
    PostToolUse: {
      ...baseFixture,
      postToolUse: {
        toolName: 'Read',
        parameters: baseFixture.parameters,
        result: baseFixture.result,
        success: true,
        executionTimeMs: 1,
      },
    },
    UserPromptSubmit: {
      ...baseFixture,
      prompt: 'verify migrated hook execution',
      userPromptSubmit: {
        prompt: 'verify migrated hook execution',
      },
    },
    PreCompact: {
      ...baseFixture,
      preCompact: {
        transcriptPath: 'transcript.md',
      },
    },
    TaskStart: {
      ...baseFixture,
      taskStart: {
        task: 'verify migrated hook execution',
      },
    },
    TaskComplete: {
      ...baseFixture,
      taskComplete: {
        result: 'completed',
        success: true,
      },
    },
    TaskCancel: {
      ...baseFixture,
      success: false,
      taskCancel: {
        reason: 'verification fixture cancellation',
      },
    },
  };

  return JSON.stringify(fixtureByEvent[eventName] ?? baseFixture);
}

function formatCapturedOutput(value) {
  return value.trim().length > 0 ? value : '(empty)';
}

function formatExecutionFailure({
  eventName,
  runtime,
  entryPath,
  repoRoot,
  exitCode,
  stdout,
  stderr,
  validationError = null,
}) {
  const detailLines = [
    `[verify-hooks] event=${eventName} runtime=${runtime} entry=${path.relative(repoRoot, entryPath)}`,
    `exitCode=${exitCode}`,
  ];

  if (validationError) {
    detailLines.push(`validationError=${validationError}`);
  }

  detailLines.push(
    '',
    'stdout:',
    formatCapturedOutput(stdout),
    '',
    'stderr:',
    formatCapturedOutput(stderr),
  );

  return detailLines.join('\n');
}

function validateEntryOutput({
  stdout,
  stderr,
  exitCode,
  eventName,
  runtime,
  entryPath,
  repoRoot,
}) {
  const trimmedStdout = stdout.trim();
  if (!trimmedStdout) {
    throw new Error(
      formatExecutionFailure({
        eventName,
        runtime,
        entryPath,
        repoRoot,
        exitCode,
        stdout,
        stderr,
        validationError: 'entry did not emit JSON to stdout',
      }),
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmedStdout);
  } catch (error) {
    throw new Error(
      formatExecutionFailure({
        eventName,
        runtime,
        entryPath,
        repoRoot,
        exitCode,
        stdout,
        stderr,
        validationError: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      formatExecutionFailure({
        eventName,
        runtime,
        entryPath,
        repoRoot,
        exitCode,
        stdout,
        stderr,
        validationError: 'entry stdout must be a JSON object',
      }),
    );
  }

  if (typeof parsed.cancel !== 'boolean') {
    throw new Error(
      formatExecutionFailure({
        eventName,
        runtime,
        entryPath,
        repoRoot,
        exitCode,
        stdout,
        stderr,
        validationError: 'entry JSON must include boolean cancel',
      }),
    );
  }

  if ('contextModification' in parsed && typeof parsed.contextModification !== 'string') {
    throw new Error(
      formatExecutionFailure({
        eventName,
        runtime,
        entryPath,
        repoRoot,
        exitCode,
        stdout,
        stderr,
        validationError: 'contextModification must be a string when provided',
      }),
    );
  }

  if ('errorMessage' in parsed && typeof parsed.errorMessage !== 'string') {
    throw new Error(
      formatExecutionFailure({
        eventName,
        runtime,
        entryPath,
        repoRoot,
        exitCode,
        stdout,
        stderr,
        validationError: 'errorMessage must be a string when provided',
      }),
    );
  }

  if (
    parsed.cancel === false
    && !('contextModification' in parsed)
  ) {
    throw new Error(
      formatExecutionFailure({
        eventName,
        runtime,
        entryPath,
        repoRoot,
        exitCode,
        stdout,
        stderr,
        validationError: 'entry returned cancel:false without contextModification; migrated handlers produced no output',
      }),
    );
  }

  return parsed;
}

async function executeEntryScript({
  repoRoot,
  entryPath,
  runtime,
  stdinInput,
  powerShellCommand = null,
  executionTimeoutMs = DEFAULT_ENTRY_EXECUTION_TIMEOUT_MS,
}) {
  if (runtime === 'shell') {
    return await runUnixScript(entryPath, stdinInput, executionTimeoutMs);
  }

  if (!powerShellCommand) {
    throw new Error(`PowerShell runtime is unavailable for ${path.relative(repoRoot, entryPath)}`);
  }

  return await runWindowsScript(entryPath, stdinInput, powerShellCommand, executionTimeoutMs);
}

async function verifyEntryExecution({
  repoRoot,
  entryPath,
  eventName,
  runtime,
  executeEntry,
  powerShellCommand = null,
  executionTimeoutMs,
}) {
  const stdinInput = buildEntryFixture(eventName, repoRoot);
  const execution = await executeEntry({
    repoRoot,
    entryPath,
    runtime,
    stdinInput,
    powerShellCommand,
    executionTimeoutMs,
  });

  if (!execution || typeof execution !== 'object') {
    throw new Error(`Entry executor returned an invalid result for ${path.relative(repoRoot, entryPath)}`);
  }

  const stdout = typeof execution.stdout === 'string' ? execution.stdout : '';
  const timedOut = Boolean(
    execution != null
    && typeof execution === 'object'
    && 'timedOut' in execution
    && execution.timedOut,
  );
  const stderrBase = typeof execution.stderr === 'string' ? execution.stderr : '';
  const stderr = timedOut
    ? stderrBase.trim().length > 0
      ? `${stderrBase}\n[verify-hooks] execution timed out after ${executionTimeoutMs}ms`
      : `[verify-hooks] execution timed out after ${executionTimeoutMs}ms`
    : stderrBase;
  const exitCode = typeof execution.exitCode === 'number' ? execution.exitCode : 1;

  if (exitCode !== 0) {
    throw new Error(
      formatExecutionFailure({
        eventName,
        runtime,
        entryPath,
        repoRoot,
        exitCode,
        stdout,
        stderr,
      }),
    );
  }

  validateEntryOutput({
    stdout,
    stderr,
    exitCode,
    eventName,
    runtime,
    entryPath,
    repoRoot,
  });

  return {
    runtime,
    entryScript: path.relative(repoRoot, entryPath).replaceAll(path.sep, '/'),
  };
}

async function verifyWindowsEntryScript(entryPath, repoRoot) {
  const entryScriptContent = await readFile(entryPath, 'utf8');
  if (!entryScriptContent.includes('function Write-ClineResult')) {
    throw new Error(
      `Windows entry script is missing JSON result emitter: ${path.relative(repoRoot, entryPath)}`,
    );
  }
  if (!entryScriptContent.includes('ConvertTo-Json -Compress')) {
    throw new Error(
      `Windows entry script is missing JSON serialization: ${path.relative(repoRoot, entryPath)}`,
    );
  }
  if (
    entryScriptContent.includes('$normalizeHandlerOutputBase64')
    || entryScriptContent.includes('Buffer.from(process.argv[1], "base64").toString("utf8")')
    || entryScriptContent.includes('node -e "console.log(JSON.stringify({cancel:true,errorMessage:process.argv[1]}))"')
    || entryScriptContent.includes('node -e "console.log(JSON.stringify({cancel:false,contextModification:process.argv[1]}))"')
    || entryScriptContent.includes('Normalize-HandlerOutput')
    || entryScriptContent.includes('ConvertFrom-Json')
  ) {
    throw new Error(
      `Windows entry script still relies on legacy handler normalization: ${path.relative(repoRoot, entryPath)}`,
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
  executeEntry = executeEntryScript,
  executionTimeoutMs = DEFAULT_ENTRY_EXECUTION_TIMEOUT_MS,
} = {}) {
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const hooksDir = resolveHooksOutputDir(resolvedRepoRoot);

  if (!Array.isArray(expectedFiles)) {
    throw new Error('expectedFiles must be an array when provided.');
  }
  if (!Array.isArray(unresolvedHooks)) {
    throw new Error('unresolvedHooks must be an array when provided.');
  }
  if (typeof executeEntry !== 'function') {
    throw new Error('executeEntry must be a function when provided.');
  }
  if (
    !Number.isFinite(executionTimeoutMs)
    || executionTimeoutMs <= 0
  ) {
    throw new Error('executionTimeoutMs must be a positive number when provided.');
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

  const unixEntries = [];
  for (const entry of hookEntries) {
    if (!entry.isFile() || entry.name.startsWith('.') || entry.name.includes('.')) {
      continue;
    }
    unixEntries.push(path.join(hooksDir, entry.name));
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

  const powerShellCommand = await detectPowerShellCommand();
  /** @type {Array<{ runtime: string; entryScript: string }>} */
  const executedEntries = [];
  /** @type {Array<{ runtime: string; entryScript: string }>} */
  const supplementalWindowsExecutions = [];

  if (process.platform === 'win32') {
    if (windowsEntries.length === 0) {
      throw new Error(`No Windows hook entry scripts found under ${hooksDir}`);
    }

    for (const entryPath of hookEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ps1'))
      .map((entry) => path.join(hooksDir, entry.name))) {
      executedEntries.push(
        await verifyEntryExecution({
          repoRoot: resolvedRepoRoot,
          entryPath,
          eventName: path.basename(entryPath, '.ps1'),
          runtime: 'ps1',
          executeEntry,
          powerShellCommand,
          executionTimeoutMs,
        }),
      );
    }
  } else {
    if (unixEntries.length === 0) {
      throw new Error(`No Unix hook entry scripts found under ${hooksDir}`);
    }

    for (const entryPath of unixEntries) {
      executedEntries.push(
        await verifyEntryExecution({
          repoRoot: resolvedRepoRoot,
          entryPath,
          eventName: path.basename(entryPath),
          runtime: 'shell',
          executeEntry,
          executionTimeoutMs,
        }),
      );
    }

    if (powerShellCommand) {
      for (const entryPath of hookEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ps1'))
        .map((entry) => path.join(hooksDir, entry.name))) {
        supplementalWindowsExecutions.push(
          await verifyEntryExecution({
            repoRoot: resolvedRepoRoot,
            entryPath,
            eventName: path.basename(entryPath, '.ps1'),
            runtime: 'ps1',
            executeEntry,
            powerShellCommand,
            executionTimeoutMs,
          }),
        );
      }
    }
  }

  return {
    status: 'verified',
    repoRoot: resolvedRepoRoot,
    hooksDir,
    checkedFiles: mjsFiles.map((filePath) => path.relative(resolvedRepoRoot, filePath)),
    executedEntries,
    supplementalWindowsExecutions,
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
