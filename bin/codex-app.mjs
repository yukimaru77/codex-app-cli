#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_PROFILE_LAUNCH_TIMEOUT_MS = 20_000;
const DEFAULT_BOOTSTRAP_TEXT = 'Use the imported conversation context when answering future requests.';
const VERSION_BY_METHOD = new Map([
  ['thread-owner-discovery', 1],
  ['thread-follower-start-turn', 1],
  ['thread-follower-load-complete-history', 1],
  ['thread-follower-interrupt-turn', 4],
]);

function methodVersion(method, params) {
  if (method === 'thread-follower-interrupt-turn' && params?.expectedTurnId == null) return 3;
  return VERSION_BY_METHOD.get(method) ?? 0;
}

export function socketCandidates(env = process.env, platform = process.platform) {
  if (env.CODEX_IPC_SOCKET) return [env.CODEX_IPC_SOCKET];
  if (platform === 'win32') return [String.raw`\\.\pipe\codex-ipc`];

  const temporaryDirectory = env.TMPDIR || os.tmpdir() || '/tmp';
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const names = uid == null ? ['ipc.sock'] : [`ipc-${uid}.sock`, 'ipc.sock'];
  const candidates = [path.join(os.homedir(), '.codex', 'ipc', 'ipc.sock')];

  for (const directory of new Set([
    path.join(temporaryDirectory, 'codex-ipc'),
    '/tmp/codex-ipc',
  ])) {
    for (const name of names) candidates.push(path.join(directory, name));
  }

  return [...new Set(candidates)];
}

export function findSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidates = socketCandidates(env, platform);
  if (platform === 'win32') return candidates[0];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isSocket()) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }

  throw new Error([
    'Codex App IPC socket was not found. Start the Codex/ChatGPT desktop app.',
    ...candidates.map((candidate) => `  checked: ${candidate}`),
  ].join('\n'));
}

export function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 64 * 1024 * 1024) throw new Error(`IPC frame is too large: ${length}`);
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      this.onMessage(JSON.parse(payload.toString('utf8')));
    }
  }
}

export class CodexAppClient {
  constructor({ socketPath = findSocketPath(), timeoutMs = DEFAULT_TIMEOUT_MS, clientType = 'codex-app-cli' } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.clientType = clientType;
    this.socket = null;
    this.clientId = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.decoder = new FrameDecoder((message) => this.#receive(message));
  }

  async connect() {
    if (this.socket) return;
    this.socket = net.createConnection(this.socketPath);
    this.socket.on('data', (chunk) => this.decoder.push(chunk));
    this.socket.on('error', (error) => this.#rejectAll(error));
    this.socket.on('close', () => this.#rejectAll(new Error('Codex App IPC connection closed')));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`IPC connect timed out: ${this.socketPath}`)), this.timeoutMs);
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const response = await this.request('initialize', { clientType: this.clientType }, { includeVersion: false });
    assertSuccess(response, 'initialize');
    this.clientId = response.result.clientId;
  }

  request(method, params = {}, { includeVersion = true, targetClientId, timeoutMs = this.timeoutMs } = {}) {
    if (!this.socket?.writable) throw new Error('Codex App IPC client is not connected');
    const requestId = randomUUID();
    const message = {
      type: 'request',
      requestId,
      sourceClientId: this.clientId ?? undefined,
      method,
      params,
      targetClientId,
    };
    if (includeVersion) message.version = methodVersion(method, params);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(encodeFrame(message));
    });
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForMessage(predicate, timeoutMs = this.timeoutMs) {
    let unsubscribe;
    let timer;
    const promise = new Promise((resolve, reject) => {
      unsubscribe = this.onMessage((message) => {
        let matches;
        try {
          matches = predicate(message);
        } catch (error) {
          clearTimeout(timer);
          unsubscribe();
          reject(error);
          return;
        }
        if (!matches) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(message);
      });
      timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`IPC broadcast timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    promise.cancel = () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
    return promise;
  }

  close() {
    this.socket?.end();
    this.socket = null;
  }

  #receive(message) {
    if (message.type === 'response' && this.pending.has(message.requestId)) {
      const pending = this.pending.get(message.requestId);
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      pending.resolve(message);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestWhenHandlerReady(
  client,
  method,
  params,
  { targetClientId, readinessTimeoutMs, requestTimeoutMs },
) {
  const deadline = Date.now() + readinessTimeoutMs;
  do {
    const response = await client.request(method, params, {
      targetClientId,
      timeoutMs: requestTimeoutMs,
    });
    if (response?.resultType === 'success') return response;
    if (response?.error !== 'no-client-found') {
      assertSuccess(response, method);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${method} handler did not become ready on desktop client ${targetClientId}: ${response.error}`);
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`${method} handler did not become ready on desktop client ${targetClientId}`);
}

export class AppServerClient {
  constructor({
    command = 'codex',
    args = ['app-server', '--listen', 'stdio://'],
    env = process.env,
    timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  } = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationWaiters = new Set();
    this.stderr = '';
    this.stdoutBuffer = '';
  }

  async start() {
    if (this.child) return;
    const child = spawn(this.command, this.args, {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#receiveOutput(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_384);
    });
    child.on('error', (error) => this.#fail(error));
    child.on('exit', (code, signal) => {
      if (this.pending.size || this.notificationWaiters.size) {
        this.#fail(new Error(`codex app-server exited (code=${code}, signal=${signal})${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
      }
    });

    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await this.request('initialize', {
      clientInfo: { name: 'codex_app_cli', title: 'Codex App CLI', version: '0.1.0' },
    });
    this.notify('initialized', {});
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.child?.stdin.writable) throw new Error('codex app-server is not running');
    const id = this.nextId++;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin.writable) throw new Error('codex app-server is not running');
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  waitForNotification(method, predicate = () => true, timeoutMs = this.timeoutMs) {
    let waiter;
    const promise = new Promise((resolve, reject) => {
      waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.notificationWaiters.delete(waiter);
        reject(new Error(`${method} notification timed out after ${timeoutMs}ms${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
      }, timeoutMs);
      this.notificationWaiters.add(waiter);
    });
    promise.cancel = () => {
      if (!this.notificationWaiters.delete(waiter)) return;
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`${method} notification wait cancelled`));
    };
    return promise;
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.stdin.writable) child.stdin.end();
    if (child.exitCode != null || child.signalCode != null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #receiveOutput(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.#fail(new Error(`Invalid JSON from codex app-server: ${error.message}`));
        continue;
      }
      this.#receive(message);
    }
  }

  #receive(message) {
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed (${message.error.code}): ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) return;
    for (const waiter of [...this.notificationWaiters]) {
      if (waiter.method !== message.method || !waiter.predicate(message.params)) continue;
      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
      waiter.resolve(message.params);
    }
  }

  #fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateRollout(sourcePath, expectedSessionId) {
  if (!sourcePath) throw new Error('recognize requires --rollout <path>');
  if (!expectedSessionId) throw new Error('recognize requires --session-id <id>');
  const absoluteSourcePath = path.resolve(sourcePath);
  const sourceStat = fs.lstatSync(absoluteSourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`rollout must be a regular file, not a symlink: ${absoluteSourcePath}`);
  }

  const filename = path.basename(absoluteSourcePath);
  const filenameMatch = filename.match(new RegExp(
    `^rollout-(\\d{4})-(\\d{2})-(\\d{2})T.+-${escapeRegExp(expectedSessionId)}\\.jsonl$`,
  ));
  if (!filenameMatch) {
    throw new Error(`rollout filename must contain the date and end with the session ID: ${expectedSessionId}`);
  }

  const content = fs.readFileSync(absoluteSourcePath, 'utf8');
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
  if (!content || lines.some((line) => !line.trim())) throw new Error('rollout must contain one JSON object per non-empty line');
  const records = lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSON on rollout line ${index + 1}: ${error.message}`);
    }
    if (record.ordinal !== index) {
      throw new Error(`rollout line ${index + 1} must have ordinal ${index}; got ${JSON.stringify(record.ordinal)}`);
    }
    return record;
  });
  const meta = records[0];
  if (meta?.type !== 'session_meta') throw new Error('first rollout record must be session_meta');
  if (meta.payload?.id !== expectedSessionId) {
    throw new Error(`session_meta.payload.id does not match session ID: ${JSON.stringify(meta.payload?.id)}`);
  }
  if (meta.payload?.session_id !== expectedSessionId) {
    throw new Error(`session_meta.payload.session_id does not match session ID: ${JSON.stringify(meta.payload?.session_id)}`);
  }

  return {
    sourcePath: absoluteSourcePath,
    filename,
    sessionId: expectedSessionId,
    year: filenameMatch[1],
    month: filenameMatch[2],
    day: filenameMatch[3],
    content,
    recordCount: records.length,
  };
}

export function rolloutDestination(validation, home = codexHome()) {
  return path.join(home, 'sessions', validation.year, validation.month, validation.day, validation.filename);
}

export function installRollout(validation, home = codexHome()) {
  const destination = rolloutDestination(validation, home);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.codex-app-cli-${process.pid}-${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, validation.content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, destination);
    fs.chmodSync(destination, 0o600);
    return destination;
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`refusing to overwrite existing rollout: ${destination}`);
    throw error;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function runAppServerTurn(client, threadId, cwd, text, timeoutMs) {
  const completed = client.waitForNotification(
    'turn/completed',
    (params) => params?.threadId === threadId,
    timeoutMs,
  );
  let started;
  try {
    started = await client.request('turn/start', {
      threadId,
      cwd,
      effort: 'low',
      input: [{ type: 'text', text }],
    }, timeoutMs);
  } catch (error) {
    completed.cancel?.();
    completed.catch(() => {});
    throw error;
  }
  const notification = await completed;
  if (started?.turn?.id && notification.turn?.id !== started.turn.id) {
    throw new Error(`turn/completed ID mismatch: expected ${started.turn.id}, got ${notification.turn?.id}`);
  }
  if (notification.turn?.status !== 'completed') {
    throw new Error(`turn did not complete successfully: ${notification.turn?.status ?? 'unknown'}`);
  }
  return notification.turn;
}

export async function recognizeSession({
  templateSessionId,
  cwd,
  name,
  bootstrapText = DEFAULT_BOOTSTRAP_TEXT,
  initialText,
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  client,
}) {
  const absoluteCwd = path.resolve(cwd);
  const forkResult = await client.request('thread/fork', {
    threadId: templateSessionId,
    cwd: absoluteCwd,
    ephemeral: false,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    threadSource: 'user',
  }, timeoutMs);
  const threadId = forkResult?.thread?.id;
  if (!threadId) throw new Error('thread/fork did not return thread.id');

  const bootstrapTurn = await runAppServerTurn(client, threadId, absoluteCwd, bootstrapText, timeoutMs);
  let initialTurn = null;
  if (initialText) initialTurn = await runAppServerTurn(client, threadId, absoluteCwd, initialText, timeoutMs);
  await client.request('thread/name/set', { threadId, name }, timeoutMs);
  const readResult = await client.request('thread/read', { threadId, includeTurns: true }, timeoutMs);
  const thread = readResult?.thread;
  if (thread?.id !== threadId) throw new Error(`thread/read did not return child thread: ${threadId}`);
  if (path.resolve(thread.cwd) !== absoluteCwd) {
    throw new Error(`thread cwd mismatch: expected ${absoluteCwd}, got ${thread.cwd}`);
  }
  if (thread.name !== name) throw new Error(`thread name mismatch: expected ${JSON.stringify(name)}, got ${JSON.stringify(thread.name)}`);

  return { threadId, thread, bootstrapTurn, initialTurn };
}

function assertSuccess(response, method) {
  if (response?.resultType !== 'success') {
    throw new Error(response?.error || `${method} failed`);
  }
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const options = { _: [] };
  const booleans = new Set(['archived', 'dry-run', 'json']);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (booleans.has(key)) {
      options[key] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function timeoutFrom(options) {
  if (options.timeout == null) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(options.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error('--timeout must be a positive integer');
  return timeout;
}

function textFrom(options) {
  return options.text ?? options._.join(' ');
}

export function buildNewThreadParams(options, cwdDefault = process.cwd()) {
  const cwd = path.resolve(options.cwd ?? cwdDefault);
  const text = textFrom(options);
  if (!text) throw new Error('new requires --text "..." or trailing prompt text');
  return { cwd, text };
}

export function buildStartTurnParams(options) {
  const text = textFrom(options);
  if (!text) throw new Error('send requires --text "..." or trailing prompt text');
  const params = {
    clientUserMessageId: options['client-user-message-id'] ?? randomUUID(),
    input: [{ type: 'text', text, text_elements: [] }],
    attachments: [],
  };
  if (options.cwd) params.cwd = path.resolve(options.cwd);
  if (options.model) params.model = options.model;
  if (options['reasoning-effort']) params.effort = options['reasoning-effort'];
  return params;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function queryState(sql) {
  const databasePath = path.join(codexHome(), 'state_5.sqlite');
  const output = execFileSync('sqlite3', ['-json', databasePath, sql], { encoding: 'utf8' });
  return output.trim() ? JSON.parse(output) : [];
}

function positiveInteger(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('value must be a positive integer');
  return parsed;
}

export function threadDeepLink(conversationId) {
  return `codex://threads/${conversationId}`;
}

export function newThreadDeepLink({ cwd, text }) {
  const url = new URL('codex://threads/new');
  url.searchParams.set('path', path.resolve(cwd));
  url.searchParams.set('prompt', text);
  return url.toString();
}

function openDeepLink(url) {
  execFileSync('/usr/bin/open', [url], { stdio: 'ignore' });
}

function submitAppComposer() {
  execFileSync('/usr/bin/osascript', [
    '-e', 'tell application id "com.openai.codex" to activate',
    '-e', 'delay 4',
    '-e', 'tell application "System Events" to key code 36',
  ], { stdio: 'ignore' });
}

async function waitForNewConversation(previousIds, cwd, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const rows = queryState(`
      SELECT id, cwd, updated_at
      FROM threads
      WHERE cwd = ${sqlString(path.resolve(cwd))}
      ORDER BY updated_at DESC, id DESC
      LIMIT 20
    `);
    const created = rows.find((row) => !previousIds.has(row.id));
    if (created != null) return created;
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error(`Codex App did not create a new conversation for ${path.resolve(cwd)}`);
}

export function transcriptMessages(records) {
  return records.flatMap((record) => {
    const payload = record?.payload;
    if (record?.type !== 'response_item' || payload?.type !== 'message') return [];
    const text = (payload.content ?? [])
      .filter((part) => part?.type === 'input_text' || part?.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('\n');
    return [{ timestamp: record.timestamp ?? null, role: payload.role ?? null, text }];
  });
}

function usage() {
  process.stdout.write(`Usage:
  codex-app status [--socket <path>]
  codex-app list [--cwd <path>] [--limit <n>] [--archived] [--json]
  codex-app read --conversation <id> [--json]
  codex-app recognize --rollout <jsonl> --session-id <id> --cwd <workspace> [--name <name>] [--text <first instruction>] [--dry-run]
  codex-app open --conversation <id> [--dry-run]
  codex-app new --text <prompt> [--cwd <path>] [--dry-run]
  codex-app send --conversation <id> --text <prompt> [--cwd <path>] [--dry-run]
  codex-app stop --conversation <id> [--dry-run]
  codex-app watch [--conversation <id>] [--timeout <ms>]

Environment:
  CODEX_IPC_SOCKET Override automatic socket detection.
`);
}

function requestDescription(method, params, options) {
  return {
    type: 'request',
    method,
    version: methodVersion(method, params),
    params,
    ...(options['target-client'] ? { targetClientId: options['target-client'] } : {}),
  };
}

async function run(argv) {
  const { command, options } = parseArgs(argv);
  if (!command || command === 'help' || command === '--help') {
    usage();
    return;
  }

  if (command === 'status') {
    const socketPath = options.socket ?? findSocketPath();
    const client = new CodexAppClient({ socketPath, timeoutMs: timeoutFrom(options), clientType: 'codex-app-cli-status' });
    await client.connect();
    printJson({ ok: true, socketPath, clientId: client.clientId });
    client.close();
    return;
  }

  if (command === 'list') {
    const limit = positiveInteger(options.limit, 20);
    const filters = [`archived = ${options.archived ? 1 : 0}`];
    if (options.cwd) filters.push(`cwd = ${sqlString(path.resolve(options.cwd))}`);
    const rows = queryState(`
      SELECT id, COALESCE(NULLIF(name, ''), NULLIF(title, ''), 'Untitled') AS title,
             cwd, updated_at, archived
      FROM threads
      WHERE ${filters.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${limit}
    `);
    if (options.json) printJson(rows);
    else for (const row of rows) process.stdout.write(`${row.id}\t${row.cwd}\t${String(row.title).replaceAll('\n', ' ').slice(0, 120)}\n`);
    return;
  }

  if (command === 'read') {
    if (!options.conversation) throw new Error('read requires --conversation <id>');
    const rows = queryState(`SELECT rollout_path FROM threads WHERE id = ${sqlString(options.conversation)} LIMIT 1`);
    const rolloutPath = rows[0]?.rollout_path;
    if (!rolloutPath) throw new Error(`conversation not found: ${options.conversation}`);
    const records = fs.readFileSync(rolloutPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const messages = transcriptMessages(records);
    if (options.json) printJson({ id: options.conversation, rolloutPath, messages });
    else for (const message of messages) process.stdout.write(`${message.role}: ${message.text}\n`);
    return;
  }

  if (command === 'recognize') {
    if (!options.cwd) throw new Error('recognize requires --cwd <workspace>');
    const workspace = path.resolve(options.cwd);
    let workspaceStat;
    try {
      workspaceStat = fs.statSync(workspace);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`workspace does not exist: ${workspace}`);
      throw error;
    }
    if (!workspaceStat.isDirectory()) throw new Error(`workspace is not a directory: ${workspace}`);
    const name = options.name ?? path.basename(workspace);
    if (!name.trim()) throw new Error('recognize requires a non-empty --name');
    const validation = validateRollout(options.rollout, options['session-id']);
    const destination = rolloutDestination(validation);

    if (options['dry-run']) {
      if (fs.existsSync(destination)) throw new Error(`refusing to overwrite existing rollout: ${destination}`);
      printJson({
        ok: true,
        dryRun: true,
        rollout: {
          source: validation.sourcePath,
          destination,
          sessionId: validation.sessionId,
          records: validation.recordCount,
          mode: '0600',
        },
        fork: {
          threadId: validation.sessionId,
          cwd: workspace,
          ephemeral: false,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          threadSource: 'user',
        },
        bootstrapText: options['bootstrap-text'] ?? DEFAULT_BOOTSTRAP_TEXT,
        initialText: textFrom(options) || null,
        name,
      });
      return;
    }

    const installedPath = installRollout(validation);
    const timeoutMs = options.timeout == null ? DEFAULT_TURN_TIMEOUT_MS : timeoutFrom(options);
    const client = new AppServerClient({
      command: options.codex ?? 'codex',
      timeoutMs,
      env: process.env,
    });
    let result;
    try {
      await client.start();
      result = await recognizeSession({
        templateSessionId: validation.sessionId,
        cwd: workspace,
        name,
        bootstrapText: options['bootstrap-text'] ?? DEFAULT_BOOTSTRAP_TEXT,
        initialText: textFrom(options) || null,
        timeoutMs,
        client,
      });
    } finally {
      await client.close();
    }

    const appUrl = threadDeepLink(result.threadId);
    openDeepLink(appUrl);
    printJson({
      ok: true,
      templateSessionId: validation.sessionId,
      installedPath,
      threadId: result.threadId,
      cwd: result.thread.cwd,
      name: result.thread.name,
      bootstrapStatus: result.bootstrapTurn.status,
      initialTurnStatus: result.initialTurn?.status ?? null,
      appUrl,
    });
    return;
  }

  if (command === 'open') {
    if (!options.conversation) throw new Error('open requires --conversation <id>');
    const rows = queryState(`SELECT id FROM threads WHERE id = ${sqlString(options.conversation)} LIMIT 1`);
    if (rows.length === 0) throw new Error(`conversation not found: ${options.conversation}`);
    const url = threadDeepLink(options.conversation);
    if (options['dry-run']) {
      printJson({ ok: true, dryRun: true, url });
      return;
    }
    openDeepLink(url);
    printJson({ ok: true, url });
    return;
  }

  if (command === 'new') {
    const params = buildNewThreadParams(options);
    const url = newThreadDeepLink(params);
    if (options['dry-run']) {
      printJson({
        type: 'app-deep-link-request',
        url,
        submit: 'Return',
      });
      return;
    }
    const previousIds = new Set(queryState('SELECT id FROM threads').map((row) => row.id));
    openDeepLink(url);
    submitAppComposer();
    const created = await waitForNewConversation(
      previousIds,
      params.cwd,
      options.timeout == null ? DEFAULT_PROFILE_LAUNCH_TIMEOUT_MS : timeoutFrom(options),
    );
    printJson({
      resultType: 'success',
      result: { conversationId: created.id },
      url: threadDeepLink(created.id),
      submitted: true,
    });
    return;
  }

  if (command === 'send') {
    if (!options.conversation) throw new Error('send requires --conversation <id>');
    const params = {
      conversationId: options.conversation,
      turnStartParams: buildStartTurnParams(options),
    };
    if (options['dry-run']) {
      printJson(requestDescription('thread-follower-start-turn', params, options));
      return;
    }
    const client = new CodexAppClient({
      socketPath: options.socket ?? findSocketPath(),
      timeoutMs: timeoutFrom(options),
      clientType: 'codex-app-cli-send',
    });
    openDeepLink(threadDeepLink(options.conversation));
    await delay(750);
    await client.connect();
    try {
      const response = await requestWhenHandlerReady(client, 'thread-follower-start-turn', params, {
        targetClientId: options['target-client'],
        readinessTimeoutMs: options.timeout == null ? DEFAULT_PROFILE_LAUNCH_TIMEOUT_MS : timeoutFrom(options),
        requestTimeoutMs: options.timeout == null ? DEFAULT_TURN_TIMEOUT_MS : timeoutFrom(options),
      });
      printJson(response);
      assertSuccess(response, 'thread-follower-start-turn');
    } finally {
      client.close();
    }
    return;
  }

  if (command === 'stop') {
    if (!options.conversation) throw new Error('stop requires --conversation <id>');
    const params = { conversationId: options.conversation };
    if (options['dry-run']) {
      printJson(requestDescription('thread-follower-interrupt-turn', params, options));
      return;
    }
    const client = new CodexAppClient({
      socketPath: options.socket ?? findSocketPath(),
      timeoutMs: timeoutFrom(options),
      clientType: 'codex-app-cli-stop',
    });
    openDeepLink(threadDeepLink(options.conversation));
    await delay(750);
    await client.connect();
    try {
      const response = await requestWhenHandlerReady(client, 'thread-follower-interrupt-turn', params, {
        targetClientId: options['target-client'],
        readinessTimeoutMs: options.timeout == null ? DEFAULT_PROFILE_LAUNCH_TIMEOUT_MS : timeoutFrom(options),
        requestTimeoutMs: options.timeout == null ? DEFAULT_TURN_TIMEOUT_MS : timeoutFrom(options),
      });
      printJson(response);
      assertSuccess(response, 'thread-follower-interrupt-turn');
    } finally {
      client.close();
    }
    return;
  }

  if (command === 'watch') {
    const client = new CodexAppClient({
      socketPath: options.socket ?? findSocketPath(),
      timeoutMs: timeoutFrom(options),
      clientType: 'codex-app-cli-watch',
    });
    await client.connect();
    client.onMessage((message) => {
      if (options.conversation && message.params?.conversationId !== options.conversation) return;
      printJson(message);
    });
    const close = () => client.close();
    process.once('SIGINT', close);
    if (options.timeout) setTimeout(close, timeoutFrom(options));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

const isMain = process.argv[1]
  && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
if (isMain) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
