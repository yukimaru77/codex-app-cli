import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AppServerClient,
  CodexAppClient,
  FrameDecoder,
  buildNewThreadParams,
  buildStartTurnParams,
  encodeFrame,
  findSocketPath,
  installRollout,
  recognizeSession,
  rolloutDestination,
  transcriptMessages,
  validateRollout,
} from '../bin/codex-app.mjs';

function writeRollout(directory, sessionId, records = null) {
  const filename = `rollout-2026-08-12T10-20-30-${sessionId}.jsonl`;
  const rolloutPath = path.join(directory, filename);
  const values = records ?? [
    { ordinal: 0, type: 'session_meta', payload: { id: sessionId, session_id: sessionId } },
    { ordinal: 1, type: 'response_item', payload: { type: 'message' } },
  ];
  fs.writeFileSync(rolloutPath, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`);
  return rolloutPath;
}

test('frame decoder handles split and combined frames', () => {
  const messages = [];
  const decoder = new FrameDecoder((message) => messages.push(message));
  const bytes = Buffer.concat([encodeFrame({ one: 1 }), encodeFrame({ two: 2 })]);
  decoder.push(bytes.subarray(0, 3));
  decoder.push(bytes.subarray(3, 9));
  decoder.push(bytes.subarray(9));
  assert.deepEqual(messages, [{ one: 1 }, { two: 2 }]);
});

test('CLI runs when invoked through an installed symlink', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-cli-link-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const link = path.join(directory, 'codex-app');
  fs.symlinkSync(path.resolve('bin/codex-app.mjs'), link);
  const output = execFileSync(link, ['help'], { encoding: 'utf8' });
  assert.match(output, /codex-app recognize/);
});

test('socket override must point to a Unix socket', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-cli-'));
  const socketPath = path.join(directory, 'ipc.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));
  context.after(() => {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(findSocketPath({ env: { CODEX_IPC_SOCKET: socketPath } }), socketPath);
});

test('client initializes and sends a versioned request over IPC', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-cli-'));
  const socketPath = path.join(directory, 'ipc.sock');
  const received = [];
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder((message) => {
      received.push(message);
      const result = message.method === 'initialize' ? { clientId: 'test-client' } : { accepted: true };
      socket.write(encodeFrame({
        type: 'response',
        requestId: message.requestId,
        resultType: 'success',
        result,
      }));
    });
    socket.on('data', (chunk) => decoder.push(chunk));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  context.after(() => {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const client = new CodexAppClient({ socketPath, timeoutMs: 1_000 });
  await client.connect();
  const response = await client.request('thread-follower-start-turn', { conversationId: 'thread-1' });
  client.close();

  assert.equal(client.clientId, 'test-client');
  assert.equal(response.result.accepted, true);
  assert.equal(received[0].method, 'initialize');
  assert.equal('version' in received[0], false);
  assert.equal(received[1].sourceClientId, 'test-client');
  assert.equal(received[1].version, 1);
});

test('builds new-thread deep-link parameters', () => {
  assert.deepEqual(buildNewThreadParams({
    text: 'fix the tests',
    cwd: '/tmp/project',
  }), {
    cwd: '/tmp/project',
    text: 'fix the tests',
  });
});

test('builds follow-up turn parameters', () => {
  assert.deepEqual(buildStartTurnParams({ text: 'add a regression test', cwd: '/tmp/project' }), {
    input: [{ type: 'text', text: 'add a regression test', text_elements: [] }],
    attachments: [],
    cwd: '/tmp/project',
  });
});

test('extracts user and assistant transcript messages', () => {
  assert.deepEqual(transcriptMessages([
    { type: 'event_msg', payload: { type: 'token_count' } },
    { timestamp: 'one', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
    { timestamp: 'two', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'test' }] } },
  ]), [
    { timestamp: 'one', role: 'user', text: 'hello' },
    { timestamp: 'two', role: 'assistant', text: 'test' },
  ]);
});

test('validates and installs a paginated rollout without overwriting', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-cli-rollout-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionId = '01900000-0000-7000-8000-000000000001';
  const validation = validateRollout(writeRollout(directory, sessionId), sessionId);
  const home = path.join(directory, 'codex-home');
  const expected = path.join(home, 'sessions', '2026', '08', '12', validation.filename);

  assert.equal(rolloutDestination(validation, home), expected);
  assert.equal(installRollout(validation, home), expected);
  assert.equal(fs.statSync(expected).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(expected, 'utf8'), validation.content);
  assert.throws(() => installRollout(validation, home), /refusing to overwrite existing rollout/);
});

test('rejects rollout identity and ordinal mismatches', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-cli-rollout-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionId = '01900000-0000-7000-8000-000000000001';
  const wrongIdentity = writeRollout(directory, sessionId, [
    { ordinal: 0, type: 'session_meta', payload: { id: sessionId, session_id: 'wrong' } },
  ]);
  assert.throws(() => validateRollout(wrongIdentity, sessionId), /payload\.session_id does not match/);

  const ordinalPath = writeRollout(directory, sessionId, [
    { ordinal: 0, type: 'session_meta', payload: { id: sessionId, session_id: sessionId } },
    { ordinal: 3, type: 'event_msg', payload: {} },
  ]);
  assert.throws(() => validateRollout(ordinalPath, sessionId), /must have ordinal 1/);
});

test('app-server client performs JSONL handshake, requests, notifications, and errors', async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-support', 'fake-app-server.mjs');
  const client = new AppServerClient({ command: process.execPath, args: [fixture], timeoutMs: 1_000 });
  await client.start();
  try {
    const notification = client.waitForNotification('test/notification');
    const result = await client.request('thread/read', { threadId: 'child' });
    assert.deepEqual(result, { method: 'thread/read', params: { threadId: 'child' } });
    assert.deepEqual(await notification, { value: 42 });
    await assert.rejects(client.request('test/error'), /expected failure/);
  } finally {
    await client.close();
  }
});

test('forks, bootstraps, sends a separate initial turn, names, and verifies the child thread', async () => {
  const calls = [];
  const waiters = [];
  let turnNumber = 0;
  const client = {
    waitForNotification(method, predicate) {
      return new Promise((resolve) => waiters.push({ method, predicate, resolve }));
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/fork') return { thread: { id: 'child-thread' } };
      if (method === 'turn/start') {
        turnNumber += 1;
        const turn = { id: `turn-${turnNumber}`, status: 'completed' };
        queueMicrotask(() => {
          const waiter = waiters.shift();
          const notification = { threadId: 'child-thread', turn };
          assert.equal(waiter.method, 'turn/completed');
          assert.equal(waiter.predicate(notification), true);
          waiter.resolve(notification);
        });
        return { turn };
      }
      if (method === 'thread/name/set') return {};
      if (method === 'thread/read') {
        return { thread: { id: 'child-thread', cwd: '/tmp/sample-project', name: 'Imported project context' } };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };

  const result = await recognizeSession({
    templateSessionId: 'template-thread',
    cwd: '/tmp/sample-project',
    name: 'Imported project context',
    bootstrapText: 'bootstrap',
    initialText: 'first instruction',
    timeoutMs: 1_000,
    client,
  });

  assert.equal(result.threadId, 'child-thread');
  assert.deepEqual(calls.map((call) => call.method), [
    'thread/fork',
    'turn/start',
    'turn/start',
    'thread/name/set',
    'thread/read',
  ]);
  assert.deepEqual(calls[0].params, {
    threadId: 'template-thread',
    cwd: '/tmp/sample-project',
    ephemeral: false,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    threadSource: 'user',
  });
  assert.equal(calls[1].params.input[0].text, 'bootstrap');
  assert.equal(calls[2].params.input[0].text, 'first instruction');
  assert.deepEqual(calls[3].params, { threadId: 'child-thread', name: 'Imported project context' });
  assert.deepEqual(calls[4].params, { threadId: 'child-thread', includeTurns: true });
});
