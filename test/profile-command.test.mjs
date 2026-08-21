import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { seedBrowserProfiles } from '../iab/lib/profile-storage.mjs';
import {
  profileUsage,
  runProfileCommand,
} from '../lib/profile-command.mjs';

test('documents the integrated profile command surface', () => {
  assert.match(profileUsage(), /codex-app profile chrome-list/);
  assert.match(profileUsage(), /chrome:Profile 1/);
  assert.doesNotMatch(profileUsage(), /--conversation|--thread|--replace/);
});

test('lists embedded Codex browser profiles without spawning codex-iab-profile', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-profile-list-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'codex-browser-app'));
  fs.mkdirSync(path.join(root, 'codex-browser-thread-a'));

  assert.deepEqual(runProfileCommand('list', {}, {
    CODEX_IAB_PARTITIONS_PATH: root,
  }), ['codex-browser-app', 'codex-browser-thread-a']);
});

test('lists Chrome profile selectors through the integrated CLI', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-chrome-list-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Profile 1'));
  fs.writeFileSync(
    path.join(root, 'Local State'),
    JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Work' } } } }),
  );

  const output = execFileSync(
    process.execPath,
    [path.resolve('bin/codex-app.mjs'), 'profile', 'chrome-list'],
    {
      encoding: 'utf8',
      env: { ...process.env, CODEX_IAB_CHROME_ROOT: root },
    },
  );
  assert.deepEqual(JSON.parse(output), [{
    source: 'chrome:Profile 1',
    name: 'Work',
    directory: 'Profile 1',
    hasCookies: false,
    hasPasswords: false,
    hasHistory: false,
  }]);
});

test('rejects attempts to change an existing session profile', () => {
  for (const options of [
    { conversation: 'thread-a' },
    { thread: 'thread-a' },
    { replace: true },
  ]) {
    assert.throws(
      () => runProfileCommand('restart', options, {}),
      /cannot change the Browser profile of an existing session/,
    );
  }

  const result = spawnSync(process.execPath, [
    path.resolve('bin/codex-app.mjs'),
    'profile',
    'restart',
    '--from',
    'default',
    '--conversation',
    '01900000-0000-7000-8000-000000000001',
    '--replace',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot change the Browser profile of an existing session/);
});

test('preserves initial-turn writes while isolating two same-source sessions and one other-source session', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-multi-profile-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceA = 'codex-browser-source-a';
  const sourceB = 'codex-browser-source-b';
  fs.mkdirSync(path.join(root, sourceA));
  fs.mkdirSync(path.join(root, sourceB));
  fs.writeFileSync(path.join(root, sourceA, 'Cookies'), 'profile-a');
  fs.writeFileSync(path.join(root, sourceB, 'Cookies'), 'profile-b');
  const temporaryA = 'codex-browser-client-new-thread%253atemporary-a';
  const temporaryB = 'codex-browser-client-new-thread%253atemporary-b';
  const temporaryC = 'codex-browser-client-new-thread%253atemporary-c';
  fs.cpSync(path.join(root, sourceA), path.join(root, temporaryA), { recursive: true });
  fs.cpSync(path.join(root, sourceA), path.join(root, temporaryB), { recursive: true });
  fs.cpSync(path.join(root, sourceB), path.join(root, temporaryC), { recursive: true });
  fs.writeFileSync(path.join(root, temporaryA, 'Cookies'), 'session-a-only');
  fs.writeFileSync(path.join(root, temporaryB, 'Cookies'), 'session-b-only');
  fs.writeFileSync(path.join(root, temporaryC, 'Cookies'), 'session-c-only');
  const conversationA = '01900000-0000-7000-8000-0000000000a1';
  const conversationB = '01900000-0000-7000-8000-0000000000b2';
  const conversationC = '01900000-0000-7000-8000-0000000000c3';

  const assignedA = seedBrowserProfiles({
    from: temporaryA,
    threadIds: [conversationA],
    partitionsPath: root,
  })[0];
  const assignedB = seedBrowserProfiles({
    from: temporaryB,
    threadIds: [conversationB],
    partitionsPath: root,
  })[0];
  const assignedC = seedBrowserProfiles({
    from: temporaryC,
    threadIds: [conversationC],
    partitionsPath: root,
  })[0];

  assert.equal(assignedA.source, temporaryA);
  assert.equal(assignedB.source, temporaryB);
  assert.equal(assignedC.source, temporaryC);
  assert.notEqual(assignedA.profile, assignedB.profile);
  assert.notEqual(assignedB.profile, assignedC.profile);
  const cookiesA = path.join(root, assignedA.profile, 'Cookies');
  const cookiesB = path.join(root, assignedB.profile, 'Cookies');
  const cookiesC = path.join(root, assignedC.profile, 'Cookies');
  assert.equal(fs.readFileSync(cookiesA, 'utf8'), 'session-a-only');
  assert.equal(fs.readFileSync(cookiesB, 'utf8'), 'session-b-only');
  assert.equal(fs.readFileSync(cookiesC, 'utf8'), 'session-c-only');
  assert.notEqual(fs.statSync(cookiesA).ino, fs.statSync(cookiesB).ino);

  fs.writeFileSync(cookiesA, 'session-a-follow-up');
  assert.equal(fs.readFileSync(cookiesA, 'utf8'), 'session-a-follow-up');
  assert.equal(fs.readFileSync(cookiesB, 'utf8'), 'session-b-only');
  assert.equal(fs.readFileSync(cookiesC, 'utf8'), 'session-c-only');
});
