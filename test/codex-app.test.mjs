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
  activateProfileForNewConversation,
  buildNewThreadParams,
  buildStartTurnParams,
  buildFollowerStartTurnParams,
  buildThreadSettings,
  createSession,
  encodeFrame,
  ensureSettingsRuntime,
  finalizeProfileForNewConversation,
  findSocketPath,
  installRollout,
  interruptParams,
  lastAssistantMessageForTurn,
  newConversationCreationTimeout,
  recognizeSession,
  renameThread,
  resolveFollowerTurnOptions,
  rolloutDestination,
  selectNewConversationTransferProfile,
  selectedTranscriptMessages,
  serviceTierFromFast,
  subscribeToRolloutChanges,
  transcriptMessages,
  turnStatus,
  validateRollout,
  waitForTurnCompletion,
  waitForNextTurnResult,
  waitForTurnResult,
  waitForAppIpcReady,
  waitForNewConversation,
} from '../bin/codex-app.mjs';

test('stop targets the exact active turn when one is recorded', () => {
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'active-turn' } },
  ];
  assert.deepEqual(interruptParams('thread-id', records), {
    conversationId: 'thread-id',
    expectedTurnId: 'active-turn',
  });
  assert.deepEqual(interruptParams('thread-id', [
    ...records,
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'active-turn' } },
  ]), { conversationId: 'thread-id' });
});

test('rollout completion watches both the file and its directory', () => {
  const registrations = [];
  let inspections = 0;
  const unsubscribe = subscribeToRolloutChanges('/tmp/sessions/rollout.jsonl', () => {
    inspections += 1;
  }, (target, options, callback) => {
    const watcher = { closed: false, close() { this.closed = true; } };
    registrations.push({ target, options, callback, watcher });
    return watcher;
  });

  assert.deepEqual(registrations.map(({ target }) => target), [
    '/tmp/sessions/rollout.jsonl',
    '/tmp/sessions',
  ]);
  registrations[0].callback('change', 'rollout.jsonl');
  registrations[1].callback('change', 'other.jsonl');
  registrations[1].callback('change', 'rollout.jsonl');
  assert.equal(inspections, 2);
  unsubscribe();
  assert.equal(registrations.every(({ watcher }) => watcher.closed), true);
});

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
  assert.match(output, /codex-app rename/);
  assert.match(output, /codex-app profile/);
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
  assert.equal(received[1].version, 2);
});

test('waits through transient profile restart IPC failures', async () => {
  let attempts = 0;
  const result = await waitForAppIpcReady({
    timeoutMs: 100,
    retryMs: 1,
    createClient: () => ({
      socketPath: '/tmp/test-ipc.sock',
      clientId: 'ready-client',
      async connect() {
        attempts += 1;
        if (attempts < 3) throw new Error('connect ECONNREFUSED');
      },
      close() {},
    }),
  });
  assert.equal(attempts, 3);
  assert.deepEqual(result, {
    socketPath: '/tmp/test-ipc.sock',
    clientId: 'ready-client',
  });
});

test('activates the requested profile before creating a new conversation', async () => {
  const calls = [];
  const result = await activateProfileForNewConversation('chrome:Work', {
    options: { timeout: '1234' },
    restartProfile: (from) => {
      calls.push(['restart', from]);
      return { status: 'running', seedProfile: 'codex-browser-chrome-import-seed' };
    },
    waitForIpc: async (options) => {
      calls.push(['waitForIpc', options]);
      return { socketPath: '/tmp/ipc.sock', clientId: 'desktop-client' };
    },
  });
  assert.deepEqual(calls, [
    ['restart', 'chrome:Work'],
    ['waitForIpc', { timeoutMs: 1234 }],
  ]);
  assert.equal(result.from, 'chrome:Work');
  assert.equal(result.runtime.seedProfile, 'codex-browser-chrome-import-seed');
});

test('reuses an active settings runtime when no profile override is requested', async () => {
  let activations = 0;
  const result = await ensureSettingsRuntime(null, {
    status: () => ({ runtimeActive: true, pids: [123] }),
    activate: async () => { activations += 1; },
  });
  assert.equal(activations, 0);
  assert.equal(result.restarted, false);
});

test('starts the settings runtime with the requested profile when needed', async () => {
  const profiles = [];
  const result = await ensureSettingsRuntime('chrome:Profile 11', {
    status: () => ({ runtimeActive: false }),
    activate: async (profile) => {
      profiles.push(profile);
      return { from: profile, runtime: { seedProfile: 'imported-profile' } };
    },
  });
  assert.deepEqual(profiles, ['chrome:Profile 11']);
  assert.equal(result.restarted, true);
  assert.equal(result.runtime.seedProfile, 'imported-profile');
});

test('new profile dry-run describes profile assignment without restarting the App', () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve('bin/codex-app.mjs'), 'new', '--text', 'test', '--profile', 'chrome:Work', '--dry-run'],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(output);
  assert.deepEqual(result.profile, {
    from: 'chrome:Work',
    action: 'restart-and-assign-before-return',
  });
});

test('selects the one temporary profile created for the new conversation', () => {
  const original = 'codex-browser-source';
  const existing = 'codex-browser-client-new-thread%253aexisting';
  const created = 'codex-browser-client-new-thread%253acreated';
  assert.equal(selectNewConversationTransferProfile({
    beforeProfiles: [original, existing],
    afterProfiles: [original, existing, created],
    fallbackProfile: original,
  }), created);
  assert.equal(selectNewConversationTransferProfile({
    beforeProfiles: [original],
    afterProfiles: [original],
    fallbackProfile: original,
  }), original);
  assert.throws(() => selectNewConversationTransferProfile({
    beforeProfiles: [],
    afterProfiles: [
      'codex-browser-client-new-thread%253aone',
      'codex-browser-client-new-thread%253atwo',
    ],
    fallbackProfile: original,
  }), /multiple temporary browser profiles/);
});

test('finalizes the temporary profile only after stopping the App and reopens the conversation', async () => {
  const calls = [];
  const conversationId = '01900000-0000-7000-8000-0000000000a1';
  const result = await finalizeProfileForNewConversation({
    conversationId,
    sourceProfile: 'codex-browser-client-new-thread%253acreated',
    options: { timeout: '4321' },
    restartProfile: (from, target) => {
      calls.push(['restart', from, target]);
      return {
        seededProfiles: [{
          threadId: target,
          profile: `codex-browser-${target}`,
          source: from,
          reused: false,
          backup: null,
        }],
      };
    },
    waitForIpc: async (options) => {
      calls.push(['waitForIpc', options]);
      return { clientId: 'desktop-client' };
    },
    openConversation: (target) => calls.push(['open', target]),
  });
  assert.deepEqual(calls, [
    ['restart', 'codex-browser-client-new-thread%253acreated', conversationId],
    ['waitForIpc', { timeoutMs: 4321 }],
    ['open', conversationId],
  ]);
  assert.equal(result.assignedProfile.profile, `codex-browser-${conversationId}`);
});

test('allows profile-backed creation enough time for the App restart', () => {
  assert.equal(newConversationCreationTimeout({}, false), 20_000);
  assert.equal(newConversationCreationTimeout({}, true), 300_000);
  assert.equal(newConversationCreationTimeout({ timeout: '1234' }, true), 1234);
});

test('retries composer submission only until the new conversation appears', async () => {
  let clock = 0;
  let queries = 0;
  let retries = 0;
  const created = await waitForNewConversation(
    new Set(['existing']),
    '/tmp/project',
    100,
    {
      now: () => clock,
      pollMs: 5,
      retryAfterMs: 10,
      delayImpl: async (milliseconds) => { clock += milliseconds; },
      queryRows: () => {
        queries += 1;
        return queries < 4 ? [{ id: 'existing' }] : [{ id: 'created' }];
      },
      retrySubmit: () => { retries += 1; },
    },
  );
  assert.equal(created.id, 'created');
  assert.equal(retries, 1);
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
  assert.deepEqual(buildStartTurnParams({
    text: 'add a regression test',
    cwd: '/tmp/project',
    'client-user-message-id': 'message-1',
  }), {
    clientUserMessageId: 'message-1',
    input: [{ type: 'text', text: 'add a regression test', text_elements: [] }],
    attachments: [],
    cwd: '/tmp/project',
  });
});

test('maps explicit fast mode values to service tiers', () => {
  assert.equal(serviceTierFromFast(undefined), undefined);
  assert.equal(serviceTierFromFast('on'), 'priority');
  assert.equal(serviceTierFromFast('off'), null);
  assert.throws(() => serviceTierFromFast('yes'), /--fast must be on or off/);

  assert.equal(buildStartTurnParams({ text: 'fast', fast: 'on' }).serviceTier, 'priority');
  assert.equal(buildStartTurnParams({ text: 'standard', fast: 'off' }).serviceTier, null);
  assert.equal('serviceTier' in buildStartTurnParams({ text: 'unchanged' }), false);
});

test('uses the current App follower start-turn payload key', () => {
  const params = buildFollowerStartTurnParams('thread-1', { text: 'continue' });
  assert.equal(params.conversationId, 'thread-1');
  assert.equal(params.turnStart.request.threadId, 'thread-1');
  assert.equal(params.turnStart.request.input[0].text, 'continue');
  assert.deepEqual(params.turnStart.context, {
    attachments: [],
    commentAttachments: [],
    inheritThreadSettings: true,
    useAppServerPermissionDefault: false,
    usePermissionSelection: false,
    mcpAppModelContextAttachments: [],
  });
  assert.equal('turnStartParams' in params, false);
});

test('defaults follower turns to the supported Luna model at max effort', () => {
  assert.deepEqual(resolveFollowerTurnOptions({ text: 'continue' }), {
    text: 'continue',
    model: 'gpt-5.6-luna',
    'reasoning-effort': 'max',
  });
  assert.deepEqual(resolveFollowerTurnOptions({
    text: 'continue',
    model: 'custom-model',
    'reasoning-effort': 'low',
  }), {
    text: 'continue',
    model: 'custom-model',
    'reasoning-effort': 'low',
  });
  assert.deepEqual(resolveFollowerTurnOptions({
    text: 'change only fast mode',
    fast: 'off',
  }), {
    text: 'change only fast mode',
    fast: 'off',
  });
});

test('generates one idempotency key for each follow-up turn request', () => {
  const params = buildStartTurnParams({ text: 'send once' });
  assert.match(params.clientUserMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('builds persistent thread settings for model, reasoning, and fast overrides', () => {
  assert.deepEqual(buildThreadSettings({
    model: 'gpt-5.6-luna',
    'reasoning-effort': 'max',
    fast: 'on',
  }), {
    model: 'gpt-5.6-luna',
    effort: 'max',
    serviceTier: 'priority',
    collaborationMode: {
      mode: 'default',
      settings: {
        model: 'gpt-5.6-luna',
        reasoning_effort: 'max',
        developer_instructions: null,
      },
    },
  });
  assert.deepEqual(buildThreadSettings({ fast: 'off' }), { serviceTier: null });
  assert.equal(buildThreadSettings({ text: 'no override' }), null);
});

test('reports the latest turn lifecycle status', () => {
  const records = [
    { timestamp: 'one', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: 'two', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    { timestamp: 'three', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { timestamp: 'four', type: 'event_msg', payload: { type: 'token_count' } },
  ];
  assert.deepEqual(turnStatus(records), {
    status: 'inProgress',
    turnId: 'turn-2',
    updatedAt: 'three',
  });
  assert.deepEqual(turnStatus(records.slice(0, 2)), {
    status: 'completed',
    turnId: 'turn-1',
    updatedAt: 'two',
  });
  assert.deepEqual(turnStatus([
    ...records,
    { timestamp: 'five', type: 'event_msg', payload: { type: 'turn_aborted' } },
  ]), {
    status: 'aborted',
    turnId: 'turn-2',
    updatedAt: 'five',
  });
  assert.deepEqual(turnStatus([]), {
    status: 'idle',
    turnId: null,
    updatedAt: null,
  });
});

test('renames a thread and verifies the persisted name', async () => {
  const requests = [];
  const client = {
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'thread/name/set') return {};
      return { thread: { id: 'thread-1', name: 'New chat name' } };
    },
  };
  const thread = await renameThread(client, 'thread-1', 'New chat name');
  assert.equal(thread.name, 'New chat name');
  assert.deepEqual(requests, [
    { method: 'thread/name/set', params: { threadId: 'thread-1', name: 'New chat name' } },
    { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: false } },
  ]);
});

test('extracts user and assistant transcript messages', () => {
  const records = [
    { type: 'event_msg', payload: { type: 'token_count' } },
    { timestamp: 'one', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
    { timestamp: 'two', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'test' }] } },
  ];
  assert.deepEqual(transcriptMessages(records), [
    { timestamp: 'one', role: 'user', text: 'hello' },
    { timestamp: 'two', role: 'assistant', text: 'test' },
  ]);
  assert.deepEqual(selectedTranscriptMessages(records), [
    { timestamp: 'two', role: 'assistant', text: 'test' },
  ]);
  assert.deepEqual(selectedTranscriptMessages(records, true), transcriptMessages(records));
});

test('waits for a matching completed turn and returns its final assistant message', async () => {
  const records = [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old' }], internal_chat_message_metadata_passthrough: { turn_id: 'old-turn' } } },
    { timestamp: 'one', type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } },
    { timestamp: 'two', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'progress' }], internal_chat_message_metadata_passthrough: { turn_id: 'new-turn' } } },
    { timestamp: 'three', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final' }], internal_chat_message_metadata_passthrough: { turn_id: 'new-turn' } } },
    { timestamp: 'four', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'new-turn' } },
  ];
  assert.equal(lastAssistantMessageForTurn(records, 'new-turn').text, 'final');
  assert.deepEqual(await waitForTurnCompletion({ readRecords: () => records, afterRecordCount: 1, timeoutMs: 100, pollMs: 1 }), {
    status: 'completed', turnId: 'new-turn', completedAt: 'four',
    message: { timestamp: 'three', role: 'assistant', text: 'final' },
  });
});

test('rejects an aborted relayed turn', async () => {
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } },
    { type: 'event_msg', payload: { type: 'turn_aborted' } },
  ];
  await assert.rejects(waitForTurnCompletion({ readRecords: () => records, afterRecordCount: 0, timeoutMs: 100, pollMs: 1 }), /turn aborted: new-turn/);
});

test('waits for an already-running turn returned by the App IPC response', async () => {
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'active-turn' } },
    { timestamp: 'two', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final' }], internal_chat_message_metadata_passthrough: { turn_id: 'active-turn' } } },
    { timestamp: 'three', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'active-turn' } },
  ];
  const completion = await waitForTurnCompletion({ readRecords: () => records, afterRecordCount: 1, expectedTurnId: 'active-turn', timeoutMs: 100, pollMs: 1 });
  assert.equal(completion.turnId, 'active-turn');
  assert.equal(completion.message.text, 'final');
});

test('waits for an exact turn using change notifications and returns its final result', async () => {
  const records = [];
  let notify;
  let unsubscribed = false;
  const completion = waitForTurnResult({
    readRecords: () => records,
    subscribe: (callback) => {
      notify = callback;
      return () => { unsubscribed = true; };
    },
    expectedTurnId: 'target-turn',
    timeoutMs: 100,
  });
  records.push(
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'other-turn' } },
    { timestamp: 'final-message', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }], internal_chat_message_metadata_passthrough: { turn_id: 'target-turn' } } },
    { timestamp: 'completed', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'target-turn' } },
  );
  notify();
  assert.deepEqual(await completion, {
    status: 'completed',
    turnId: 'target-turn',
    completedAt: 'completed',
    message: { timestamp: 'final-message', role: 'assistant', text: 'done' },
  });
  assert.equal(unsubscribed, true);
});

test('watch waits for the next turn and emits only its final result', async () => {
  const records = [{ ordinal: 0, type: 'session_meta', payload: {} }];
  let notify;
  const completion = waitForNextTurnResult({
    readRecords: () => records,
    subscribe: (callback) => {
      notify = callback;
      return () => {};
    },
    afterRecordCount: records.length,
    timeoutMs: 100,
  });
  records.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next-turn' } });
  notify();
  records.push(
    { timestamp: 'final-message', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }], internal_chat_message_metadata_passthrough: { turn_id: 'next-turn' } } },
    { timestamp: 'completed', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'next-turn' } },
  );
  notify();
  assert.deepEqual(await completion, {
    status: 'completed',
    turnId: 'next-turn',
    completedAt: 'completed',
    message: { timestamp: 'final-message', role: 'assistant', text: 'done' },
  });
});

test('wait reports an exact aborted turn', async () => {
  const records = [{ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'target-turn' } }];
  await assert.rejects(waitForTurnResult({
    readRecords: () => records,
    subscribe: () => () => {},
    expectedTurnId: 'target-turn',
    timeoutMs: 100,
  }), /turn aborted: target-turn/);
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

test('accepts a contiguous fork page with a nonzero first ordinal already in the session store', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-cli-rollout-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionId = '01900000-0000-7000-8000-000000000002';
  const home = path.join(directory, 'codex-home');
  const sessionDirectory = path.join(home, 'sessions', '2026', '08', '12');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const source = writeRollout(sessionDirectory, sessionId, [
    { ordinal: 2343, type: 'session_meta', payload: { id: sessionId, session_id: sessionId } },
    { ordinal: 2344, type: 'event_msg', payload: {} },
  ]);

  const validation = validateRollout(source, sessionId);
  assert.equal(validation.firstOrdinal, 2343);
  assert.equal(installRollout(validation, home), source);
  assert.equal(fs.existsSync(source), true);
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
    { ordinal: 4, type: 'session_meta', payload: { id: sessionId, session_id: sessionId } },
    { ordinal: 7, type: 'event_msg', payload: {} },
  ]);
  assert.throws(() => validateRollout(ordinalPath, sessionId), /must have ordinal 5/);
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
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
    serviceTier: 'priority',
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
    model: 'gpt-5.6-luna',
    config: { model_reasoning_effort: 'max' },
    serviceTier: 'priority',
  });
  assert.equal(calls[1].params.input[0].text, 'bootstrap');
  assert.equal(calls[1].params.model, 'gpt-5.6-luna');
  assert.equal(calls[1].params.effort, 'max');
  assert.equal(calls[1].params.serviceTier, 'priority');
  assert.equal(calls[2].params.input[0].text, 'first instruction');
  assert.equal(calls[2].params.model, undefined);
  assert.equal(calls[2].params.effort, undefined);
  assert.deepEqual(calls[3].params, { threadId: 'child-thread', name: 'Imported project context' });
  assert.deepEqual(calls[4].params, { threadId: 'child-thread', includeTurns: true });
});

test('creates a new session with model and effort on its first turn', async () => {
  const calls = [];
  let completed;
  const client = {
    waitForNotification(method, predicate) {
      assert.equal(method, 'turn/completed');
      return new Promise((resolve) => { completed = { predicate, resolve }; });
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'new-thread' } };
      if (method === 'turn/start') {
        const turn = { id: 'turn-1', status: 'completed' };
        queueMicrotask(() => {
          const notification = { threadId: 'new-thread', turn };
          assert.equal(completed.predicate(notification), true);
          completed.resolve(notification);
        });
        return { turn };
      }
      if (method === 'thread/read') return { thread: { id: 'new-thread', cwd: '/tmp/sample-project' } };
      throw new Error(`unexpected method: ${method}`);
    },
  };

  const result = await createSession({
    cwd: '/tmp/sample-project',
    text: 'first prompt',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
    serviceTier: null,
    timeoutMs: 1_000,
    client,
  });

  assert.equal(result.threadId, 'new-thread');
  assert.deepEqual(calls, [
    {
      method: 'thread/start',
      params: {
        cwd: '/tmp/sample-project',
        ephemeral: false,
        threadSource: 'user',
        model: 'gpt-5.6-luna',
        config: { model_reasoning_effort: 'max' },
        serviceTier: null,
      },
    },
    {
      method: 'turn/start',
      params: {
        threadId: 'new-thread',
        cwd: '/tmp/sample-project',
        input: [{ type: 'text', text: 'first prompt' }],
        model: 'gpt-5.6-luna',
        effort: 'max',
        serviceTier: null,
      },
    },
    { method: 'thread/read', params: { threadId: 'new-thread', includeTurns: true } },
  ]);
});
